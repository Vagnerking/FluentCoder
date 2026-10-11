import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { solveLayout, touchLru, type LayoutResult } from "./layoutConstraints";
import type { ViewRegion } from "./viewRegistry";

/** Mínimo garantido ao editor (px CSS), somadas todas as regiões abertas. */
export const EDITOR_MIN = { width: 400, height: 160 };
/** Vão entre regiões vizinhas (gap do `.body` + alça). */
const REGION_GAP = 8;
/** Cromo horizontal fixo: margens do `.body` (16) + bordas do editor (2). */
const CHROME_H = 18;
/** Activity bar lateral (48) + vão (8). */
const ACTIVITY_W = 56;
/** Title bar (32) + status bar (24) + margens do `.body` (6) + bordas/alça do painel (6). */
const CHROME_V = 68;

export interface WorkbenchLayoutOptions {
  uiScale: number;
  open: Record<ViewRegion, boolean>;
  /** Tamanhos preferidos (preferências salvas; o solver nunca os altera). */
  sizes: { primary: number; secondary: number; panelHeight: number; panelWidth: number };
  mins: { primary: number; secondary: number; panelHeight: number; panelWidth: number };
  panelPos: "bottom" | "left" | "right";
  /** Activity bar lateral ocupa largura própria; no topo/base ela fica dentro do dock. */
  activitySide: boolean;
}

export interface WorkbenchLayout {
  result: LayoutResult;
  /** Visível no fluxo OU reaberta como sobreposição. */
  regionVisible: Record<ViewRegion, boolean>;
  /** Região recolhida que está aberta como sobreposição (no máximo uma). */
  overlay: ViewRegion | null;
  showOverlay(region: ViewRegion): void;
  dismissOverlay(): void;
  /** Marca a região como usada agora (LRU). */
  touch(region: ViewRegion): void;
  /**
   * O usuário acabou de abrir a região: vira a mais recente (sai a menos usada
   * das outras) e, se nem assim couber, reabre como sobreposição.
   */
  markOpened(region: ViewRegion): void;
  /** Tamanho da região em sobreposição (preferência, sem invadir a janela). */
  overlaySize(region: ViewRegion): number;
  viewport: { width: number; height: number };
}

function readViewport(scale: number) {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  const s = scale > 0 ? scale : 1;
  return { width: window.innerWidth / s, height: window.innerHeight / s };
}

/**
 * Layout responsivo do workbench: mede a janela (÷ zoom da UI), acompanha a
 * ordem de uso das regiões (LRU: ponteiro/foco dentro de cada uma) e resolve
 * tamanhos/recolhimentos com `solveLayout`. Recolher é temporário: as
 * preferências (aberta, largura) não mudam; a região pode voltar como
 * sobreposição e retorna ao fluxo sozinha quando houver espaço.
 */
export function useWorkbenchLayout(opts: WorkbenchLayoutOptions): WorkbenchLayout {
  const { uiScale, open, sizes, mins, panelPos, activitySide } = opts;
  const [viewport, setViewport] = useState(() => readViewport(uiScale));
  const [lru, setLru] = useState<ViewRegion[]>(["secondarySidebar", "panel", "primarySidebar"]);
  const [overlay, setOverlay] = useState<ViewRegion | null>(null);

  useEffect(() => {
    const update = () => setViewport(readViewport(uiScale));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [uiScale]);

  const touch = useCallback((region: ViewRegion) => setLru((cur) => touchLru(cur, region)), []);

  // Uso = ponteiro/foco dentro da região (não conta a sobreposição: usá-la não
  // deve tirar outra região do lugar enquanto o usuário interage).
  useEffect(() => {
    const onUse = (e: Event) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-workbench-region]") : null;
      if (!el || el.closest("[data-region-overlay]")) return;
      touch(el.dataset.workbenchRegion as ViewRegion);
    };
    document.addEventListener("pointerdown", onUse, true);
    document.addEventListener("focusin", onUse, true);
    return () => {
      document.removeEventListener("pointerdown", onUse, true);
      document.removeEventListener("focusin", onUse, true);
    };
  }, [touch]);

  const result = useMemo(
    () =>
      solveLayout({
        viewport,
        chrome: { horizontal: CHROME_H + (activitySide ? ACTIVITY_W : 0), vertical: CHROME_V },
        gap: REGION_GAP,
        regions: {
          primarySidebar: { open: open.primarySidebar, size: sizes.primary, min: mins.primary, max: viewport.width * 0.6 },
          secondarySidebar: { open: open.secondarySidebar, size: sizes.secondary, min: mins.secondary, max: viewport.width * 0.7 },
          panel:
            panelPos === "bottom"
              ? { open: open.panel, size: sizes.panelHeight, min: mins.panelHeight, max: viewport.height * 0.7 }
              : { open: open.panel, size: sizes.panelWidth, min: mins.panelWidth, max: viewport.width * 0.7 },
        },
        panelOrientation: panelPos === "bottom" ? "bottom" : "side",
        // Em janelas pequenas o mínimo do editor acompanha a janela (metade da área
        // útil), para ainda caber uma barra lateral ao lado dele.
        editorMin: {
          width: Math.min(EDITOR_MIN.width, Math.round((viewport.width - CHROME_H - (activitySide ? ACTIVITY_W : 0)) * 0.5)),
          height: Math.min(EDITOR_MIN.height, Math.round((viewport.height - CHROME_V) * 0.4)),
        },
        lru,
      }),
    [viewport, activitySide, open.primarySidebar, open.secondarySidebar, open.panel, sizes.primary, sizes.secondary, sizes.panelHeight, sizes.panelWidth, mins.primary, mins.secondary, mins.panelHeight, mins.panelWidth, panelPos, lru],
  );

  // Abriu e não coube nem sozinha: mostra como sobreposição.
  const pendingOpen = useRef<ViewRegion | null>(null);
  useEffect(() => {
    const p = pendingOpen.current;
    if (!p) return;
    if (result[p].collapsed) {
      pendingOpen.current = null;
      setOverlay(p);
    } else if (result[p].visible) pendingOpen.current = null;
  }, [result]);

  // A sobreposição só existe enquanto a região estiver recolhida e aberta.
  const activeOverlay = overlay && result[overlay].collapsed ? overlay : null;
  useEffect(() => {
    if (overlay && !activeOverlay) setOverlay(null);
  }, [overlay, activeOverlay]);

  // Escape / clique fora fecham a sobreposição (menus e diálogos não contam).
  const overlayRef = useRef(activeOverlay);
  overlayRef.current = activeOverlay;
  useEffect(() => {
    if (!activeOverlay) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || t.closest("[data-region-overlay], [data-ui-menu], [role=dialog], .titlebar-layout, .ext-webview-overlay, .activity-bar")) return;
      setOverlay(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOverlay(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [activeOverlay]);

  const regionVisible = useMemo(
    () => ({
      primarySidebar: result.primarySidebar.visible || activeOverlay === "primarySidebar",
      secondarySidebar: result.secondarySidebar.visible || activeOverlay === "secondarySidebar",
      panel: result.panel.visible || activeOverlay === "panel",
    }),
    [result, activeOverlay],
  );

  const overlaySize = useCallback(
    (region: ViewRegion) => {
      if (region === "panel" && panelPos === "bottom") return Math.max(mins.panelHeight, Math.min(sizes.panelHeight, viewport.height - CHROME_V - 48));
      const pref = region === "primarySidebar" ? sizes.primary : region === "secondarySidebar" ? sizes.secondary : sizes.panelWidth;
      const min = region === "primarySidebar" ? mins.primary : region === "secondarySidebar" ? mins.secondary : mins.panelWidth;
      return Math.max(Math.min(min, viewport.width - 96), Math.min(pref, viewport.width - 96));
    },
    [panelPos, sizes, mins, viewport],
  );

  return {
    result,
    regionVisible,
    overlay: activeOverlay,
    showOverlay: setOverlay,
    dismissOverlay: () => setOverlay(null),
    touch,
    markOpened: (region: ViewRegion) => {
      pendingOpen.current = region;
      touch(region);
    },
    overlaySize,
    viewport,
  };
}
