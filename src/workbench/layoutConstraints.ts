/**
 * Solver do layout responsivo do workbench: reserva um mínimo para o editor
 * (largura e altura) considerando TODAS as regiões abertas juntas — não cada
 * uma isoladamente. Puro e testado (layoutConstraints.test.ts).
 *
 * Ordem das concessões quando falta espaço:
 * 1. encolhe as regiões até o mínimo de cada uma (proporcional à folga);
 * 2. ainda falta: recolhe TEMPORARIAMENTE a região usada há mais tempo (LRU)
 *    — a preferência salva (aberta + tamanho) não muda; ela pode ser reaberta
 *    como sobreposição e volta sozinha quando houver espaço.
 * O painel inferior disputa a altura com o editor (mínimo de altura).
 */
import type { ViewRegion } from "./viewRegistry.ts";

export interface RegionPrefs {
  /** Aberta pelo usuário (preferência). */
  open: boolean;
  /** Tamanho preferido (px CSS): largura das laterais / altura ou largura do painel. */
  size: number;
  min: number;
  /** Teto absoluto (px CSS), além da reserva do editor. */
  max?: number;
}

export interface LayoutInput {
  /** Área útil em px CSS (janela ÷ zoom da UI). */
  viewport: { width: number; height: number };
  /** Cromo fixo: horizontal (activity bar, margens, vãos) e vertical (title/status bar, abas). */
  chrome: { horizontal: number; vertical: number };
  /** Vão entre duas regiões vizinhas (px CSS), somado por região aberta. */
  gap: number;
  regions: Record<ViewRegion, RegionPrefs>;
  /** Painel embaixo (disputa altura) ou numa lateral do editor (disputa largura). */
  panelOrientation: "bottom" | "side";
  editorMin: { width: number; height: number };
  /** Regiões da menos para a mais recentemente usada. */
  lru: readonly ViewRegion[];
}

export interface RegionLayout {
  /** Aberta e com espaço (renderizada no fluxo). */
  visible: boolean;
  /** Aberta pelo usuário, mas recolhida por falta de espaço. */
  collapsed: boolean;
  /** Tamanho efetivo (px CSS). */
  size: number;
  /** Máximo que a alça pode dar agora sem invadir o mínimo do editor. */
  max: number;
}

export type LayoutResult = Record<ViewRegion, RegionLayout> & { editor: { width: number; height: number } };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Distribui `deficit` entre os tamanhos, sem passar do mínimo, proporcional à folga. */
function shrink(sizes: number[], mins: number[], deficit: number): number[] {
  const slack = sizes.map((s, i) => Math.max(0, s - mins[i]));
  const total = slack.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes;
  const take = Math.min(deficit, total);
  return sizes.map((s, i) => s - (slack[i] / total) * take);
}

export function solveLayout(input: LayoutInput): LayoutResult {
  const { regions, editorMin, gap } = input;
  const order: ViewRegion[] = ["primarySidebar", "secondarySidebar", "panel"];
  const horizontal = (r: ViewRegion) => r !== "panel" || input.panelOrientation === "side";
  const out = {} as LayoutResult;

  // ---- eixo horizontal ----
  const availW = Math.max(0, input.viewport.width - input.chrome.horizontal);
  let docked = order.filter((r) => horizontal(r) && regions[r].open);
  const collapsedSet = new Set<ViewRegion>();
  const pref = (r: ViewRegion) => clamp(regions[r].size, regions[r].min, regions[r].max ?? Infinity);
  const budgetFor = (list: ViewRegion[]) => availW - editorMin.width - gap * list.length;
  // Recolhe pela ordem LRU até os mínimos caberem.
  const lruRank = (r: ViewRegion) => {
    const i = input.lru.indexOf(r);
    return i < 0 ? -1 : i;
  };
  const fits = (list: ViewRegion[]) => list.reduce((a, r) => a + regions[r].min, 0) <= budgetFor(list);
  while (docked.length > 0 && !fits(docked)) {
    const victim = [...docked].sort((a, b) => lruRank(a) - lruRank(b))[0];
    collapsedSet.add(victim);
    docked = docked.filter((r) => r !== victim);
  }
  // Uma recolhida que caiba no que sobrou volta (da mais recente para a mais
  // antiga): ex. a secundária não cabe nem sozinha, mas a primária cabe.
  for (const r of [...collapsedSet].sort((a, b) => lruRank(b) - lruRank(a))) {
    const next = order.filter((x) => x === r || docked.includes(x));
    if (fits(next)) {
      docked = next;
      collapsedSet.delete(r);
    }
  }
  let sizes = docked.map(pref);
  const budget = budgetFor(docked);
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum > budget) sizes = shrink(sizes, docked.map((r) => regions[r].min), sum - budget);
  const widthOf = new Map(docked.map((r, i) => [r, Math.floor(sizes[i])]));
  const usedW = [...widthOf.values()].reduce((a, b) => a + b, 0);

  for (const r of order) {
    if (!horizontal(r)) continue;
    const open = regions[r].open;
    const collapsed = collapsedSet.has(r);
    const size = widthOf.get(r) ?? pref(r);
    // Máximo da alça: o que sobra para o editor acima do mínimo.
    const others = usedW - (widthOf.get(r) ?? 0);
    const roomList = widthOf.has(r) ? docked : [...docked, r];
    const max = Math.max(regions[r].min, Math.min(regions[r].max ?? Infinity, budgetFor(roomList) - others));
    out[r] = { visible: open && !collapsed, collapsed: open && collapsed, size, max };
  }

  // ---- eixo vertical (painel embaixo) ----
  const availH = Math.max(0, input.viewport.height - input.chrome.vertical);
  if (!horizontal("panel")) {
    const p = regions.panel;
    const room = availH - editorMin.height;
    const collapsed = p.open && room < p.min;
    const size = Math.floor(clamp(pref("panel"), p.min, Math.max(p.min, Math.min(p.max ?? Infinity, room))));
    const max = Math.max(p.min, Math.min(p.max ?? Infinity, room));
    out.panel = { visible: p.open && !collapsed, collapsed, size, max };
  }

  out.editor = {
    width: Math.max(0, availW - usedW - gap * docked.length),
    height: Math.max(0, availH - (!horizontal("panel") && out.panel.visible ? out.panel.size : 0)),
  };
  return out;
}

/** Atualiza a ordem LRU: `r` passa a ser a mais recente. */
export function touchLru(lru: readonly ViewRegion[], r: ViewRegion): ViewRegion[] {
  if (lru[lru.length - 1] === r) return lru as ViewRegion[];
  return [...lru.filter((x) => x !== r), r];
}

const STEP = 16;
const BIG_STEP = 64;

/** Alça por teclado: valor após uma tecla (setas ±16 px, Shift ±64, Home/End). */
export function resizeKeyValue(key: string, shift: boolean, value: number, min: number, max: number, orientation: "vertical" | "horizontal", direction: 1 | -1): number | null {
  const step = shift ? BIG_STEP : STEP;
  const grow = orientation === "vertical" ? (direction === 1 ? "ArrowRight" : "ArrowLeft") : direction === 1 ? "ArrowDown" : "ArrowUp";
  const shrinkKey = orientation === "vertical" ? (direction === 1 ? "ArrowLeft" : "ArrowRight") : direction === 1 ? "ArrowUp" : "ArrowDown";
  let next: number;
  if (key === grow) next = value + step;
  else if (key === shrinkKey) next = value - step;
  else if (key === "Home") next = min;
  else if (key === "End") next = max;
  else return null;
  return Math.round(Math.max(min, Math.min(max, next)));
}

