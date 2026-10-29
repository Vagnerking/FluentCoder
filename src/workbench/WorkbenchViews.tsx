import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useWorkbenchDrag } from "./useWorkbenchDrag";
import {
  activeViewIn,
  loadViewLayout,
  moveView,
  regionOfView,
  resetViewLayout,
  saveViewLayout,
  setActiveView,
  viewsInRegion,
  type ViewLayoutState,
} from "./viewLayout";
import { viewRegistry, VIEW_REGIONS, type ViewDescriptor, type ViewRegion } from "./viewRegistry";
import { viewNode } from "./viewNodes";
import { dropTargetAt, virtualZones, type DropTarget, type DropZone, type Rect } from "./viewDrop";
import { ViewDropOverlay } from "./ViewDropOverlay";

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface ViewDragState {
  viewId: string;
  x: number;
  y: number;
  zones: DropZone[];
  target: DropTarget | null;
}

export interface WorkbenchViewsApi {
  descriptors: readonly ViewDescriptor[];
  layout: ViewLayoutState;
  /** Região efetivamente visível (aberta e não recolhida pela falta de espaço). */
  regionVisible: Record<ViewRegion, boolean>;
  views(region: ViewRegion): ViewDescriptor[];
  active(region: ViewRegion): string | null;
  regionOf(id: string): ViewRegion | null;
  isVisible(id: string): boolean;
  /** Torna a view a ativa da região dela (sem abrir a região). */
  activate(id: string): void;
  /** Abre a região da view e a torna ativa. Retorna a região. */
  reveal(id: string): ViewRegion | null;
  /** Move a view (abre a região de destino). */
  move(id: string, region: ViewRegion, index?: number): void;
  resetLayout(): void;
  badges: Readonly<Record<string, number | undefined>>;
  /** pointerdown numa aba/cabeçalho de view: arrasta depois de 5 px. */
  beginViewDrag(e: ReactPointerEvent<HTMLElement>, id: string): void;
  /** True logo após um arraste (o click que o encerra deve ser ignorado). */
  consumeDragClick(): boolean;
  setRegionBody(region: ViewRegion, el: HTMLElement | null): void;
  setRegionToolbar(region: ViewRegion, el: HTMLElement | null): void;
  toolbar(region: ViewRegion): HTMLElement | null;
  hoverView(id: string): void;
}

/** Estado do arraste fora do React do provider: mover o ponteiro não re-renderiza as views. */
function createDragStore() {
  let value: ViewDragState | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: ViewDragState | null) {
      value = next;
      for (const l of listeners) l();
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
const dragStore = createDragStore();

/** Arraste de view em andamento (zonas, alvo, posição) — para overlays/abas. */
export function useViewDragState(): ViewDragState | null {
  return useSyncExternalStore(dragStore.subscribe, dragStore.get, dragStore.get);
}

const Ctx = createContext<WorkbenchViewsApi | null>(null);
const ViewIdCtx = createContext<string | null>(null);

export function useWorkbenchViews(): WorkbenchViewsApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useWorkbenchViews fora do WorkbenchViewsProvider");
  return api;
}

/** Id da view em cujo conteúdo o componente está (null fora de uma view). */
export function useCurrentViewId(): string | null {
  return useContext(ViewIdCtx);
}

export function useViewDescriptors(): readonly ViewDescriptor[] {
  return useSyncExternalStore(viewRegistry.subscribe, viewRegistry.list, viewRegistry.list);
}

export interface ViewLayoutController {
  descriptors: readonly ViewDescriptor[];
  layout: ViewLayoutState;
  regionVisible: Record<ViewRegion, boolean>;
  visibleSet: ReadonlySet<string>;
  views(region: ViewRegion): ViewDescriptor[];
  active(region: ViewRegion): string | null;
  regionOf(id: string): ViewRegion | null;
  isVisible(id: string): boolean;
  activate(id: string): void;
  reveal(id: string): ViewRegion | null;
  move(id: string, region: ViewRegion, index?: number): void;
  resetLayout(): void;
}

/**
 * Estado do layout das views (persistido em `ui.viewLayout`, com migração das
 * preferências antigas) + as ações. Vive no App (que precisa saber a view ativa
 * da primária para a activity bar) e é entregue ao provider.
 */
export function useViewLayoutController(opts: {
  /** Região aberta pelo usuário E com espaço (não recolhida). */
  regionVisible: Record<ViewRegion, boolean>;
  /** Pedido para abrir uma região (reveal/move). */
  openRegion: (region: ViewRegion) => void;
}): ViewLayoutController {
  const { regionVisible } = opts;
  const descriptors = useViewDescriptors();
  const [layout, setLayout] = useState<ViewLayoutState>(() => loadViewLayout(storage()));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const descsRef = useRef(descriptors);
  descsRef.current = descriptors;
  const openRegionRef = useRef(opts.openRegion);
  openRegionRef.current = opts.openRegion;

  useEffect(() => saveViewLayout(storage(), layout), [layout]);

  const visibleSet = useMemo(() => {
    const set = new Set<string>();
    for (const region of VIEW_REGIONS) {
      if (!regionVisible[region]) continue;
      const id = activeViewIn(layout, descriptors, region);
      if (id) set.add(id);
    }
    return set;
  }, [layout, descriptors, regionVisible]);

  const move = useCallback((id: string, region: ViewRegion, index?: number) => {
    setLayout((s) => moveView(s, descsRef.current, id, region, index));
    openRegionRef.current(region);
  }, []);

  const reveal = useCallback((id: string): ViewRegion | null => {
    const region = regionOfView(layoutRef.current, descsRef.current, id);
    if (!region) return null;
    setLayout((s) => setActiveView(s, region, id));
    openRegionRef.current(region);
    return region;
  }, []);

  const activate = useCallback((id: string) => {
    const region = regionOfView(layoutRef.current, descsRef.current, id);
    if (region) setLayout((s) => setActiveView(s, region, id));
  }, []);

  const resetLayout = useCallback(() => setLayout(resetViewLayout()), []);

  return useMemo<ViewLayoutController>(
    () => ({
      descriptors,
      layout,
      regionVisible,
      visibleSet,
      views: (region) => viewsInRegion(layout, descriptors, region),
      active: (region) => activeViewIn(layout, descriptors, region),
      regionOf: (id) => regionOfView(layout, descriptors, id),
      isVisible: (id) => visibleSet.has(id),
      activate,
      reveal,
      move,
      resetLayout,
    }),
    [descriptors, layout, regionVisible, visibleSet, activate, reveal, move, resetLayout],
  );
}

interface ProviderProps {
  controller: ViewLayoutController;
  /** Conteúdo de cada view. `visible` = ativa numa região visível. */
  renderView: (id: string, visible: boolean) => ReactNode;
  badges?: Record<string, number | undefined>;
  /** Contexto para as faixas virtuais das regiões fechadas. */
  sidebarSide: "left" | "right";
  panelPos: "bottom" | "left" | "right";
  /** Ponteiro sobre a aba de uma view (ex.: pré-ativar a extensão). */
  onHoverView?: (id: string) => void;
  children: ReactNode;
}

/**
 * Hospedeiro das views: conteúdo de cada view num nó DOM persistente (portal)
 * e a reconciliação que anexa esses nós ao corpo da região certa (ou ao
 * estacionamento oculto quando a região está desmontada). Também conduz o
 * arraste de views entre regiões.
 */
export function WorkbenchViewsProvider({
  controller,
  renderView,
  badges = {},
  sidebarSide,
  panelPos,
  onHoverView,
  children,
}: ProviderProps) {
  const { descriptors, layout, regionVisible, visibleSet, activate, reveal, move } = controller;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const descsRef = useRef(descriptors);
  descsRef.current = descriptors;
  const hoverRef = useRef(onHoverView);
  hoverRef.current = onHoverView;
  const bodies = useRef(new Map<ViewRegion, HTMLElement>());
  const parkingRef = useRef<HTMLDivElement>(null);
  const [toolbars, setToolbars] = useState<Partial<Record<ViewRegion, HTMLElement>>>({});
  const suppressClick = useRef(0);
  const wb = useWorkbenchDrag();
  const geometryRef = useRef({ sidebarSide, panelPos, regionVisible });
  geometryRef.current = { sidebarSide, panelPos, regionVisible };

  const visibleRef = useRef(visibleSet);
  visibleRef.current = visibleSet;

  /** Anexa cada nó ao corpo da sua região (ou estaciona) e liga/desliga `hidden`. */
  const reconcile = useCallback(() => {
    const parking = parkingRef.current;
    for (const d of descsRef.current) {
      const region = regionOfView(layoutRef.current, descsRef.current, d.id);
      const node = viewNode(d.id);
      const body = (region && bodies.current.get(region)) || parking;
      if (body && node.parentElement !== body) body.appendChild(node);
      const visible = visibleRef.current.has(d.id);
      if (node.hidden === visible) node.hidden = !visible;
      node.dataset.region = region ?? "";
    }
  }, []);

  useLayoutEffect(() => {
    reconcile();
  });

  const setRegionBody = useCallback(
    (region: ViewRegion, el: HTMLElement | null) => {
      if (el) bodies.current.set(region, el);
      else bodies.current.delete(region);
      reconcile();
    },
    [reconcile],
  );

  const setRegionToolbar = useCallback((region: ViewRegion, el: HTMLElement | null) => {
    setToolbars((cur) => (cur[region] === (el ?? undefined) ? cur : { ...cur, [region]: el ?? undefined }));
  }, []);

  const collectZones = useCallback((): DropZone[] => {
    const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });
    const zones: DropZone[] = [];
    const g = geometryRef.current;
    for (const el of document.querySelectorAll<HTMLElement>("[data-workbench-region]")) {
      const region = el.dataset.workbenchRegion as ViewRegion;
      if (!g.regionVisible[region]) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const tabs = [...el.querySelectorAll<HTMLElement>("[data-view-tab]")].map((t) => ({
        id: t.dataset.viewTab!,
        rect: toRect(t.getBoundingClientRect()),
      }));
      zones.push({ region, rect: toRect(r), virtual: false, tabs });
    }
    const body = document.querySelector<HTMLElement>(".app > .body");
    const editor = document.querySelector<HTMLElement>(".editor-area");
    if (body && editor) {
      zones.push(
        ...virtualZones({
          body: toRect(body.getBoundingClientRect()),
          editor: toRect(editor.getBoundingClientRect()),
          open: g.regionVisible,
          sidebarSide: g.sidebarSide,
          panelPos: g.panelPos,
        }),
      );
    }
    return zones;
  }, []);

  const beginViewDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, id: string) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const pointerId = e.pointerId;
      const source = e.currentTarget;
      const pre = (me: PointerEvent) => {
        if (Math.hypot(me.clientX - sx, me.clientY - sy) < 5) return;
        cleanup();
        const zones = collectZones();
        const first: ViewDragState = { viewId: id, x: me.clientX, y: me.clientY, zones, target: dropTargetAt(zones, me.clientX, me.clientY, id) };
        dragStore.set(first);
        wb.pointer({
          kind: "view",
          cursor: "grabbing",
          captureTarget: source,
          pointerId,
          onMove: (m) => {
            const cur = dragStore.get();
            if (!cur) return;
            dragStore.set({ ...cur, x: m.clientX, y: m.clientY, target: dropTargetAt(cur.zones, m.clientX, m.clientY, id) });
          },
          onEnd: (committed) => {
            const cur = dragStore.get();
            dragStore.set(null);
            // O click que fecha o arraste não deve selecionar a aba de origem.
            suppressClick.current = performance.now();
            if (committed && cur?.target) move(id, cur.target.region, cur.target.index);
          },
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", pre);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
      };
      window.addEventListener("pointermove", pre);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [collectZones, move, wb],
  );

  const api = useMemo<WorkbenchViewsApi>(
    () => ({
      descriptors,
      layout,
      regionVisible,
      views: (region) => viewsInRegion(layout, descriptors, region),
      active: (region) => activeViewIn(layout, descriptors, region),
      regionOf: (id) => regionOfView(layout, descriptors, id),
      isVisible: (id) => visibleSet.has(id),
      activate,
      reveal,
      move,
      resetLayout: controller.resetLayout,
      badges,
      beginViewDrag,
      consumeDragClick: () => performance.now() - suppressClick.current < 400,
      setRegionBody,
      setRegionToolbar,
      toolbar: (region) => toolbars[region] ?? null,
      hoverView: (id) => hoverRef.current?.(id),
    }),
    [descriptors, layout, regionVisible, visibleSet, activate, reveal, move, controller.resetLayout, badges, beginViewDrag, setRegionBody, setRegionToolbar, toolbars],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="workbench-view-parking" ref={parkingRef} hidden aria-hidden="true" />
      {descriptors.map((d) => {
        const visible = visibleSet.has(d.id);
        if (!visible && !d.retainWhenHidden) return null;
        return createPortal(<ViewIdCtx.Provider value={d.id}>{renderView(d.id, visible)}</ViewIdCtx.Provider>, viewNode(d.id), d.id);
      })}
      <ViewDropOverlay descriptors={descriptors} />
    </Ctx.Provider>
  );
}

/**
 * Ações da view no cabeçalho da região que a hospeda (como os botões do
 * `view/title` do VS Code). Só aparecem quando a view é a ativa da região.
 */
export function ViewToolbar({ children }: { children: ReactNode }) {
  const id = useCurrentViewId();
  const api = useContext(Ctx);
  if (!id || !api) return null;
  const region = api.regionOf(id);
  if (!region || api.active(region) !== id) return null;
  const slot = api.toolbar(region);
  return slot ? createPortal(children, slot) : null;
}
