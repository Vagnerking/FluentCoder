import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import type { MenuItemSpec } from "../components/ui/Menu";
import { DockableViewHeader, DockableViewTabs, ViewMoreButton } from "./DockableView";
import type { ViewRegion } from "./viewRegistry";
import { useWorkbenchViews } from "./WorkbenchViews";

interface Props {
  region: ViewRegion;
  /**
   * `tabs` = tablist das views (sidebar secundária, painel). `none` = sem
   * cabeçalho próprio (a primária usa a activity bar; views convidadas lá
   * ganham um cabeçalho de título arrastável).
   */
  chrome: "tabs" | "none";
  ariaLabel: string;
  /** Fim do cabeçalho (ex.: fechar o painel). */
  headerEnd?: ReactNode;
  /** pointerdown na área vazia do cabeçalho (ex.: reposicionar o painel). */
  onHeaderPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  /** mousedown nativo (captura) em qualquer ponto da região, inclusive no conteúdo das views. */
  onNativeMouseDownCapture?: () => void;
  /** Views que pedem cabeçalho de título nesta região (convidadas da primária). */
  guestViews?: ReadonlySet<string>;
  /** Itens extras do menu de cada aba. */
  extraMenuItems?: (id: string) => MenuItemSpec[];
  /** Conteúdo quando a região não tem nenhuma view. */
  empty?: ReactNode;
  className?: string;
}

/**
 * Uma região do workbench que hospeda views do registro. O conteúdo de cada
 * view NÃO é filho React daqui: é um nó persistente (portal do provider) que a
 * reconciliação anexa ao corpo desta região — mover a view só reanexa o nó.
 */
export function ViewContainer({
  region,
  chrome,
  ariaLabel,
  headerEnd,
  onHeaderPointerDown,
  onNativeMouseDownCapture,
  guestViews,
  extraMenuItems,
  empty,
  className,
}: Props) {
  const api = useWorkbenchViews();
  const { setRegionBody, setRegionToolbar } = api;
  const views = api.views(region);
  const active = api.active(region);
  const rootRef = useRef<HTMLElement>(null);
  // Refs estáveis: um callback novo a cada render faria a reconciliação
  // estacionar e reanexar os nós (perdendo foco) em todo render.
  const bodyRef = useCallback((el: HTMLDivElement | null) => setRegionBody(region, el), [region, setRegionBody]);
  const toolbarRef = useCallback((el: HTMLDivElement | null) => setRegionToolbar(region, el), [region, setRegionToolbar]);

  const mouseDown = useRef(onNativeMouseDownCapture);
  mouseDown.current = onNativeMouseDownCapture;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fn = () => mouseDown.current?.();
    el.addEventListener("mousedown", fn, true);
    return () => el.removeEventListener("mousedown", fn, true);
  }, []);

  const guest = chrome === "none" && active && guestViews?.has(active) ? active : null;

  return (
    <section
      ref={rootRef}
      className={`view-container view-container-${region}${className ? ` ${className}` : ""}`}
      data-workbench-region={region}
      aria-label={ariaLabel}
    >
      {chrome === "tabs" && (
        <div
          className="view-container-header"
          onPointerDown={(e) => {
            if (!onHeaderPointerDown) return;
            if ((e.target as HTMLElement).closest("[role=tab], button, .view-container-toolbar")) return;
            onHeaderPointerDown(e);
          }}
        >
          <DockableViewTabs region={region} ariaLabel={ariaLabel} extraMenuItems={extraMenuItems} />
          <div className="view-container-toolbar" ref={toolbarRef} />
          {active && <ViewMoreButton viewId={active} extraItems={extraMenuItems?.(active)} />}
          {headerEnd}
        </div>
      )}
      {guest && <DockableViewHeader viewId={guest} />}
      <div className="view-container-body" ref={bodyRef} />
      {views.length === 0 && empty}
    </section>
  );
}
