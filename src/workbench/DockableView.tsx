import { useCallback, useRef, useState, type ReactNode } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Menu, type MenuItemSpec } from "../components/ui/Menu";
import { Tabs, type TabsItem } from "../components/ui/Tabs";
import { isRegionAllowed, REGION_LABELS, VIEW_REGIONS, type ViewRegion } from "./viewRegistry";
import { useViewDragState, useWorkbenchViews, type WorkbenchViewsApi } from "./WorkbenchViews";
import { ViewIconGlyph } from "./ViewIconGlyph";

/** "Mover para…" de uma view: as três regiões (a atual marcada e inativa). */
export function viewMoveMenuItems(api: Pick<WorkbenchViewsApi, "descriptors" | "regionOf" | "move">, id: string): MenuItemSpec[] {
  const desc = api.descriptors.find((d) => d.id === id);
  if (!desc) return [];
  const current = api.regionOf(id);
  return [
    {
      id: `move:${id}`,
      label: "Mover para…",
      icon: "moveView",
      submenu: VIEW_REGIONS.map((region) => ({
        id: `move:${id}:${region}`,
        label: REGION_LABELS[region],
        checked: current === region,
        disabled: current === region || !isRegionAllowed(desc, region),
        onSelect: () => api.move(id, region),
      })),
    },
  ];
}

type OpenMenu = { id: string; anchor: { x: number; y: number } | { rect: DOMRect; placement: "bottom-start" } } | null;

interface TabsProps {
  region: ViewRegion;
  ariaLabel: string;
  /** Itens extras no fim do menu de contexto de cada aba. */
  extraMenuItems?: (id: string) => MenuItemSpec[];
}

/**
 * Abas das views de uma região (sidebar secundária, painel). Cada aba é uma
 * view do registro: clique ativa, arrastar (5 px) move entre regiões/reordena
 * com indicadores de soltura, botão direito abre "Mover para…". Teclado: o
 * tablist do primitivo `Tabs` (←/→/Home/End); mover pelo teclado = menu.
 */
export function DockableViewTabs({ region, ariaLabel, extraMenuItems }: TabsProps) {
  const api = useWorkbenchViews();
  const drag = useViewDragState();
  const [menu, setMenu] = useState<OpenMenu>(null);
  const views = api.views(region);
  const active = api.active(region);
  if (views.length === 0) return null;

  const items: TabsItem[] = views.map((d) => ({
    value: d.id,
    icon: "codicon" in d.icon ? d.icon.codicon : undefined,
    label:
      "src" in d.icon ? (
        <span className="view-tab-label">
          <ViewIconGlyph icon={d.icon} size={14} className="view-tab-img" />
          <span className="view-tab-text">{d.title}</span>
        </span>
      ) : (
        <span className="view-tab-text">{d.title}</span>
      ),
    badge: api.badges[d.id] || undefined,
  }));

  const menuItems = (id: string): MenuItemSpec[] => [...viewMoveMenuItems(api, id), ...(extraMenuItems?.(id) ?? [])];

  return (
    <>
      <Tabs
        className="view-tabs"
        ariaLabel={ariaLabel}
        size="sm"
        items={items}
        value={active ?? ""}
        onChange={(id) => {
          if (!api.consumeDragClick()) api.activate(id);
        }}
        tabProps={(item) => ({
          "data-view-tab": item.value,
          // Em regiões estreitas a aba inativa fica só com o ícone: o nome
          // continua no aria-label e no title.
          "aria-label": views.find((d) => d.id === item.value)?.title,
          title: views.find((d) => d.id === item.value)?.title,
          className: `view-tab${drag?.viewId === item.value ? " is-dragging" : ""}`,
          onPointerDown: (e) => api.beginViewDrag(e, item.value),
          onPointerEnter: () => api.hoverView(item.value),
          onFocus: () => api.hoverView(item.value),
          onContextMenu: (e) => {
            e.preventDefault();
            setMenu({ id: item.value, anchor: { x: e.clientX, y: e.clientY } });
          },
          onKeyDownCapture: (e) => {
            // Shift+F10 / tecla de menu: o mesmo menu de contexto pelo teclado.
            if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
              e.preventDefault();
              setMenu({ id: item.value, anchor: { rect: e.currentTarget.getBoundingClientRect(), placement: "bottom-start" } });
            }
          },
        })}
      />
      {menu && (
        <Menu
          ariaLabel="Ações da view"
          anchor={menu.anchor}
          items={menuItems(menu.id)}
          minWidth={220}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Botão "…" com o menu da view (Mover para…, extras). */
export function ViewMoreButton({ viewId, extraItems = [], label = "Mais ações da view" }: { viewId: string; extraItems?: MenuItemSpec[]; label?: string }) {
  const api = useWorkbenchViews();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={btn}
        icon="more"
        size="sm"
        label={label}
        tooltipPlacement="bottom"
        aria-haspopup="menu"
        aria-expanded={!!rect}
        onClick={(e) => setRect((cur) => (cur ? null : e.currentTarget.getBoundingClientRect()))}
      />
      {rect && (
        <Menu
          ariaLabel={label}
          anchor={{ rect, placement: "bottom-start" }}
          items={[...viewMoveMenuItems(api, viewId), ...extraItems]}
          minWidth={220}
          isInside={(t) => !!btn.current?.contains(t)}
          onClose={() => setRect(null)}
        />
      )}
    </>
  );
}

/**
 * Cabeçalho de uma view "convidada" na barra lateral primária (Fluent Chat,
 * Claude Code… movidos para lá): título arrastável + ações da view + "…".
 * As views nativas da primária têm cabeçalho próprio e a activity bar.
 */
export function DockableViewHeader({ viewId, children }: { viewId: string; children?: ReactNode }) {
  const api = useWorkbenchViews();
  const desc = api.descriptors.find((d) => d.id === viewId);
  const region = api.regionOf(viewId);
  const { setRegionToolbar } = api;
  const toolbarRef = useCallback((el: HTMLDivElement | null) => region && setRegionToolbar(region, el), [region, setRegionToolbar]);
  if (!desc || !region) return null;
  return (
    <div className="view-header" data-view-tab={viewId}>
      <div
        className="view-header-title"
        onPointerDown={(e) => api.beginViewDrag(e, viewId)}
        title="Arraste para mover a view"
      >
        <ViewIconGlyph icon={desc.icon} size={14} />
        <span>{desc.title}</span>
      </div>
      <div className="view-container-toolbar" ref={toolbarRef} />
      {children}
      <ViewMoreButton viewId={viewId} />
    </div>
  );
}
