import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { buildGraphAgentDigest } from "../api";
import { getCachedGraph, invalidateGraph, loadGraph } from "../graph/graphCache";
import {
  createGraphLayoutSnapshot,
  graphFolder,
  type GraphLayoutMode,
  type GraphLayoutRelationKind,
} from "../graph/layout";
import { applySpatialRepulsion } from "../graph/physics";
import { invalidateIndex } from "../knowledge/knowledgeCache";
import type { GraphData, GraphEdge, GraphNode, OpenFile } from "../types";

interface GraphViewProps {
  /** Workspace root to scan; null ⇒ empty state ("open a folder"). */
  rootPath: string | null;
  /** SSH connection id when the graph root is remote. */
  connId?: string | null;
  /** Explicit SSH origin for files opened from this graph root. */
  workspaceRemote?: OpenFile["workspaceRemote"];
  /** Path of the file open in the editor, highlighted in the graph. */
  activePath: string | null;
  /** Click a node ⇒ open that file in the editor. */
  onOpenFile: (path: string, workspaceRemote?: OpenFile["workspaceRemote"]) => void;
}

/** A node with mutable simulation state (position + velocity + appear time). */
interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  deg: number;
  /** Incoming references/imports; Obsidian makes heavily referenced nodes larger. */
  refs: number;
  /** Top-level folder (for the "group by folder" colour/cluster). */
  folder: string;
  /** Connected component inside a folder; used for edge hierarchy. */
  islandKey: string;
  /** Human-readable island/project label derived from the shared path prefix. */
  islandLabel: string;
  /** Organic micro-cell generated from a hub + linked children. */
  cellKey: string;
  cellHubId: string;
  cellRelationKind: GraphLayoutRelationKind;
  cellRadius: number;
  cellCenterX: number;
  cellCenterY: number;
  color: string;
  /** performance.now() when the node first appeared (drives the pop-in anim). */
  t0: number;
  anchorX: number;
  anchorY: number;
  fx?: number;
  fy?: number;
}

interface SimEdge {
  s: SimNode;
  t: SimNode;
  kind: GraphEdge["kind"];
}

interface View {
  x: number;
  y: number;
  k: number;
}

interface GraphContextMenu {
  x: number;
  y: number;
  nodeId: string | null;
  nodeName: string | null;
}

/** Module-level cache of node POSITIONS + viewport (graph DATA lives in the
 *  shared graphCache.ts). Restoring positions makes reopening instant. */
interface PosCache {
  key: string;
  pos: Map<string, { x: number; y: number }>;
  view: View;
}
let posCache: PosCache | null = null;

const APPEAR_MS = 520;
const POS_KEY = "graph.pos:";
const POS_LAYOUT_VERSION = 15;
type GraphVisualAction = "folderColor" | "organic";
const MAX_DRAWN_IDLE_EDGES = 45_000;
const MAX_DRAWN_ACTIVE_EDGES = 18_000;
const MIN_NODE_SCREEN_RADIUS = 2.2;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Whether the OS asks us to minimise non-essential motion (F2-AUD-004). */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Reads a CSS custom property off `el` (fallback when unset). */
function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Top-level folder of a relative path. */
function folderOf(rel: string): string {
  return graphFolder(rel);
}

/** A stable, pleasant colour for a folder name (HSL from a hash). */
const folderColorCache = new Map<string, string>();
function folderColor(folder: string): string {
  const cached = folderColorCache.get(folder);
  if (cached) return cached;
  if (!folder || folder === "Raiz") {
    folderColorCache.set(folder, "#8aa0b4");
    return "#8aa0b4";
  }
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) | 0;
  const color = `hsl(${Math.abs(h) % 360}, 58%, 62%)`;
  folderColorCache.set(folder, color);
  return color;
}

/** Persists positions + viewport across app restarts (best-effort). */
function savePos(c: PosCache) {
  try {
    localStorage.setItem(
      POS_KEY + c.key,
      JSON.stringify({
        version: POS_LAYOUT_VERSION,
        pos: Array.from(c.pos.entries()),
        view: c.view,
      })
    );
  } catch {
    /* storage full/unavailable — ignore */
  }
}
function loadPos(root: string): PosCache | null {
  try {
    const raw = localStorage.getItem(POS_KEY + root);
    if (!raw) return null;
    const o = JSON.parse(raw) as {
      version?: number;
      pos: [string, { x: number; y: number }][];
      view: View;
    };
    if (o.version !== POS_LAYOUT_VERSION) return null;
    return { key: root, pos: new Map(o.pos), view: o.view };
  } catch {
    return null;
  }
}

function graphPosKey(root: string, connId?: string | null): string {
  return `${connId ?? "local"}:${root}`;
}

/**
 * Obsidian-style "context graph" — a force-directed map of the workspace's
 * markdown + source files and the links/imports between them. Pan (drag), zoom
 * (wheel / the ⊕⊖⤢ controls, auto-fit on first open), hover to spotlight a
 * node's neighbours, right-click to FOCUS a node (isolate its neighbourhood),
 * drag a node to reposition, click to open the file. Colour by kind or by
 * folder, keeping the default presentation close to Obsidian's clean graph.
 */
export function GraphView({
  rootPath,
  connId = null,
  workspaceRemote,
  activePath,
  onOpenFile,
}: GraphViewProps) {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [showCells, setShowCells] = useState(true);
  const [showArrows, setShowArrows] = useState(true);
  const [byFolder, setByFolder] = useState(false);
  const [query, setQuery] = useState("");
  const [focusName, setFocusName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<GraphContextMenu | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Accessible textual mirror of the canvas: a keyboard-navigable node list
  // that opens the file (Enter/Space) and centres/spotlights it on the graph
  // when focused — the no-mouse path required by F2-AUD-015.
  const [showList, setShowList] = useState(false);
  const [activeOption, setActiveOption] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const kickRef = useRef<() => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const zoomRef = useRef<(factor: number) => void>(() => {});
  const arrangeRef = useRef<(mode: GraphLayoutMode) => void>(() => {});
  const focusRef = useRef<(nodeId: string | null) => void>(() => {});
  /** Centre + spotlight a node by id (keyboard list → canvas), no file open. */
  const centerNodeRef = useRef<(id: string) => void>(() => {});
  /** Run the simulation to rest synchronously and paint once (reduced motion). */
  const settleStaticRef = useRef<() => void>(() => {});
  /** Live `prefers-reduced-motion` flag, read inside the render/physics loop. */
  const reducedMotionRef = useRef(prefersReducedMotion());

  const sim = useRef<{
    nodes: SimNode[];
    edges: SimEdge[];
    adj: Map<string, Set<string>>;
    alpha: number;
    view: View;
    viewTarget: View | null;
    hovered: string | null;
    focus: string | null;
    focusVisibleIds: Set<string> | null;
    match: Set<string> | null;
    byFolder: boolean;
    showCells: boolean;
    showArrows: boolean;
    edgeCursor: number;
    userAdjusted: boolean;
    needsFit: boolean;
    appearUntil: number;
    raf: number;
    colors: Record<string, string>;
    activePath: string | null;
    /** When true: no decorative animation — static layout, instant fit/zoom. */
    reduced: boolean;
    onOpen: (p: string) => void;
  }>({
    nodes: [],
    edges: [],
    adj: new Map(),
    alpha: 0,
    view: { x: 0, y: 0, k: 1 },
    viewTarget: null,
    hovered: null,
    focus: null,
    focusVisibleIds: null,
    match: null,
    byFolder: false,
    showCells: true,
    showArrows: true,
    edgeCursor: 0,
    userAdjusted: false,
    needsFit: false,
    appearUntil: 0,
    raf: 0,
    colors: {},
    activePath: null,
    reduced: reducedMotionRef.current,
    onOpen: () => {},
  });

  // Fetch (cache-aware): reuse the module cache so reopening is instant.
  useEffect(() => {
    if (!rootPath) {
      setLoading(false);
      setError(null);
      setData(null);
      return;
    }
    const cached = getCachedGraph(rootPath, connId);
    if (cached) {
      setLoading(false);
      setError(null);
      setData(cached);
      return;
    }
    let cancelled = false;
    setData(null);
    setLoading(true);
    setError(null);
    loadGraph(rootPath, connId)
      .then((g) => {
        if (!cancelled) setData(g);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, connId, reloadKey]);

  const openGraphFile = (path: string) => onOpenFile(path, workspaceRemote);

  sim.current.onOpen = openGraphFile;
  sim.current.activePath = activePath;
  sim.current.byFolder = byFolder;
  sim.current.showCells = showCells;
  sim.current.showArrows = showArrows;

  // Keep toolbar clicks/typing feeling instant; the heavier graph rebuild can
  // trail by a frame instead of monopolising the input event.
  const deferredShowCode = useDeferredValue(showCode);
  const deferredShowOrphans = useDeferredValue(showOrphans);
  const deferredQuery = useDeferredValue(query);
  const graphUpdating =
    deferredShowCode !== showCode ||
    deferredShowOrphans !== showOrphans ||
    deferredQuery !== query;

  // Track `prefers-reduced-motion` live: when it flips on we settle the layout
  // statically (no prolonged decorative motion); when it flips off the next
  // rebuild/interaction animates again as before (F2-AUD-004).
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reducedMotionRef.current = mq.matches;
      sim.current.reduced = mq.matches;
      if (mq.matches) settleStaticRef.current();
      kickRef.current();
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Degrees + filtered view (drives the toolbar counts + the simulation).
  const filtered = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const byKind = data.nodes.filter((n) => deferredShowCode || n.kind !== "code");
    const allow = new Set(byKind.map((n) => n.id));
    let edges = data.edges.filter((e) => allow.has(e.source) && allow.has(e.target));
    let nodes = byKind;
    if (!deferredShowOrphans) {
      const deg = new Map<string, number>();
      for (const e of edges) {
        deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
        deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
      }
      nodes = nodes.filter((n) => (deg.get(n.id) ?? 0) > 0);
      const visible = new Set(nodes.map((n) => n.id));
      edges = edges.filter((e) => visible.has(e.source) && visible.has(e.target));
    }
    return { nodes, edges };
  }, [data, deferredShowCode, deferredShowOrphans]);

  const matchSet = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return null;
    const s = new Set<string>();
    for (const n of filtered.nodes) {
      if (n.name.toLowerCase().includes(q) || n.rel.toLowerCase().includes(q)) s.add(n.id);
    }
    return s;
  }, [deferredQuery, filtered]);
  sim.current.match = matchSet;
  useEffect(() => {
    kickRef.current();
  }, [matchSet]);

  // Obsidian-style groups are spatial first: hubs pull their neighbours into
  // invisible clusters, while links remain the only visible structure.

  // Accessible node list (F2-AUD-015): textual mirror of the canvas. Honours
  // filters/search and prioritises highly connected files for faster scanning.
  const nodeStats = useMemo(() => {
    const stats = new Map<string, { incoming: number; outgoing: number; degree: number }>();
    for (const node of filtered.nodes) stats.set(node.id, { incoming: 0, outgoing: 0, degree: 0 });
    for (const edge of filtered.edges) {
      const source = stats.get(edge.source);
      if (source) {
        source.outgoing++;
        source.degree++;
      }
      const target = stats.get(edge.target);
      if (target) {
        target.incoming++;
        target.degree++;
      }
    }
    return stats;
  }, [filtered]);

  const listNodes = useMemo(() => {
    const ns = matchSet ? filtered.nodes.filter((n) => matchSet.has(n.id)) : filtered.nodes;
    return [...ns]
      .map((node) => ({
        ...node,
        folder: folderOf(node.rel),
        stats: nodeStats.get(node.id) ?? { incoming: 0, outgoing: 0, degree: 0 },
      }))
      .sort(
        (a, b) =>
          b.stats.degree - a.stats.degree ||
          a.folder.localeCompare(b.folder) ||
          a.name.localeCompare(b.name) ||
          a.rel.localeCompare(b.rel)
      );
  }, [filtered, matchSet, nodeStats]);

  // Keep the active (roving-focus) option valid as the list changes.
  useEffect(() => {
    if (!showList) return;
    setActiveOption((cur) =>
      cur && listNodes.some((n) => n.id === cur) ? cur : (listNodes[0]?.id ?? null)
    );
  }, [showList, listNodes]);

  // On open, move keyboard focus into the list so it's usable straight away.
  useEffect(() => {
    if (!showList) return;
    listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
  }, [showList]);

  useEffect(() => {
    for (const node of sim.current.nodes) {
      node.color = byFolder
        ? folderColor(node.folder)
        : node.kind === "markdown"
          ? sim.current.colors.markdown
          : sim.current.colors.code;
    }
    kickRef.current();
  }, [byFolder]);

  // (Re)build the simulation whenever the filtered data changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let cancelled = false;
    let timer: number | null = null;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
    const colors = {
      markdown: cssVar(wrap, "--color-graph-markdown", "#4ca3ff"),
      code: cssVar(wrap, "--color-graph-code", "#3ec9a7"),
      edge: cssVar(wrap, "--acrylic-border", "rgba(160,180,200,0.25)"),
      text: cssVar(wrap, "--text-secondary", "#cdd6e0"),
      textDim: cssVar(wrap, "--text-disabled", "#7a8694"),
      active: cssVar(wrap, "--accent", "#4ca3ff"),
    };
    const deg = new Map<string, number>();
    const refs = new Map<string, number>();
    const linked = new Map<string, string[]>();
    const relations = new Map<string, { target: string; kind: GraphEdge["kind"] }[]>();
    for (const e of filtered.edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
      refs.set(e.target, (refs.get(e.target) ?? 0) + 1);
      const sourceRelations = relations.get(e.source);
      const relation = { target: e.target, kind: e.kind };
      if (sourceRelations) sourceRelations.push(relation);
      else relations.set(e.source, [relation]);
      const sourceLinks = linked.get(e.source);
      if (sourceLinks) sourceLinks.push(e.target);
      else linked.set(e.source, [e.target]);
      const targetLinks = linked.get(e.target);
      if (targetLinks) targetLinks.push(e.source);
      else linked.set(e.target, [e.source]);
    }
    // First time for this root: try the on-disk layout, else start empty.
    const posKey = rootPath ? graphPosKey(rootPath, connId) : null;
    const sameRootCache = Boolean(posKey && posCache?.key === posKey);
    if (sameRootCache && posCache) {
      for (const p of sim.current.nodes) posCache.pos.set(p.id, { x: p.x, y: p.y });
    }
    if (posKey && !sameRootCache) {
      posCache = loadPos(posKey) ?? { key: posKey, pos: new Map(), view: { x: 0, y: 0, k: 1 } };
    }
    const cachedPos = posKey && posCache?.key === posKey ? posCache.pos : null;
    const now = performance.now();
    const layoutNodes = filtered.nodes.map((node) => ({
      id: node.id,
      rel: node.rel,
      degree: deg.get(node.id) ?? 0,
      refs: refs.get(node.id) ?? 0,
      links: linked.get(node.id) ?? [],
      relations: relations.get(node.id) ?? [],
    }));
    // Seed as one broad Obsidian-like sphere. Folder mode is visual only; it
    // must not break the graph into disconnected-looking islands.
    const layout = createGraphLayoutSnapshot(layoutNodes, "organic");
    const islandInfoById = layout.islandInfo;
    const cellInfoById = layout.cellInfo;
    const seed = layout.positions;
    let restored = 0;
    const nodes: SimNode[] = filtered.nodes.map((n) => {
      const islandInfo = islandInfoById.get(n.id);
      const cellInfo = cellInfoById.get(n.id);
      const saved = cachedPos?.get(n.id);
      const initial = seed.get(n.id) ?? { x: 0, y: 0 };
      const folder = folderOf(n.rel);
      if (saved) restored++;
      return {
        ...n,
        x: saved ? saved.x : initial.x,
        y: saved ? saved.y : initial.y,
        vx: 0,
        vy: 0,
        deg: deg.get(n.id) ?? 0,
        refs: refs.get(n.id) ?? 0,
        folder,
        islandKey: islandInfo?.key ?? `${folder}:0`,
        islandLabel: islandInfo?.label ?? n.name,
        cellKey: cellInfo?.key ?? n.id,
        cellHubId: cellInfo?.hubId ?? n.id,
        cellRelationKind: cellInfo?.relationKind ?? "link",
        cellRadius: cellInfo?.radius ?? 12,
        cellCenterX: cellInfo?.center.x ?? initial.x,
        cellCenterY: cellInfo?.center.y ?? initial.y,
        color: sim.current.byFolder ? folderColor(folder) : n.kind === "markdown" ? colors.markdown : colors.code,
        anchorX: initial.x,
        anchorY: initial.y,
        // Restored nodes are already "there" (no pop-in); fresh nodes animate.
        t0: saved ? 0 : now,
      };
    });
    const index = new Map(nodes.map((n) => [n.id, n]));
    const edges: SimEdge[] = filtered.edges
      .map((e) => {
        const s = index.get(e.source);
        const t = index.get(e.target);
        return s && t ? { s, t, kind: e.kind } : null;
      })
      .filter((e): e is SimEdge => e !== null);
    const adj = new Map<string, Set<string>>();
    for (const e of edges) {
      (adj.get(e.s.id) ?? adj.set(e.s.id, new Set()).get(e.s.id)!).add(e.t.id);
      (adj.get(e.t.id) ?? adj.set(e.t.id, new Set()).get(e.t.id)!).add(e.s.id);
    }
    sim.current.nodes = nodes;
    sim.current.edges = edges;
    sim.current.adj = adj;
    if (sim.current.focus && index.has(sim.current.focus)) {
      sim.current.focusVisibleIds = new Set([
        sim.current.focus,
        ...(adj.get(sim.current.focus) ?? []),
      ]);
    } else {
      sim.current.focus = null;
      sim.current.focusVisibleIds = null;
      setFocusName(null);
    }
    sim.current.colors = colors;
    sim.current.edgeCursor = 0;
    const fresh = nodes.length - restored;
    sim.current.alpha = nodes.length > 0 && fresh / nodes.length < 0.1 ? 0.04 : 0.62;
    if (fresh > 0) sim.current.appearUntil = now + APPEAR_MS;
    // Auto-fit only a fresh, untouched layout (not filter toggles over a view).
    sim.current.needsFit = restored === 0 && !sim.current.userAdjusted;
    kickRef.current();
      }, 0);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [filtered, rootPath, connId]);

  // Canvas: sizing, the physics + render loop, interaction.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const S = sim.current;
    const canvasPosKey = rootPath ? graphPosKey(rootPath, connId) : null;
    if (posCache && canvasPosKey && posCache.key === canvasPosKey) {
      S.view = { ...posCache.view };
    }

    let running = false;
    const kick = () => {
      if (running) return;
      running = true;
      S.raf = requestAnimationFrame(loop);
    };
    kickRef.current = kick;

    let width = 0;
    let height = 0;
    let dpr = 1;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      width = r.width;
      height = r.height;
      // Very high DPI canvases multiply fill cost without improving this map's
      // small nodes enough to justify it. Two is visually crisp and bounded.
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      kick();
    });
    ro.observe(wrap);

    const radius = (n: SimNode) => {
      const incomingWeight = Math.sqrt(n.refs) * 2.8;
      const connectedWeight = Math.sqrt(Math.max(0, n.deg - n.refs)) * 1.15;
      return 3 + Math.min(13, incomingWeight + connectedWeight);
    };
    const renderRadius = (n: SimNode) => Math.max(radius(n), MIN_NODE_SCREEN_RADIUS / S.view.k);
    const visibleForFocus = (id: string) => !S.focusVisibleIds || S.focusVisibleIds.has(id);
    const edgeSpring = (edge: SimEdge) => {
      const relationScale =
        edge.kind === "wikilink" ? 0.76 : edge.kind === "link" ? 0.86 : 1.08;
      if (edge.s.cellKey === edge.t.cellKey) {
        return { ideal: 42 * relationScale, strength: edge.kind === "import" ? 0.016 : 0.023 };
      }
      if (edge.s.cellHubId === edge.t.cellHubId) {
        return { ideal: 94 * relationScale, strength: edge.kind === "import" ? 0.010 : 0.014 };
      }
      if (edge.s.islandKey === edge.t.islandKey) {
        return { ideal: 70 * relationScale, strength: edge.kind === "import" ? 0.011 : 0.015 };
      }
      if (edge.s.folder === edge.t.folder) {
        return {
          ideal: (S.byFolder ? 180 : 136) * relationScale,
          strength: edge.kind === "import" ? 0.0042 : 0.006,
        };
      }
      return {
        ideal: (S.byFolder ? 320 : 230) * relationScale,
        strength: edge.kind === "import" ? 0.002 : 0.003,
      };
    };
    const applyFocusState = (nodeId: string | null) => {
      S.focus = nodeId;
      S.focusVisibleIds = nodeId ? new Set([nodeId, ...(S.adj.get(nodeId) ?? [])]) : null;
    };

    // Smoothly animate the viewport toward `t` (used by fit + zoom controls).
    const animateTo = (t: View) => {
      S.viewTarget = t;
      kick();
    };
    /** Frame all (or the focused neighbourhood) nodes with padding. */
    const fitView = (animate = true) => {
      const ns = S.nodes.filter((n) => visibleForFocus(n.id));
      if (ns.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of ns) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x);
        maxY = Math.max(maxY, n.y);
      }
      const pad = 70;
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const k = Math.min(1.7, Math.max(0.12, Math.min((width - 2 * pad) / w, (height - 2 * pad) / h)));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const target = { x: -cx * k, y: -cy * k, k };
      if (animate) animateTo(target);
      else S.view = target;
    };
    fitRef.current = () => {
      S.userAdjusted = true;
      fitView(true);
    };
    const zoomBy = (factor: number) => {
      S.userAdjusted = true;
      const k = Math.min(4, Math.max(0.12, S.view.k * factor));
      animateTo({ x: (S.view.x * k) / S.view.k, y: (S.view.y * k) / S.view.k, k });
    };
    zoomRef.current = zoomBy;
    // Keyboard list → canvas: centre on a node and spotlight it (no file open).
    const centerNode = (id: string) => {
      const node = S.nodes.find((p) => p.id === id);
      if (!node) return;
      S.hovered = id;
      S.userAdjusted = true;
      const k = Math.max(S.view.k, 1);
      animateTo({ x: -node.x * k, y: -node.y * k, k });
    };
    centerNodeRef.current = centerNode;

    // One physics integration step (repulsion + springs + folder pull + gravity).
    // Extracted so reduced-motion can iterate it synchronously (settleStatic).
    const step = () => {
      const ns = S.nodes;
      applySpatialRepulsion(ns, 104, 2300);
      for (const e of S.edges) {
        const dx = e.t.x - e.s.x;
        const dy = e.t.y - e.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const { ideal, strength } = edgeSpring(e);
        const f = (d - ideal) * strength;
        e.s.vx += (dx / d) * f;
        e.s.vy += (dy / d) * f;
        e.t.vx -= (dx / d) * f;
        e.t.vy -= (dy / d) * f;
      }
      for (const p of ns) {
        if (p.cellRadius >= 72) {
          p.vx += (p.cellCenterX - p.x) * 0.01;
          p.vy += (p.cellCenterY - p.y) * 0.01;
        }
      }
      // Optional folder clustering: pull each node toward its folder centroid.
      if (S.byFolder) {
        const cen = new Map<string, { x: number; y: number; c: number }>();
        for (const p of ns) {
          const g = cen.get(p.folder) ?? { x: 0, y: 0, c: 0 };
          g.x += p.x;
          g.y += p.y;
          g.c++;
          cen.set(p.folder, g);
        }
        for (const p of ns) {
          const g = cen.get(p.folder)!;
          p.vx += (g.x / g.c - p.x) * 0.025;
          p.vy += (g.y / g.c - p.y) * 0.025;
        }
      }
      for (const p of ns) {
        p.vx += -p.x * 0.004;
        p.vy += -p.y * 0.004;
        if (p.fx !== undefined) {
          p.x = p.fx;
          p.y = p.fy!;
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx *= 0.82;
        p.vy *= 0.82;
        p.x += p.vx * S.alpha;
        p.y += p.vy * S.alpha;
      }
      S.alpha *= 0.99;
    };

    /** Reduced motion: iterate the layout to rest off-screen, fit, paint once —
     *  no prolonged decorative movement (F2-AUD-004). */
    const settleStatic = () => {
      if (S.nodes.length === 0) return;
      // Bound the loop; the alpha*=0.99 decay reaches <0.005 well within this.
      for (let i = 0; i < 600 && S.alpha > 0.005; i++) step();
      S.alpha = 0;
      S.appearUntil = 0; // skip the pop-in animation too
      S.viewTarget = null;
      if (S.needsFit && !S.userAdjusted) {
        S.needsFit = false;
        fitView(false);
      }
      draw(performance.now());
    };
    settleStaticRef.current = settleStatic;

    const arrange = (mode: GraphLayoutMode) => {
      const relations = new Map<string, { target: string; kind: GraphEdge["kind"] }[]>();
      for (const edge of S.edges) {
        const sourceRelations = relations.get(edge.s.id);
        const relation = { target: edge.t.id, kind: edge.kind };
        if (sourceRelations) sourceRelations.push(relation);
        else relations.set(edge.s.id, [relation]);
      }
      const layout = createGraphLayoutSnapshot(
        S.nodes.map((node) => ({
          id: node.id,
          rel: node.rel,
          degree: node.deg,
          refs: node.refs,
          links: Array.from(S.adj.get(node.id) ?? []),
          relations: relations.get(node.id) ?? [],
        })),
        mode
      );
      for (const node of S.nodes) {
        const point = layout.positions.get(node.id);
        if (!point) continue;
        const cellInfo = layout.cellInfo.get(node.id);
        node.anchorX = point.x;
        node.anchorY = point.y;
        node.cellKey = cellInfo?.key ?? node.id;
        node.cellHubId = cellInfo?.hubId ?? node.id;
        node.cellRelationKind = cellInfo?.relationKind ?? "link";
        node.cellRadius = cellInfo?.radius ?? 12;
        node.cellCenterX = cellInfo?.center.x ?? point.x;
        node.cellCenterY = cellInfo?.center.y ?? point.y;
        node.fx = undefined;
        node.fy = undefined;
        node.vx = 0;
        node.vy = 0;
      }
      S.alpha = 0.72;
      S.userAdjusted = false;
      S.needsFit = true;
      S.viewTarget = null;
      kick();
    };
    arrangeRef.current = arrange;

    const setFocus = (nodeId: string | null) => {
      applyFocusState(nodeId);
      const node = nodeId ? S.nodes.find((item) => item.id === nodeId) : null;
      setFocusName(node?.name ?? null);
      if (nodeId) requestAnimationFrame(() => fitView(true));
      kick();
    };
    focusRef.current = setFocus;

    const loop = () => {
      const ns = S.nodes;
      const n = ns.length;
      const now = performance.now();
      // Reduced motion: never run prolonged decorative physics — settle once.
      // But NOT during an active drag: a full synchronous settle on every
      // pointermove would freeze large graphs, hurting the very user who asked
      // for less motion. During a drag we advance one step per frame (cheap) and
      // let the settle finish on pointerup, when `mode` returns to "none".
      if (S.reduced && S.alpha > 0.005 && n > 0 && mode !== "drag") {
        settleStatic();
        running = false;
        return;
      }
      const physics = S.alpha > 0.005 && n > 0;
      if (physics) {
        // Local spatial hash replaces all-pairs repulsion. Nodes only interact
        // inside neighbouring cells, keeping large workspaces
        // responsive while collision/edge forces preserve the organic shape.
        applySpatialRepulsion(ns, 104, 2300);
        const edgeBudget = S.edges.length > 12_000 ? 12_000 : S.edges.length;
        for (let edgeStep = 0; edgeStep < edgeBudget; edgeStep++) {
          const edgeIndex = (S.edgeCursor + edgeStep) % S.edges.length;
          const e = S.edges[edgeIndex];
          const dx = e.t.x - e.s.x;
          const dy = e.t.y - e.s.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const { ideal, strength } = edgeSpring(e);
          const f = (d - ideal) * strength;
          e.s.vx += (dx / d) * f;
          e.s.vy += (dy / d) * f;
          e.t.vx -= (dx / d) * f;
          e.t.vy -= (dy / d) * f;
        }
        if (S.edges.length > edgeBudget) S.edgeCursor = (S.edgeCursor + edgeBudget) % S.edges.length;
        for (const p of ns) {
          // Invisible cluster boundaries: hubs with many linked children reserve
          // a small "cell" inside the global sphere. This creates the visual
          // whitespace around dense groups without drawing red/halo bubbles.
          if (S.showCells && p.cellRadius >= 72) {
            p.vx += (p.cellCenterX - p.x) * 0.01;
            p.vy += (p.cellCenterY - p.y) * 0.01;
          }
          const anchorStrength = S.byFolder ? 0.02 : 0.006;
          p.vx += (p.anchorX - p.x) * anchorStrength;
          p.vy += (p.anchorY - p.y) * anchorStrength;
          if (p.fx !== undefined) {
            p.x = p.fx;
            p.y = p.fy!;
            p.vx = 0;
            p.vy = 0;
            continue;
          }
          p.vx *= 0.82;
          p.vy *= 0.82;
          p.x += p.vx * S.alpha;
          p.y += p.vy * S.alpha;
        }
        // Settle in roughly two seconds instead of running hot for ~9 seconds.
        S.alpha *= 0.965;
        // Auto-fit once the fresh layout has mostly taken shape (big moves done).
        if (S.needsFit && S.alpha < 0.35 && !S.userAdjusted) {
          S.needsFit = false;
          fitView(true);
        }
      }
      // Viewport easing (fit / zoom controls) — instant when reduced motion.
      let animatingView = false;
      if (S.viewTarget) {
        const t = S.viewTarget;
        if (S.reduced) {
          S.view = { ...t };
          S.viewTarget = null;
        } else {
          S.view.x += (t.x - S.view.x) * 0.18;
          S.view.y += (t.y - S.view.y) * 0.18;
          S.view.k += (t.k - S.view.k) * 0.18;
          if (Math.abs(t.x - S.view.x) < 0.5 && Math.abs(t.y - S.view.y) < 0.5 && Math.abs(t.k - S.view.k) < 0.002) {
            S.view = { ...t };
            S.viewTarget = null;
          } else {
            animatingView = true;
          }
        }
      }
      const appearing = !S.reduced && now < S.appearUntil;
      draw(now);
      if (physics || animatingView || appearing) {
        S.raf = requestAnimationFrame(loop);
      } else {
        running = false;
      }
    };

    const draw = (now: number) => {
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.translate(width / 2 + S.view.x, height / 2 + S.view.y);
      ctx.scale(S.view.k, S.view.k);

      const hov = S.hovered;
      const match = S.match;
      const neighbours = hov ? S.adj.get(hov) : null;
      const isLit = (id: string) =>
        match ? match.has(id) : !hov || id === hov || (neighbours?.has(id) ?? false);
      const margin = 96 / S.view.k;
      const left = (-width / 2 - S.view.x) / S.view.k - margin;
      const right = (width / 2 - S.view.x) / S.view.k + margin;
      const top = (-height / 2 - S.view.y) / S.view.k - margin;
      const bottom = (height / 2 - S.view.y) / S.view.k + margin;
      const inViewport = (x: number, y: number, extra = 0) =>
        x >= left - extra && x <= right + extra && y >= top - extra && y <= bottom + extra;
      const edgeInViewport = (edge: SimEdge) =>
        !(
          (edge.s.x < left && edge.t.x < left) ||
          (edge.s.x > right && edge.t.x > right) ||
          (edge.s.y < top && edge.t.y < top) ||
          (edge.s.y > bottom && edge.t.y > bottom)
        );
      ctx.lineWidth = 1 / S.view.k;
      ctx.lineCap = "round";
      // Draw edges in a few semantic batches. This keeps the canvas fast while
      // making the visual hierarchy closer to Obsidian: cross-folder links are
      // whispers, project links are secondary, local links are readable.
      const edgeIsLit = (edge: SimEdge) =>
        match
          ? match.has(edge.s.id) || match.has(edge.t.id)
          : !hov || edge.s.id === hov || edge.t.id === hov;
      const arrowEdges: SimEdge[] = [];
      const queueArrow = (edge: SimEdge) => {
        if (!S.showArrows) return;
        if (!(hov || match || S.view.k > 0.78)) return;
        if (!edgeIsLit(edge) || arrowEdges.length >= 1200) return;
        arrowEdges.push(edge);
      };
      const strokePath = (path: Path2D, alpha: number, color = S.colors.edge) => {
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.stroke(path);
      };
      const maxDrawnEdges = hov || match || S.alpha > 0.005 || S.viewTarget
        ? MAX_DRAWN_ACTIVE_EDGES
        : MAX_DRAWN_IDLE_EDGES;
      const edgeDrawStep = S.edges.length > maxDrawnEdges
        ? Math.ceil(S.edges.length / maxDrawnEdges)
        : 1;
      const semanticIdleEdges = !hov && !match && S.byFolder && S.edges.length <= 8000;
      if (semanticIdleEdges) {
        const crossFolder = new Path2D();
        const siblingIsland = new Path2D();
        const localIsland = new Path2D();
        for (let edgeIndex = 0; edgeIndex < S.edges.length; edgeIndex += edgeDrawStep) {
          const edge = S.edges[edgeIndex];
          if (S.focus && !(visibleForFocus(edge.s.id) && visibleForFocus(edge.t.id))) continue;
          if (!edgeInViewport(edge)) continue;
          queueArrow(edge);
          const path =
            edge.s.folder !== edge.t.folder
              ? crossFolder
              : edge.s.islandKey !== edge.t.islandKey
                ? siblingIsland
                : localIsland;
          path.moveTo(edge.s.x, edge.s.y);
          path.lineTo(edge.t.x, edge.t.y);
        }
        strokePath(crossFolder, 0.075);
        strokePath(siblingIsland, 0.14);
        strokePath(localIsland, 0.28);
      } else {
        const dimEdges = new Path2D();
        const litEdges = new Path2D();
        for (let edgeIndex = 0; edgeIndex < S.edges.length; edgeIndex += edgeDrawStep) {
          const edge = S.edges[edgeIndex];
          if (S.focus && !(visibleForFocus(edge.s.id) && visibleForFocus(edge.t.id))) continue;
          if (!edgeInViewport(edge)) continue;
          queueArrow(edge);
          const path = edgeIsLit(edge) ? litEdges : dimEdges;
          path.moveTo(edge.s.x, edge.s.y);
          path.lineTo(edge.t.x, edge.t.y);
        }
        strokePath(dimEdges, 0.06);
        if (hov || match) {
          ctx.lineWidth = 3 / S.view.k;
          strokePath(litEdges, 0.1, S.colors.active);
          ctx.lineWidth = 1.15 / S.view.k;
        }
        strokePath(
          litEdges,
          hov || match ? 0.68 : 0.34,
          hov || match ? S.colors.text : S.colors.edge
        );
      }
      if (arrowEdges.length > 0) {
        ctx.fillStyle = hov || match ? S.colors.text : S.colors.edge;
        ctx.globalAlpha = hov || match ? 0.74 : 0.32;
        for (const edge of arrowEdges) {
          const dx = edge.t.x - edge.s.x;
          const dy = edge.t.y - edge.s.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 0.01) continue;
          const ux = dx / d;
          const uy = dy / d;
          const tipInset = renderRadius(edge.t) + 2 / S.view.k;
          const tipX = edge.t.x - ux * tipInset;
          const tipY = edge.t.y - uy * tipInset;
          const size = 6 / S.view.k;
          const wing = 3.8 / S.view.k;
          const baseX = tipX - ux * size;
          const baseY = tipY - uy * size;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(baseX - uy * wing, baseY + ux * wing);
          ctx.lineTo(baseX + uy * wing, baseY - ux * wing);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.lineCap = "butt";

      const showLabels = S.view.k > (S.nodes.length > 900 ? 1.35 : 0.85);
      for (const p of S.nodes) {
        if (S.focus && !visibleForFocus(p.id)) continue;
        if (!inViewport(p.x, p.y, 24)) continue;
        const age = now - p.t0;
        const appear = age < APPEAR_MS ? easeOutCubic(Math.max(0, age) / APPEAR_MS) : 1;
        const r = renderRadius(p) * (0.35 + 0.65 * appear);
        const lit = isLit(p.id);
        const isActive = p.id === S.activePath;
        ctx.globalAlpha = (lit ? 1 : 0.25) * appear;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        if (isActive || p.id === hov || p.id === S.focus) {
          ctx.lineWidth = 2 / S.view.k;
          ctx.strokeStyle = S.colors.active;
          ctx.stroke();
        } else if (lit && r > 2.8 / S.view.k) {
          ctx.lineWidth = 0.75 / S.view.k;
          ctx.strokeStyle = "rgba(255,255,255,0.2)";
          ctx.stroke();
        }
        if (lit && appear > 0.6 && (showLabels || p.id === hov || isActive || p.id === S.focus)) {
          ctx.globalAlpha = appear;
          ctx.fillStyle = p.id === hov || isActive ? S.colors.text : S.colors.textDim;
          ctx.font = `${11 / S.view.k}px -apple-system, "Segoe UI", system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(p.name, p.x, p.y + r + 2 / S.view.k);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    // ---- Pointer interaction ----
    const toWorld = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      const sx = clientX - r.left - width / 2 - S.view.x;
      const sy = clientY - r.top - height / 2 - S.view.y;
      return { x: sx / S.view.k, y: sy / S.view.k };
    };
    const nodeAt = (clientX: number, clientY: number): SimNode | null => {
      const w = toWorld(clientX, clientY);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const p of S.nodes) {
        if (S.focus && !visibleForFocus(p.id)) continue;
        const r = renderRadius(p) + 4 / S.view.k;
        const dx = p.x - w.x;
        const dy = p.y - w.y;
        const d = dx * dx + dy * dy;
        if (d < r * r && d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return best;
    };

    let mode: "none" | "pan" | "drag" = "none";
    let dragNode: SimNode | null = null;
    let downX = 0;
    let downY = 0;
    let moved = false;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      setContextMenu(null);
      canvas.setPointerCapture(e.pointerId);
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      const hit = nodeAt(e.clientX, e.clientY);
      if (hit) {
        mode = "drag";
        dragNode = hit;
        const w = toWorld(e.clientX, e.clientY);
        hit.fx = w.x;
        hit.fy = w.y;
      } else {
        mode = "pan";
      }
      kick();
    };
    const onMove = (e: PointerEvent) => {
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
      if (mode === "pan") {
        S.view.x += e.movementX;
        S.view.y += e.movementY;
        S.viewTarget = null;
        S.userAdjusted = true;
      } else if (mode === "drag" && dragNode) {
        const w = toWorld(e.clientX, e.clientY);
        dragNode.fx = w.x;
        dragNode.fy = w.y;
        S.alpha = Math.max(S.alpha, 0.5);
      } else {
        const hit = nodeAt(e.clientX, e.clientY);
        const id = hit?.id ?? null;
        if (id !== S.hovered) S.hovered = id;
        canvas.style.cursor = hit ? "pointer" : "grab";
      }
      kick();
    };
    const onUp = (e: PointerEvent) => {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (mode === "drag" && dragNode) {
        if (!moved) S.onOpen(dragNode.id);
        dragNode.fx = undefined;
        dragNode.fy = undefined;
      }
      mode = "none";
      dragNode = null;
      kick();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left - width / 2;
      const cy = e.clientY - r.top - height / 2;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(4, Math.max(0.12, S.view.k * factor));
      S.viewTarget = null;
      S.view.x = cx - ((cx - S.view.x) * k) / S.view.k;
      S.view.y = cy - ((cy - S.view.y) * k) / S.view.k;
      S.view.k = k;
      S.userAdjusted = true;
      kick();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const hit = nodeAt(e.clientX, e.clientY);
      const rect = wrap.getBoundingClientRect();
      setContextMenu({
        x: Math.min(rect.width - 210, Math.max(8, e.clientX - rect.left)),
        y: Math.min(rect.height - 190, Math.max(8, e.clientY - rect.top)),
        nodeId: hit?.id ?? null,
        nodeName: hit?.name ?? null,
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
      if (e.key === "Escape" && S.focus) {
        applyFocusState(null);
        setFocusName(null);
        kick();
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKey);
    kick();

    return () => {
      cancelAnimationFrame(S.raf);
      running = false;
      kickRef.current = () => {};
      arrangeRef.current = () => {};
      focusRef.current = () => {};
      const posKey = rootPath ? graphPosKey(rootPath, connId) : null;
      if (posCache && posKey && posCache.key === posKey) {
        for (const p of S.nodes) posCache.pos.set(p.id, { x: p.x, y: p.y });
        posCache.view = { ...S.view };
        savePos(posCache);
      }
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKey);
    };
    // Mount-once render loop; rootPath is read at mount for cache keying.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    invalidateGraph();
    invalidateIndex();
    try {
      if (rootPath) localStorage.removeItem(POS_KEY + graphPosKey(rootPath, connId));
    } catch {
      /* ignore */
    }
    posCache = null;
    sim.current.userAdjusted = false;
    sim.current.focus = null;
    sim.current.focusVisibleIds = null;
    setFocusName(null);
    setReloadKey((k) => k + 1);
  };
  const copyAgentDigest = async () => {
    if (!rootPath) {
      window.alert("Abra uma pasta primeiro para montar o resumo do grafo.");
      return;
    }
    try {
      const digest = await buildGraphAgentDigest(
        rootPath,
        activePath && !activePath.startsWith("fluentcoder://") ? activePath : undefined,
        connId ?? undefined
      );
      await navigator.clipboard.writeText(digest);
      window.alert(
        `Resumo do grafo copiado (${digest.length} caracteres).\n\n` +
          "Use no chat de um agente quando quiser orientar análise por módulos, hubs e conexões."
      );
    } catch (e) {
      window.alert(`Não foi possível montar o resumo do grafo:\n${e}`);
    }
  };
  const exitFocus = () => {
    sim.current.focus = null;
    sim.current.focusVisibleIds = null;
    setFocusName(null);
    kickRef.current();
  };
  const reorganize = (mode: GraphVisualAction) => {
    setContextMenu(null);
    if (mode === "folderColor") {
      setByFolder(true);
      setShowCells(true);
      return;
    }
    setByFolder(false);
    setShowCells(true);
    requestAnimationFrame(() => arrangeRef.current("organic"));
  };
  const focusContextNode = () => {
    focusRef.current(contextMenu?.nodeId ?? null);
    setContextMenu(null);
  };

  // ---- Accessible node list interaction (F2-AUD-015) ----
  // Selecting/focusing an option centres + spotlights the node on the canvas;
  // Enter/Space opens its file (same action as a click).
  const selectOption = (id: string) => {
    setActiveOption(id);
    centerNodeRef.current(id);
  };
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = listNodes.findIndex((n) => n.id === activeOption);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (listNodes.length === 0) return;
      const next =
        i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : -1) + listNodes.length) % listNodes.length;
      const id = listNodes[next].id;
      selectOption(id);
      listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const node = e.key === "Home" ? listNodes[0] : listNodes[listNodes.length - 1];
      if (!node) return;
      selectOption(node.id);
      listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(node.id)}"]`)?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && activeOption) {
      e.preventDefault();
      openGraphFile(activeOption);
    }
  };

  const mdCount = filtered.nodes.filter((n) => n.kind === "markdown").length;
  const codeCount = filtered.nodes.length - mdCount;

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <span className="graph-title">Grafo de Contextos</span>
        <span className="graph-stat">
          {filtered.nodes.length} nós · {filtered.edges.length} conexões
          {graphUpdating ? " · atualizando…" : ""}
        </span>
        <input
          className="graph-search"
          type="text"
          placeholder="Buscar nó…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <div className="graph-toolbar-spacer" />
        <label className="graph-toggle">
          <input type="checkbox" checked={showCode} onChange={(e) => setShowCode(e.target.checked)} />
          Código
        </label>
        <label className="graph-toggle">
          <input
            type="checkbox"
            checked={showOrphans}
            onChange={(e) => setShowOrphans(e.target.checked)}
          />
          Sem conexões
        </label>
        <label className="graph-toggle">
          <input type="checkbox" checked={byFolder} onChange={(e) => setByFolder(e.target.checked)} />
          Por pasta
        </label>
        <label className="graph-toggle" title="Aproxima hubs e arquivos referenciados sem desenhar grupos">
          <input type="checkbox" checked={showCells} onChange={(e) => setShowCells(e.target.checked)} />
          Aglomerar
        </label>
        <label className="graph-toggle" title="Mostra a direção das referências quando houver espaço visual">
          <input type="checkbox" checked={showArrows} onChange={(e) => setShowArrows(e.target.checked)} />
          Setas
        </label>
        <button
          type="button"
          className="graph-icon-btn"
          aria-label="Copiar resumo do grafo para agente"
          title="Copiar resumo do grafo — módulos, hubs e conexões para colar no agente"
          onClick={copyAgentDigest}
        >
          <span className="codicon codicon-copy" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="graph-icon-btn"
          aria-label={showList ? "Ocultar lista de nós" : "Mostrar lista de nós"}
          aria-pressed={showList}
          title="Lista de nós — navegação por teclado (alternativa textual ao grafo)"
          onClick={() => setShowList((v) => !v)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5.5 4h7M5.5 8h7M5.5 12h7M2.5 4h.01M2.5 8h.01M2.5 12h.01"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="graph-icon-btn"
          aria-label="Atualizar grafo"
          title="Atualizar — reanalisa o workspace e reorganiza"
          onClick={refresh}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
              stroke="currentColor"
              strokeWidth="1.3"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* role="group" (not "application"): the canvas is aria-hidden and the
          accessible path is the node listbox, so we keep the screen reader's
          virtual-cursor on the help text/legend/status rather than suppressing
          it (which role="application" would do). */}
      <div
        className="graph-canvas-wrap"
        ref={wrapRef}
        role="group"
        aria-label="Grafo de dependências entre arquivos"
        aria-describedby="graph-a11y-help"
      >
        <p id="graph-a11y-help" className="graph-sr-only">
          Mapa interativo de arquivos e suas conexões. Para navegar sem o mouse, use o
          botão “Lista de nós” na barra de ferramentas: percorra os arquivos com as setas
          ou Tab e pressione Enter para abrir o arquivo selecionado no editor.
        </p>
        <canvas ref={canvasRef} className="graph-canvas" aria-hidden="true" />

        {showList && (
          <div className="graph-node-list" aria-label="Lista de nós do grafo">
            <div
              ref={listRef}
              className="graph-node-list-box"
              role="listbox"
              aria-label="Nós do grafo — Enter abre o arquivo"
              onKeyDown={onListKeyDown}
            >
              {listNodes.length === 0 ? (
                <p className="graph-node-list-empty">Nenhum nó corresponde ao filtro.</p>
              ) : (
                listNodes.map((n) => (
                  <div
                    key={n.id}
                    id={`graph-opt-${n.id}`}
                    data-id={n.id}
                    role="option"
                    aria-selected={n.id === activeOption}
                    tabIndex={n.id === activeOption ? 0 : -1}
                    className={`graph-node-option${n.id === activeOption ? " is-active" : ""}${
                      n.id === activePath ? " is-current" : ""
                    }`}
                    title={n.rel}
                    onFocus={() => selectOption(n.id)}
                    onClick={() => selectOption(n.id)}
                    onDoubleClick={() => openGraphFile(n.id)}
                  >
                    <i
                      className={`graph-dot ${n.kind === "markdown" ? "graph-dot-md" : "graph-dot-code"}`}
                      aria-hidden="true"
                    />
                    <span className="graph-node-option-name">{n.name}</span>
                    <span className="graph-node-option-rel">{n.rel}</span>
                    <span className="graph-node-option-meta" aria-label={`${n.stats.degree} conexões`}>
                      {n.kind === "markdown" ? "MD" : "CODE"} · {n.folder} · {n.stats.degree}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {contextMenu && (
          <div
            className="graph-context-menu"
            role="menu"
            aria-label="Organização do grafo"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.nodeId && (
              <button type="button" role="menuitem" onClick={focusContextNode}>
                <span className="codicon codicon-focus-center" aria-hidden="true" />
                Focar {contextMenu.nodeName}
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => reorganize("folderColor")}>
              <span className="codicon codicon-symbol-misc" aria-hidden="true" />
              Agrupar por pasta
            </button>
            <button type="button" role="menuitem" onClick={() => reorganize("organic")}>
              <span className="codicon codicon-symbol-misc" aria-hidden="true" />
              Visual Obsidian
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                fitRef.current();
              }}
            >
              <span className="codicon codicon-screen-full" aria-hidden="true" />
              Enquadrar grafo
            </button>
          </div>
        )}

        <div className="graph-zoom">
          <button
            type="button"
            aria-label="Aproximar"
            title="Aproximar"
            onClick={() => zoomRef.current(1.3)}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Enquadrar tudo"
            title="Enquadrar tudo"
            onClick={() => fitRef.current()}
          >
            ⤢
          </button>
          <button
            type="button"
            aria-label="Afastar"
            title="Afastar"
            onClick={() => zoomRef.current(1 / 1.3)}
          >
            −
          </button>
        </div>

        {focusName && (
          <button type="button" className="graph-focus-pill" onClick={exitFocus}>
            Foco: {focusName} ✕
          </button>
        )}

        <div className="graph-legend">
          {byFolder ? (
            <span>Pastas + células compostas</span>
          ) : (
            <>
              <span>
                <i className="graph-dot graph-dot-md" /> Markdown ({mdCount})
              </span>
              <span>
                <i className="graph-dot graph-dot-code" /> Código ({codeCount})
              </span>
              {showCells && <span>Hubs atraem referências</span>}
              {showArrows && <span>Setas indicam destino</span>}
            </>
          )}
        </div>

        {!rootPath && (
          <div className="graph-empty">Abra uma pasta para ver o grafo de contextos.</div>
        )}
        {loading && <div className="graph-empty">Analisando o workspace…</div>}
        {error && <div className="graph-empty graph-error">{error}</div>}
        {rootPath && !loading && !error && data && filtered.nodes.length === 0 && (
          <div className="graph-empty">Nenhum nó para exibir com os filtros atuais.</div>
        )}
      </div>
    </div>
  );
}
