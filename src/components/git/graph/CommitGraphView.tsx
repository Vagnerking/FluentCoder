import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Codicon } from "../../../icons/codicons/Codicon";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { SearchBox } from "../../ui/Input";
import { Menu, type MenuItemSpec } from "../../ui/Menu";
import { ConfirmDialog } from "../../ConfirmDialog";
import { QuickInput } from "../../QuickInput";
import { GitAvatar } from "../GitAvatar";
import type { GitRevisionDiffTarget } from "../../../api";
import { gitCheckout } from "../../../api";
import {
  gitBranchLineage,
  gitCherryPick,
  gitCreateBranchAt,
  type BranchLineage,
  type GraphQuery,
  type GraphRefMode,
  type GraphRow,
} from "../../../git/graphApi";
import {
  LANE_GEOMETRY,
  shouldLoadMore,
  virtualWindow,
  visibleLaneWidth,
  type GraphRowLayout,
} from "../../../git/graphLayout";
import {
  commitWebUrl,
  firstParentChain,
  pickHostingRemote,
  pullRequestWebUrl,
  summarizeLineage,
  type RefPill,
} from "../../../git/graphModel";
import { formatAbsoluteDate, formatAuthor, formatRelativeDate, formatRelativeDateLong } from "../../../ui/format";
import { gitRevertCommit } from "../../../api";
import { CommitDetailsPanel, type CommitDetailsMode } from "./CommitDetailsPanel";
import { CommitHoverCard } from "./CommitHoverCard";
import { GraphLanes, type GraphNodeMarker } from "./GraphLanes";
import { RefPillView, copyText, openExternalUrl } from "./CommitParts";
import { useCommitGraph } from "./useCommitGraph";
import { useElementSize } from "../../ui/ViewPane/useElementSize";

const ROW_H = LANE_GEOMETRY.rowHeight;
const HOVER_OPEN_MS = 450;
const HOVER_SWITCH_MS = 120;
const HOVER_CLOSE_MS = 180;
const LINEAGE_HOVER_MS = 300;
const QUERY_STORAGE_KEY = "git.graph.query";

const MODE_LABEL: Record<GraphRefMode, string> = {
  auto: "Automático",
  all: "Todas as branches",
  current: "Branch atual",
  selected: "Selecionadas",
};

interface StoredQuery {
  refs: GraphRefMode;
  selected: string[];
  firstParent: boolean;
}

function readStoredQuery(): StoredQuery {
  try {
    const raw = JSON.parse(localStorage.getItem(QUERY_STORAGE_KEY) ?? "null") as Partial<StoredQuery> | null;
    if (raw && typeof raw === "object") {
      return {
        refs: raw.refs && raw.refs in MODE_LABEL ? raw.refs : "auto",
        selected: Array.isArray(raw.selected) ? raw.selected.filter((s) => typeof s === "string") : [],
        firstParent: Boolean(raw.firstParent),
      };
    }
  } catch {
    /* sem storage: padrão */
  }
  return { refs: "auto", selected: [], firstParent: false };
}

export interface CommitGraphViewProps {
  rootPath: string;
  connId?: string;
  /** Pane expandido/visível: carrega ao habilitar. */
  active: boolean;
  /** Muda quando HEAD/refs mudam (commit, checkout, fetch…). */
  reloadKey: number;
  busy: boolean;
  /** Roda uma operação git (busy + toast de erro + refresh). */
  onRun: (fn: () => Promise<unknown>) => void;
  onPull?: () => void;
  onPush?: () => void;
  onFetch?: () => void;
  /** "Mostrar no grafo" vindo de outras views. */
  focusHash?: { hash: string; nonce: number } | null;
  onOpenRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget,
    rootPath?: string,
    connId?: string
  ) => void;
  onOpenRevision?: (filePath: string, commitHash: string, shortHash: string, rootPath?: string, connId?: string) => void;
}

interface HoverState {
  hash: string;
  anchor: { top: number; bottom: number; left: number; right: number; pointerX: number | null };
  keyboard: boolean;
}

interface LineageState {
  ref: string;
  pinned: boolean;
  data: BranchLineage | "loading" | { error: string };
}

type MenuState = { anchor: { x: number; y: number }; items: MenuItemSpec[]; label: string } | null;

type ConfirmState = {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  run: () => void;
} | null;

type InputState = { title: string; placeholder: string; prompt?: string; submit: (value: string) => void } | null;

/**
 * Grafo de commits (estilo VS Code/GitLens): lista virtualizada com trilhos
 * por branch, pílulas de refs, cartão de commit no hover, detalhes com
 * árvore de arquivos e linhagem da branch (divergência, distância e merge).
 */
export function CommitGraphView({
  rootPath,
  connId,
  active,
  reloadKey,
  busy,
  onRun,
  onPull,
  onPush,
  onFetch,
  focusHash,
  onOpenRevisionDiff,
  onOpenRevision,
}: CommitGraphViewProps) {
  const [stored, setStored] = useState<StoredQuery>(readStoredQuery);
  const [author, setAuthor] = useState<string | null>(null);
  const [pathFilter, setPathFilter] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);
  useEffect(() => {
    try {
      localStorage.setItem(QUERY_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* ignore */
    }
  }, [stored]);

  const query = useMemo<GraphQuery>(
    () => ({
      refs: stored.refs,
      selected: stored.refs === "selected" ? stored.selected : undefined,
      author: author ?? undefined,
      search: search || undefined,
      path: pathFilter ?? undefined,
      firstParent: stored.firstParent || undefined,
    }),
    [author, pathFilter, search, stored]
  );
  const graph = useCommitGraph(rootPath, connId, query, active, reloadKey);
  const { header, rows, layout, refIndex, indexOf } = graph;

  // ---------------------------------------------------------------- medidas
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(rootRef);
  const { height: viewport } = useElementSize(listRef);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollingRef = useRef<number | null>(null);
  const maxLanes = width < 320 ? 5 : width < 520 ? 8 : 14;
  const laneWidth = width > 0 && width < 320 ? 9 : LANE_GEOMETRY.laneWidth;
  const showMeta = width >= 420;
  const showAuthor = width >= 640;
  const narrow = width > 0 && width < 340;
  const inlinePills = width < 320 ? 1 : width < 520 ? 2 : 3;
  const win = virtualWindow(scrollTop, viewport || ROW_H * 12, ROW_H, rows.length, 10);
  // Coluna de trilhos = a mais larga entre as linhas da janela (não a do
  // histórico inteiro): o assunto ganha espaço onde há poucas lanes.
  let windowWidth = 1;
  for (let i = win.start; i < win.end; i++) windowWidth = Math.max(windowWidth, layout[i]?.width ?? 1);
  const lanes = visibleLaneWidth(windowWidth, maxLanes);

  useEffect(() => {
    if (shouldLoadMore(win.end, rows.length, graph.hasMore, graph.loading)) graph.loadMore();
  }, [graph, rows.length, win.end]);

  // ---------------------------------------------------------------- derivados
  const hosting = useMemo(
    () => (header ? pickHostingRemote(header.remotes, header.head.upstream) : null),
    [header]
  );
  const incoming = useMemo(() => new Set(header?.incoming ?? []), [header]);
  const outgoing = useMemo(() => new Set(header?.outgoing ?? []), [header]);
  const headHash = header?.head.hash ?? null;
  const matches = useMemo(() => {
    const set = header?.matches ? new Set(header.matches) : null;
    const q = search.toLowerCase();
    if (/^[0-9a-f]{4,40}$/.test(q)) {
      const out = set ?? new Set<string>();
      for (const r of rows) if (r.hash.startsWith(q)) out.add(r.hash);
      return out;
    }
    return set;
  }, [header, rows, search]);
  const matchOrder = useMemo(() => (matches ? rows.filter((r) => matches.has(r.hash)).map((r) => r.hash) : []), [matches, rows]);
  const identity = header?.identity ?? null;

  // ---------------------------------------------------------------- seleção
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailsMode, setDetailsMode] = useState<CommitDetailsMode>({ kind: "commit" });
  const [compareBase, setCompareBase] = useState<{ hash: string; label: string } | null>(null);
  const [matchCursor, setMatchCursor] = useState(0);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = listRef.current;
      if (!el) return;
      const top = index * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    },
    []
  );

  const selectHash = useCallback(
    (wanted: string, mode: CommitDetailsMode = { kind: "commit" }) => {
      // Aceita hash curto (Branches/Tags mandam o abreviado).
      const hash = indexOf.has(wanted) ? wanted : rows.find((r) => r.hash.startsWith(wanted))?.hash ?? wanted;
      setSelected(hash);
      setDetailsMode(mode);
      const index = indexOf.get(hash);
      if (index !== undefined) {
        setActiveIndex(index);
        requestAnimationFrame(() => scrollToIndex(index));
      }
    },
    [indexOf, rows, scrollToIndex]
  );

  useEffect(() => {
    if (!focusHash) return;
    selectHash(focusHash.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusHash?.nonce]);

  // Consulta nova: volta ao topo.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
    setActiveIndex(0);
    setMatchCursor(0);
  }, [query, rootPath, connId]);

  // ---------------------------------------------------------------- hover card
  const [hover, setHover] = useState<HoverState | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const clearTimers = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  const hoverRef = useRef(hover);
  hoverRef.current = hover;

  const onRowPointerEnter = useCallback((hash: string, el: HTMLElement, pointerX: number) => {
    if (scrollingRef.current) return;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (openTimer.current) window.clearTimeout(openTimer.current);
    const delay = hoverRef.current ? HOVER_SWITCH_MS : HOVER_OPEN_MS;
    openTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setHover({ hash, anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, pointerX }, keyboard: false });
    }, delay);
  }, []);

  const scheduleClose = useCallback(() => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = null;
    if (hoverRef.current?.keyboard) return;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHover(null), HOVER_CLOSE_MS);
  }, []);

  const keepOpen = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  useEffect(() => () => clearTimers(), []);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // Durante a rolagem o cartão fecha e não abre.
    if (hoverRef.current) setHover(null);
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (scrollingRef.current) window.clearTimeout(scrollingRef.current);
    scrollingRef.current = window.setTimeout(() => (scrollingRef.current = null), 150);
  };

  // ---------------------------------------------------------------- linhagem
  const [lineage, setLineage] = useState<LineageState | null>(null);
  const lineageCache = useRef(new Map<string, BranchLineage>());
  const lineageTimer = useRef<number | null>(null);
  useEffect(() => {
    lineageCache.current.clear();
    setLineage((cur) => (cur?.pinned ? cur : null));
  }, [reloadKey, rootPath, connId]);

  const loadLineage = useCallback(
    (ref: string, pinned: boolean) => {
      const tip = header?.refs.find((r) => r.short === ref)?.target ?? (ref === "HEAD" ? headHash : null) ?? "";
      const key = `${ref}\u0000${tip}`;
      const cached = lineageCache.current.get(key);
      setLineage({ ref, pinned, data: cached ?? "loading" });
      if (cached) return;
      gitBranchLineage(rootPath, ref, header?.defaultBranch ?? null, connId)
        .then((data) => {
          lineageCache.current.set(key, data);
          setLineage((cur) => (cur && cur.ref === ref ? { ...cur, data } : cur));
        })
        .catch((err) => setLineage((cur) => (cur && cur.ref === ref ? { ...cur, data: { error: String(err) } } : cur)));
    },
    [connId, header, headHash, rootPath]
  );

  // Estado atual sem efeitos colaterais dentro de updaters do setState.
  const lineageRef = useRef(lineage);
  lineageRef.current = lineage;

  const onPillEnter = useCallback(
    (pill: RefPill) => {
      if (lineageTimer.current) window.clearTimeout(lineageTimer.current);
      lineageTimer.current = window.setTimeout(() => {
        if (lineageRef.current?.pinned) return;
        loadLineage(pill.ref, false);
      }, LINEAGE_HOVER_MS);
    },
    [loadLineage]
  );
  const onPillLeave = useCallback(() => {
    if (lineageTimer.current) window.clearTimeout(lineageTimer.current);
    lineageTimer.current = window.setTimeout(() => setLineage((cur) => (cur?.pinned ? cur : null)), 150);
  }, []);
  const onPillClick = useCallback(
    (pill: RefPill) => {
      if (lineageTimer.current) window.clearTimeout(lineageTimer.current);
      const cur = lineageRef.current;
      if (cur?.pinned && cur.ref === pill.ref) setLineage(null);
      else loadLineage(pill.ref, true);
    },
    [loadLineage]
  );

  const pathSet = useMemo<ReadonlySet<string> | null>(() => {
    if (!lineage || typeof lineage.data !== "object" || "error" in lineage.data) return null;
    const l = lineage.data;
    if (l.isBase) return new Set(firstParentChain(l.tip, (h) => rows[indexOf.get(h) ?? -1]?.parents));
    const set = new Set(l.path);
    set.add(l.tip);
    if (l.mergeBase) set.add(l.mergeBase);
    if (l.mergedInto) set.add(l.mergedInto.hash);
    return set;
  }, [indexOf, lineage, rows]);

  // ---------------------------------------------------------------- ações
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [input, setInput] = useState<InputState>(null);

  const rowOf = useCallback((hash: string) => rows[indexOf.get(hash) ?? -1], [indexOf, rows]);

  const actionsFor = useCallback(
    (row: GraphRow) => {
      const short = row.hash.slice(0, 7);
      const branches = (refIndex.byHash.get(row.hash) ?? []).filter((p) => p.kind === "branch");
      return {
        checkout: () =>
          setConfirm({
            title: "Fazer checkout do commit",
            message: `O HEAD ficará destacado em ${short} ("${row.subject}"). Para continuar trabalhando, crie uma branch depois.`,
            confirm: "Fazer checkout",
            run: () => onRun(() => gitCheckout(rootPath, row.hash, connId)),
          }),
        checkoutBranch: (name: string) => onRun(() => gitCheckout(rootPath, name, connId)),
        branches,
        createBranch: () =>
          setInput({
            title: `Criar branch em ${short}`,
            placeholder: "Nome da nova branch",
            prompt: "Enter cria e faz checkout da branch neste commit.",
            submit: (name) => onRun(() => gitCreateBranchAt(rootPath, name, row.hash, true, connId)),
          }),
        cherryPick: () => onRun(() => gitCherryPick(rootPath, row.hash, connId)),
        revert: () =>
          setConfirm({
            title: "Reverter commit",
            message: `Criar um commit que desfaz ${short} ("${row.subject}")?`,
            confirm: "Reverter",
            danger: true,
            run: () => onRun(() => gitRevertCommit(rootPath, row.hash, connId)),
          }),
        compareItems: (): MenuItemSpec[] => [
          {
            id: "cmp-working",
            label: "Com a árvore de trabalho",
            icon: "file",
            onSelect: () => selectHash(row.hash, { kind: "working" }),
          },
          {
            id: "cmp-head",
            label: "Com o HEAD",
            icon: "target",
            disabled: !headHash || headHash === row.hash,
            onSelect: () => headHash && selectHash(headHash, { kind: "revision", against: row.hash, label: short }),
          },
          {
            id: "cmp-selected",
            label: compareBase ? `Com ${compareBase.label} (selecionado)` : "Com o selecionado para comparação",
            icon: "compareWithSelected",
            disabled: !compareBase || compareBase.hash === row.hash,
            onSelect: () => compareBase && selectHash(row.hash, { kind: "revision", against: compareBase.hash, label: compareBase.label }),
          },
          { id: "cmp-sep", separator: true },
          {
            id: "cmp-select",
            label: "Selecionar para comparação",
            icon: "selectForCompare",
            onSelect: () => setCompareBase({ hash: row.hash, label: short }),
          },
        ],
      };
    },
    [compareBase, connId, headHash, onRun, refIndex, rootPath, selectHash]
  );

  const menuItemsFor = useCallback(
    (row: GraphRow): MenuItemSpec[] => {
      const a = actionsFor(row);
      const short = row.hash.slice(0, 7);
      const web = hosting ? commitWebUrl(hosting, row.hash) : null;
      return [
        { id: "details", label: "Mostrar detalhes", icon: "info", onSelect: () => selectHash(row.hash) },
        { id: "sep0", separator: true },
        ...a.branches.map((b) => ({
          id: `co-${b.ref}`,
          label: `Fazer checkout de ${b.label}`,
          icon: "gitBranch" as const,
          disabled: b.kind === "head",
          onSelect: () => a.checkoutBranch(b.ref),
        })),
        { id: "checkout", label: "Fazer checkout deste commit", icon: "target", disabled: row.hash === headHash, onSelect: a.checkout },
        { id: "branch", label: "Criar branch aqui…", icon: "gitBranch", onSelect: a.createBranch },
        { id: "cherry", label: "Cherry-pick no HEAD", icon: "cherryPick", disabled: row.hash === headHash, onSelect: a.cherryPick },
        { id: "revert", label: "Reverter commit…", icon: "discard", tone: "danger", onSelect: a.revert },
        { id: "sep1", separator: true },
        { id: "compare", label: "Comparar com…", icon: "gitCompare", submenu: a.compareItems() },
        { id: "sep2", separator: true },
        { id: "copy-hash", label: `Copiar hash (${short})`, icon: "copy", onSelect: () => copyText(row.hash) },
        { id: "copy-msg", label: "Copiar mensagem", icon: "copyPath", onSelect: () => copyText(row.subject) },
        ...(web && hosting
          ? [
              { id: "copy-link", label: "Copiar link do commit", icon: "copyPath" as const, onSelect: () => copyText(web) },
              { id: "open-web", label: `Abrir no ${hosting.label}`, icon: "linkExternal" as const, onSelect: () => openExternalUrl(web) },
            ]
          : []),
      ];
    },
    [actionsFor, headHash, hosting, selectHash]
  );

  const openMenuAt = useCallback(
    (row: GraphRow, x: number, y: number) => {
      setHover(null);
      setMenu({ anchor: { x, y }, items: menuItemsFor(row), label: `Ações do commit ${row.hash.slice(0, 7)}` });
    },
    [menuItemsFor]
  );

  // ---------------------------------------------------------------- linhas
  const onRowClick = useCallback(
    (index: number) => {
      setActiveIndex(index);
      const row = rows[index];
      if (!row) return;
      setSelected((cur) => (cur === row.hash && detailsMode.kind === "commit" ? null : row.hash));
      setDetailsMode({ kind: "commit" });
      setHover(null);
      listRef.current?.focus({ preventScroll: true });
    },
    [detailsMode.kind, rows]
  );

  const onRowContextMenu = useCallback(
    (index: number, event: ReactMouseEvent) => {
      event.preventDefault();
      setActiveIndex(index);
      const row = rows[index];
      if (row) openMenuAt(row, event.clientX, event.clientY);
    },
    [openMenuAt, rows]
  );

  const openCardForIndex = (index: number) => {
    const row = rows[index];
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!row || !el) return;
    const r = el.getBoundingClientRect();
    setHover({ hash: row.hash, anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, pointerX: null }, keyboard: true });
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const page = Math.max(1, Math.floor((viewport || ROW_H * 10) / ROW_H) - 1);
    const move = (to: number) => {
      const next = Math.max(0, Math.min(rows.length - 1, to));
      setActiveIndex(next);
      scrollToIndex(next);
      setHover(null);
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(activeIndex - 1);
        break;
      case "PageDown":
        e.preventDefault();
        move(activeIndex + page);
        break;
      case "PageUp":
        e.preventDefault();
        move(activeIndex - page);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(rows.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        onRowClick(activeIndex);
        break;
      case " ":
        e.preventDefault();
        if (hover) setHover(null);
        else openCardForIndex(activeIndex);
        break;
      case "i":
      case "I":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          openCardForIndex(activeIndex);
        }
        break;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) break;
        e.preventDefault();
        {
          const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
          const r = el?.getBoundingClientRect();
          const row = rows[activeIndex];
          if (row && r) openMenuAt(row, r.left + 24, r.bottom);
        }
        break;
      case "Escape":
        if (hover) setHover(null);
        else if (lineage) setLineage(null);
        else if (selected) setSelected(null);
        else return;
        e.preventDefault();
        break;
      default:
    }
  };

  const goToMatch = (dir: 1 | -1) => {
    if (!matchOrder.length) return;
    const next = (matchCursor + dir + matchOrder.length) % matchOrder.length;
    setMatchCursor(next);
    const index = indexOf.get(matchOrder[next]);
    if (index !== undefined) {
      setActiveIndex(index);
      scrollToIndex(index);
    }
  };

  // ---------------------------------------------------------------- menus da barra
  const [toolbarMenu, setToolbarMenu] = useState<MenuState>(null);
  const refsMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const branchRefs = (header?.refs ?? []).filter((x) => x.kind !== "tag");
    const toggle = (name: string) =>
      setStored((s) => {
        const set = new Set(s.refs === "selected" ? s.selected : header?.selectedRefs ?? []);
        if (set.has(name)) set.delete(name);
        else set.add(name);
        return { ...s, refs: "selected", selected: [...set] };
      });
    const items: MenuItemSpec[] = [
      ...(["auto", "current", "all"] as GraphRefMode[]).map((m) => ({
        id: m,
        label: MODE_LABEL[m],
        checked: stored.refs === m,
        title:
          m === "auto"
            ? "Branch atual, o upstream dela e a branch base"
            : m === "current"
              ? "Só a branch atual e o upstream"
              : "Branches locais, remotas e tags",
        onSelect: () => setStored((s) => ({ ...s, refs: m })),
      })),
      { id: "sep", separator: true },
      {
        id: "pick",
        label: stored.refs === "selected" ? `Selecionadas (${stored.selected.length})` : "Escolher branches…",
        checked: stored.refs === "selected",
        submenu: branchRefs.slice(0, 60).map((x) => ({
          id: `ref-${x.name}`,
          label: x.short,
          icon: x.kind === "remote" ? ("cloud" as const) : ("gitBranch" as const),
          checked: (stored.refs === "selected" ? stored.selected : header?.selectedRefs ?? []).includes(x.short),
          onSelect: () => toggle(x.short),
        })),
      },
    ];
    setToolbarMenu({ anchor: { x: r.left, y: r.bottom + 2 }, items, label: "Refs do grafo" });
  };

  const authors = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of rows.slice(0, 2000)) count.set(r.author, (count.get(r.author) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [rows]);

  const filtersMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItemSpec[] = [
      {
        id: "author",
        label: author ? `Autor: ${author}` : "Destacar autor",
        icon: "account",
        submenu: [
          { id: "any", label: "Qualquer autor", checked: !author, onSelect: () => setAuthor(null) },
          { id: "sep", separator: true },
          ...authors.map(([name, n]) => ({
            id: `a-${name}`,
            label: name,
            badge: String(n),
            checked: author === name,
            onSelect: () => setAuthor(name),
          })),
        ],
      },
      {
        id: "path",
        label: pathFilter ? `Caminho: ${pathFilter}` : "Filtrar por caminho…",
        icon: "folder",
        onSelect: () =>
          setInput({
            title: "Filtrar o grafo por caminho",
            placeholder: "src/git ou package.json",
            prompt: "Relativo à raiz do repositório. Vazio limpa o filtro.",
            submit: (value) => setPathFilter(value.trim() || null),
          }),
      },
      {
        id: "fp",
        label: "Só first-parent (linha principal)",
        checked: stored.firstParent,
        onSelect: () => setStored((s) => ({ ...s, firstParent: !s.firstParent })),
      },
      { id: "sep2", separator: true },
      {
        id: "clear",
        label: "Limpar filtros",
        icon: "clearAll",
        disabled: !author && !pathFilter && !stored.firstParent,
        onSelect: () => {
          setAuthor(null);
          setPathFilter(null);
          setStored((s) => ({ ...s, firstParent: false }));
        },
      },
    ];
    setToolbarMenu({ anchor: { x: r.left, y: r.bottom + 2 }, items, label: "Filtros do grafo" });
  };

  // ---------------------------------------------------------------- render
  const head = header?.head;
  const syncVisible = Boolean(head?.upstream && (head.ahead || head.behind));
  const hoverRow = hover ? rowOf(hover.hash) : undefined;
  const selectedRow = selected ? rowOf(selected) : undefined;
  const lineageSummary =
    lineage && typeof lineage.data === "object" && !("error" in lineage.data)
      ? summarizeLineage(lineage.data, (ms) => formatRelativeDateLong(ms))
      : null;
  const filtersOn = Boolean(author || pathFilter || stored.firstParent);
  const markerOf = (row: GraphRow): GraphNodeMarker =>
    row.hash === headHash ? "head" : incoming.has(row.hash) ? "incoming" : outgoing.has(row.hash) ? "outgoing" : "normal";
  const flowOf = (hash: string) => (incoming.has(hash) ? "incoming" : outgoing.has(hash) ? "outgoing" : null);
  const activeId = rows[activeIndex] ? `graph-row-${rows[activeIndex].hash}` : undefined;

  const rowsDom: JSX.Element[] = [];
  for (let i = win.start; i < win.end; i++) {
    const row = rows[i];
    const lay = layout[i];
    if (!row || !lay) continue;
    rowsDom.push(
      <GraphRowView
        key={row.hash}
        index={i}
        row={row}
        layout={lay}
        pills={refIndex.byHash.get(row.hash)}
        marker={markerOf(row)}
        flow={flowOf(row.hash)}
        selected={selected === row.hash}
        active={i === activeIndex}
        dimmed={Boolean((matches && !matches.has(row.hash)) || (pathSet && !pathSet.has(row.hash)))}
        lit={Boolean(pathSet?.has(row.hash))}
        lanes={lanes}
        maxLanes={maxLanes}
        laneWidth={laneWidth}
        path={pathSet}
        showMeta={showMeta}
        showAuthor={showAuthor}
        maxPills={inlinePills}
        isMe={Boolean(identity && (identity.email === row.authorEmail || identity.name === row.author))}
        activeLineageRef={lineage?.ref ?? null}
        onPointerEnter={onRowPointerEnter}
        onPointerLeave={scheduleClose}
        onClick={onRowClick}
        onContextMenu={onRowContextMenu}
        onPillEnter={onPillEnter}
        onPillLeave={onPillLeave}
        onPillClick={onPillClick}
      />
    );
  }

  const wide = width >= 760;
  const showFetch = Boolean(onFetch) && width >= 360;

  return (
    <div
      ref={rootRef}
      className={`commit-graph${wide ? " is-wide" : ""}${selectedRow ? " has-details" : ""}`}
      style={{ "--graph-lanes-width": `${LANE_GEOMETRY.padding * 2 + lanes * laneWidth}px` } as CSSProperties}
    >
      <div className="commit-graph-toolbar">
        <button
          type="button"
          className="commit-graph-refs-button"
          onClick={refsMenu}
          aria-haspopup="menu"
          aria-label={`Refs do grafo: ${stored.refs === "selected" ? MODE_LABEL.selected : MODE_LABEL[stored.refs]}`}
          title={header?.selectedRefs.length ? `Refs: ${header.selectedRefs.join(", ")}` : "Escolher as refs do grafo"}
        >
          <Codicon name="gitBranch" size={14} />
          {!narrow && (
            <span>{stored.refs === "selected" ? `${MODE_LABEL.selected} (${stored.selected.length})` : MODE_LABEL[stored.refs]}</span>
          )}
          <Codicon name="chevronDown" size={12} />
        </button>
        <SearchBox
          className="commit-graph-search"
          value={searchText}
          placeholder={narrow ? "Buscar" : "Buscar mensagem ou hash"}
          aria-label="Buscar commits no grafo"
          onChange={(e) => setSearchText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goToMatch(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape" && searchText) {
              e.preventDefault();
              setSearchText("");
            }
          }}
          contentAfter={
            matches && search ? (
              <span className="commit-graph-match-count" aria-live="polite">
                {matchOrder.length ? `${Math.min(matchCursor + 1, matchOrder.length)}/${matchOrder.length}` : "0"}
              </span>
            ) : undefined
          }
        />
        <IconButton
          icon="filter"
          size="sm"
          label="Filtros do grafo"
          pressed={filtersOn}
          onClick={filtersMenu}
        />
        {showFetch && (
          <IconButton icon="gitFetch" size="sm" label="Buscar do remoto (fetch)" disabled={busy} onClick={onFetch} />
        )}
        <IconButton icon="refresh" size="sm" label="Atualizar grafo" spin={graph.refreshing} onClick={graph.reload} />
      </div>

      {syncVisible && head && (
        <div className="commit-graph-banner is-sync" role="status">
          <Codicon name="sync" size={14} />
          <span className="commit-graph-banner-text">
            {head.behind > 0 && (
              <span className="graph-flow-chip is-incoming" title={`${head.behind} commits em ${head.upstream} que você não tem`}>
                <Codicon name="arrowDown" size={12} />
                {head.behind}
              </span>
            )}
            {head.ahead > 0 && (
              <span className="graph-flow-chip is-outgoing" title={`${head.ahead} commits locais ainda não enviados`}>
                <Codicon name="arrowUp" size={12} />
                {head.ahead}
              </span>
            )}
            <span className="commit-graph-banner-muted">em relação a {head.upstream}</span>
          </span>
          {head.behind > 0 && onPull && (
            <Button size="sm" variant="subtle" disabled={busy} onClick={onPull}>
              Puxar
            </Button>
          )}
          {head.ahead > 0 && onPush && (
            <Button size="sm" variant="subtle" disabled={busy} onClick={onPush}>
              Enviar
            </Button>
          )}
        </div>
      )}

      {lineage && (
        <div className={`commit-graph-banner is-lineage${lineage.pinned ? " is-pinned" : ""}`} role="status" aria-live="polite">
          <Codicon name="gitMerge" size={14} />
          <div className="commit-graph-banner-text">
            {lineage.data === "loading" ? (
              <span>Calculando a linhagem de {lineage.ref}…</span>
            ) : "error" in lineage.data ? (
              <span className="commit-hover-error">{lineage.data.error}</span>
            ) : lineageSummary ? (
              <>
                {lineageSummary.divergence && (
                  <button
                    type="button"
                    className="commit-graph-banner-link"
                    onClick={() => {
                      const l = lineage.data as BranchLineage;
                      if (l.mergeBase) selectHash(l.mergeBase);
                    }}
                  >
                    {lineageSummary.divergence}
                  </button>
                )}
                <span className="commit-graph-banner-muted">{lineageSummary.distance}</span>
                {lineageSummary.merged && (
                  <span className="commit-graph-banner-merged">
                    <button
                      type="button"
                      className="commit-graph-banner-link"
                      onClick={() => lineageSummary.mergeHash && selectHash(lineageSummary.mergeHash)}
                    >
                      {lineageSummary.merged}
                    </button>
                    {lineageSummary.pr && hosting && (
                      <a
                        className="commit-hover-link"
                        href={pullRequestWebUrl(hosting, lineageSummary.pr)}
                        onClick={(e) => {
                          e.preventDefault();
                          openExternalUrl(pullRequestWebUrl(hosting, lineageSummary.pr!));
                        }}
                      >
                        <Codicon name="gitPullRequest" size={12} /> PR #{lineageSummary.pr}
                      </a>
                    )}
                  </span>
                )}
              </>
            ) : null}
          </div>
          <IconButton icon="close" size="sm" label="Fechar linhagem" onClick={() => setLineage(null)} />
        </div>
      )}

      {(author || pathFilter || stored.firstParent || compareBase) && (
        <div className="commit-graph-chips" aria-label="Filtros ativos">
          {author && (
            <button type="button" className="commit-graph-chip" onClick={() => setAuthor(null)} aria-label={`Remover destaque do autor ${author}`}>
              <Codicon name="account" size={12} /> {author} <Codicon name="close" size={12} />
            </button>
          )}
          {pathFilter && (
            <button type="button" className="commit-graph-chip" onClick={() => setPathFilter(null)} aria-label={`Remover filtro de caminho ${pathFilter}`}>
              <Codicon name="folder" size={12} /> {pathFilter} <Codicon name="close" size={12} />
            </button>
          )}
          {stored.firstParent && (
            <button type="button" className="commit-graph-chip" onClick={() => setStored((s) => ({ ...s, firstParent: false }))}>
              first-parent <Codicon name="close" size={12} />
            </button>
          )}
          {compareBase && (
            <button type="button" className="commit-graph-chip" onClick={() => setCompareBase(null)} aria-label="Limpar seleção para comparação">
              <Codicon name="selectForCompare" size={12} /> comparar com {compareBase.label} <Codicon name="close" size={12} />
            </button>
          )}
        </div>
      )}

      <div className="commit-graph-body">
        <div
          ref={listRef}
          className="commit-graph-list"
          role="listbox"
          tabIndex={0}
          aria-label="Grafo de commits"
          aria-activedescendant={activeId}
          aria-busy={graph.loading || graph.refreshing}
          aria-description="Setas movem, Enter abre os detalhes, Espaço mostra o cartão do commit, Shift+F10 abre as ações"
          onScroll={onScroll}
          onKeyDown={onListKeyDown}
          onPointerLeave={scheduleClose}
        >
          {graph.error && !rows.length ? (
            <div className="commit-graph-empty is-error" role="alert">
              <Codicon name="error" size={16} />
              <span>Não foi possível carregar o grafo. {graph.error}</span>
              <Button size="sm" variant="subtle" onClick={graph.reload}>
                Tentar de novo
              </Button>
            </div>
          ) : !rows.length && graph.loading ? (
            <div className="commit-graph-skeleton" role="status" aria-label="Carregando commits…">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="commit-graph-skeleton-row" style={{ width: `${88 - i * 7}%` }} />
              ))}
            </div>
          ) : !rows.length ? (
            <div className="commit-graph-empty">
              {pathFilter ? `Nenhum commit tocou em ${pathFilter}.` : "Nenhum commit neste repositório ainda."}
            </div>
          ) : (
            <div className="commit-graph-spacer" style={{ height: win.total + (graph.hasMore ? ROW_H : 0) }}>
              <div className="commit-graph-window" style={{ transform: `translateY(${win.start * ROW_H}px)` }}>
                {rowsDom}
              </div>
              {graph.hasMore && (
                <div className="commit-graph-more" style={{ top: win.total }} role="status">
                  <Codicon name="loading" size={12} /> Carregando mais commits…
                </div>
              )}
            </div>
          )}
        </div>

        {selectedRow && (
          <CommitDetailsPanel
            key={`${selectedRow.hash}:${detailsMode.kind}`}
            row={selectedRow}
            rootPath={rootPath}
            connId={connId}
            mode={detailsMode}
            hosting={hosting}
            onClose={() => setSelected(null)}
            onSelectHash={(h) => selectHash(h)}
            onOpenRevisionDiff={onOpenRevisionDiff}
            onOpenRevision={onOpenRevision}
          />
        )}
      </div>

      {hover && hoverRow && (
        <CommitHoverCard
          row={hoverRow}
          rootPath={rootPath}
          connId={connId}
          anchor={hover.anchor}
          pills={refIndex.byHash.get(hoverRow.hash) ?? []}
          hosting={hosting}
          isHead={hoverRow.hash === headHash}
          flow={flowOf(hoverRow.hash)}
          focusOnOpen={hover.keyboard}
          actions={(() => {
            const a = actionsFor(hoverRow);
            return {
              checkout: () => (setHover(null), a.checkout()),
              createBranch: () => (setHover(null), a.createBranch()),
              cherryPick: () => (setHover(null), a.cherryPick()),
              revert: () => (setHover(null), a.revert()),
              compare: (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHover(null);
                setMenu({ anchor: { x: r.left, y: r.bottom + 2 }, items: a.compareItems(), label: "Comparar com" });
              },
              more: (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openMenuAt(hoverRow, r.left, r.bottom + 2);
              },
            };
          })()}
          onPointerEnter={keepOpen}
          onPointerLeave={scheduleClose}
          onClose={(restore) => {
            setHover(null);
            if (restore) listRef.current?.focus();
          }}
        />
      )}

      {(menu || toolbarMenu) && (
        <Menu
          ariaLabel={(menu ?? toolbarMenu)!.label}
          anchor={(menu ?? toolbarMenu)!.anchor}
          items={(menu ?? toolbarMenu)!.items}
          minWidth={220}
          onClose={() => {
            setMenu(null);
            setToolbarMenu(null);
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog<boolean>
          title={confirm.title}
          message={confirm.message}
          buttons={[
            { label: "Cancelar", variant: "secondary", value: false },
            { label: confirm.confirm, variant: confirm.danger ? "danger" : "primary", value: true, default: true },
          ]}
          onChoice={(ok) => {
            const run = confirm.run;
            setConfirm(null);
            if (ok) run();
          }}
        />
      )}

      {input && (
        <QuickInput
          title={input.title}
          placeholder={input.placeholder}
          prompt={input.prompt}
          onSubmit={(value) => {
            const submit = input.submit;
            setInput(null);
            submit(value);
          }}
          onClose={() => setInput(null)}
        />
      )}
    </div>
  );
}

interface GraphRowViewProps {
  index: number;
  row: GraphRow;
  layout: GraphRowLayout;
  pills: RefPill[] | undefined;
  marker: GraphNodeMarker;
  flow: "incoming" | "outgoing" | null;
  selected: boolean;
  active: boolean;
  dimmed: boolean;
  lit: boolean;
  lanes: number;
  maxLanes: number;
  laneWidth: number;
  path: ReadonlySet<string> | null;
  showMeta: boolean;
  showAuthor: boolean;
  maxPills: number;
  isMe: boolean;
  activeLineageRef: string | null;
  onPointerEnter: (hash: string, el: HTMLElement, pointerX: number) => void;
  onPointerLeave: () => void;
  onClick: (index: number) => void;
  onContextMenu: (index: number, event: ReactMouseEvent) => void;
  onPillEnter: (pill: RefPill) => void;
  onPillLeave: (pill: RefPill) => void;
  onPillClick: (pill: RefPill) => void;
}

const GraphRowView = memo(function GraphRowView({
  index,
  row,
  layout,
  pills,
  marker,
  flow,
  selected,
  active,
  dimmed,
  lit,
  lanes,
  maxLanes,
  laneWidth,
  path,
  showMeta,
  showAuthor,
  maxPills,
  isMe,
  activeLineageRef,
  onPointerEnter,
  onPointerLeave,
  onClick,
  onContextMenu,
  onPillEnter,
  onPillLeave,
  onPillClick,
}: GraphRowViewProps) {
  const when = row.authorTime * 1000;
  const shown = pills?.slice(0, maxPills) ?? [];
  const extra = (pills?.length ?? 0) - shown.length;
  return (
    <div
      id={`graph-row-${row.hash}`}
      data-index={index}
      role="option"
      aria-selected={selected}
      aria-setsize={-1}
      aria-posinset={index + 1}
      aria-label={`${row.subject}, ${row.author}, ${formatRelativeDate(when)}${pills?.length ? `, refs ${pills.map((p) => p.label).join(", ")}` : ""}`}
      className={`commit-graph-row${selected ? " is-selected" : ""}${active ? " is-active" : ""}${dimmed ? " is-dim" : ""}${
        lit ? " is-lit" : ""
      }${marker === "head" ? " is-head" : ""}${flow ? ` is-${flow}` : ""}`}
      onPointerEnter={(e) => onPointerEnter(row.hash, e.currentTarget, e.clientX)}
      onPointerLeave={onPointerLeave}
      onClick={() => onClick(index)}
      onContextMenu={(e) => onContextMenu(index, e)}
    >
      <GraphLanes row={layout} lanes={lanes} maxLanes={maxLanes} marker={marker} path={path} laneWidth={laneWidth} />
      <span className="commit-graph-subject">
        {flow === "incoming" && <Codicon name="arrowDown" size={12} className="commit-graph-flow is-incoming" />}
        {flow === "outgoing" && <Codicon name="arrowUp" size={12} className="commit-graph-flow is-outgoing" />}
        <span className="commit-graph-subject-text">{row.subject}</span>
      </span>
      {shown.length > 0 && (
        <span className="commit-graph-pills">
          {shown.map((p) => (
            <RefPillView
              key={p.key}
              pill={p}
              active={activeLineageRef === p.ref}
              onEnter={onPillEnter}
              onLeave={onPillLeave}
              onClick={onPillClick}
            />
          ))}
          {extra > 0 && (
            <span className="graph-ref-more" title={pills!.slice(maxPills).map((p) => p.label).join(", ")}>
              +{extra}
            </span>
          )}
        </span>
      )}
      {showMeta && (
        <span className="commit-graph-meta">
          {showAuthor && <span className="commit-graph-author">{isMe ? "Você" : formatAuthor(row.author, 16)}</span>}
          <GitAvatar name={row.author} email={row.authorEmail} className="commit-avatar is-xs" size={32} />
          <span className="commit-graph-date" title={formatAbsoluteDate(when)}>
            {formatRelativeDate(when)}
          </span>
        </span>
      )}
    </div>
  );
});
