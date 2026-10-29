/**
 * Hit-testing puro do arraste de views entre regiões: zonas de soltura (as
 * regiões abertas + faixas virtuais nas bordas para as fechadas) e o índice de
 * inserção pela posição das abas. Testado em Node (viewDrop.test.ts).
 */
import type { ViewRegion } from "./viewRegistry.ts";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DropZone {
  region: ViewRegion;
  rect: Rect;
  /** Região fechada: faixa na borda que a abre ao soltar. */
  virtual: boolean;
  /** Abas da região (para o índice de inserção), na ordem de exibição. */
  tabs: { id: string; rect: Rect }[];
}

export interface DropTarget {
  region: ViewRegion;
  /** Posição entre as views da região SEM a arrastada (semântica de `moveView`). */
  index?: number;
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
}

/**
 * Zona sob o ponteiro (a de menor área, já que faixas virtuais podem cobrir o
 * editor) e o índice de inserção: antes da primeira aba cujo centro está à
 * direita do ponteiro (abas na mesma linha) — a aba arrastada não conta.
 */
export function dropTargetAt(zones: readonly DropZone[], x: number, y: number, dragId: string): DropTarget | null {
  let best: DropZone | null = null;
  for (const z of zones) {
    if (!contains(z.rect, x, y)) continue;
    if (!best || z.rect.width * z.rect.height < best.rect.width * best.rect.height) best = z;
  }
  if (!best) return null;
  const tabs = best.tabs.filter((t) => t.id !== dragId);
  if (tabs.length === 0) return { region: best.region };
  const strip = tabs.reduce(
    (acc, t) => ({ top: Math.min(acc.top, t.rect.top), bottom: Math.max(acc.bottom, t.rect.top + t.rect.height) }),
    { top: Infinity, bottom: -Infinity },
  );
  // Fora da faixa das abas: vai para o fim da região.
  if (y < strip.top - 8 || y > strip.bottom + 8) return { region: best.region };
  let index = tabs.length;
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].rect;
    if (x < r.left + r.width / 2) {
      index = i;
      break;
    }
  }
  return { region: best.region, index };
}

export interface VirtualZoneInput {
  /** Área útil do corpo do workbench (entre title bar e status bar). */
  body: Rect;
  /** Área do editor (+ painel), para a faixa do painel fechado. */
  editor: Rect;
  open: Record<ViewRegion, boolean>;
  sidebarSide: "left" | "right";
  panelPos: "bottom" | "left" | "right";
  /** Espessura da faixa (px de cliente). */
  size?: number;
}

/** Faixas de soltura para as regiões fechadas (soltar abre a região). */
export function virtualZones(input: VirtualZoneInput): DropZone[] {
  const size = input.size ?? 72;
  const out: DropZone[] = [];
  const { body, editor } = input;
  const edge = (side: "left" | "right"): Rect =>
    side === "left"
      ? { left: body.left, top: body.top, width: size, height: body.height }
      : { left: body.left + body.width - size, top: body.top, width: size, height: body.height };
  if (!input.open.primarySidebar) out.push({ region: "primarySidebar", rect: edge(input.sidebarSide), virtual: true, tabs: [] });
  if (!input.open.secondarySidebar) {
    out.push({ region: "secondarySidebar", rect: edge(input.sidebarSide === "left" ? "right" : "left"), virtual: true, tabs: [] });
  }
  if (!input.open.panel) {
    const rect: Rect =
      input.panelPos === "bottom"
        ? { left: editor.left, top: editor.top + editor.height - size, width: editor.width, height: size }
        : input.panelPos === "right"
          ? { left: editor.left + editor.width - size, top: editor.top, width: size, height: editor.height }
          : { left: editor.left, top: editor.top, width: size, height: editor.height };
    out.push({ region: "panel", rect, virtual: true, tabs: [] });
  }
  return out;
}
