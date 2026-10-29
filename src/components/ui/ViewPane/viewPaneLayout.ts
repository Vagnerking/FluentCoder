/**
 * Regras puras do `ViewPaneContainer` (pilha vertical de view panes, modelo do
 * `SplitView`/`PaneView` do VS Code). Sem DOM: testadas em
 * `viewPaneLayout.test.ts`.
 *
 * - Pane recolhido = só o cabeçalho (`headerSize`), corpo 0.
 * - Os expandidos dividem a altura que sobra **proporcionalmente aos pesos**,
 *   respeitando o `minBody` de cada um; o arredondamento vai para o último
 *   expandido (ele absorve a sobra). Um expandido sozinho ocupa tudo.
 * - A ordem nunca muda: recolhidos depois do último expandido ficam
 *   empilhados no rodapé (o expandido empurra-os para baixo).
 * - A sash fica entre dois expandidos e ajusta só o par (o que um perde, o
 *   vizinho ganha), sem passar do mínimo de nenhum dos dois.
 * - Persistência por proporções (pesos normalizados), nunca px absolutos.
 */

export interface ViewPaneLayoutItem {
  id: string;
  expanded: boolean;
  /** Altura mínima do corpo (px) quando expandido. */
  minBody: number;
  /** Peso relativo (proporção) do corpo entre os expandidos. */
  weight: number;
}

/** Altura padrão do cabeçalho de um pane (px). Espelhada no CSS. */
export const VIEW_PANE_HEADER_SIZE = 24;

/** Corpo mínimo padrão quando o descriptor não define um. */
export const VIEW_PANE_DEFAULT_MIN_BODY = 48;

/**
 * Altura do corpo de cada pane (mesma ordem de `items`; 0 nos recolhidos).
 * Se nem os mínimos cabem, cada expandido fica no mínimo (o container rola).
 */
export function solveViewPaneLayout(
  items: readonly ViewPaneLayoutItem[],
  available: number,
  headerSize: number = VIEW_PANE_HEADER_SIZE
): number[] {
  const sizes = items.map(() => 0);
  const expanded = items.map((it, i) => ({ it, i })).filter((x) => x.it.expanded);
  if (expanded.length === 0) return sizes;
  const space = Math.max(0, Math.floor(available) - headerSize * items.length);
  const mins = expanded.map(({ it }) => Math.max(0, Math.floor(it.minBody)));
  const minSum = mins.reduce((a, b) => a + b, 0);
  if (space <= minSum) {
    expanded.forEach(({ i }, k) => (sizes[i] = mins[k]));
    return sizes;
  }

  // Water-filling: quem ficaria abaixo do mínimo é fixado no mínimo e sai da
  // divisão proporcional; repete até estabilizar.
  const weights = expanded.map(({ it }) => (it.weight > 0 && Number.isFinite(it.weight) ? it.weight : 1));
  const fixed = new Array<boolean>(expanded.length).fill(false);
  const raw = new Array<number>(expanded.length).fill(0);
  for (;;) {
    let rest = space;
    let wsum = 0;
    for (let k = 0; k < expanded.length; k++) {
      if (fixed[k]) rest -= mins[k];
      else wsum += weights[k];
    }
    let changed = false;
    for (let k = 0; k < expanded.length; k++) {
      if (fixed[k]) {
        raw[k] = mins[k];
        continue;
      }
      raw[k] = wsum > 0 ? (rest * weights[k]) / wsum : 0;
      if (raw[k] < mins[k]) {
        fixed[k] = true;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const floors = raw.map((v) => Math.floor(v));
  const used = floors.reduce((a, b) => a + b, 0);
  floors[floors.length - 1] += space - used;
  expanded.forEach(({ i }, k) => (sizes[i] = floors[k]));
  return sizes;
}

/**
 * Arrasta a sash entre os corpos `upper` e `lower` (índices em `sizes`) por
 * `delta` px (positivo = desce: o de cima cresce). Ajusta só o par e respeita
 * os mínimos. Retorna um novo array.
 */
export function resizeViewPanePair(
  sizes: readonly number[],
  upper: number,
  lower: number,
  delta: number,
  mins: readonly number[]
): number[] {
  const next = [...sizes];
  if (upper < 0 || lower < 0 || upper >= sizes.length || lower >= sizes.length || upper === lower) return next;
  const minUp = Math.max(0, mins[upper] ?? 0);
  const minLow = Math.max(0, mins[lower] ?? 0);
  const lo = -(sizes[upper] - minUp);
  const hi = sizes[lower] - minLow;
  const d = Math.round(Math.min(Math.max(delta, Math.min(lo, 0)), Math.max(hi, 0)));
  next[upper] = sizes[upper] + d;
  next[lower] = sizes[lower] - d;
  return next;
}

/** Índice do próximo pane expandido depois de `index` (ou -1). */
export function nextExpandedIndex(items: readonly Pick<ViewPaneLayoutItem, "expanded">[], index: number): number {
  for (let i = index + 1; i < items.length; i++) if (items[i].expanded) return i;
  return -1;
}

/** Tamanhos (px) → pesos normalizados (soma 1) só dos expandidos. */
export function sizesToWeights(
  items: readonly Pick<ViewPaneLayoutItem, "id" | "expanded">[],
  sizes: readonly number[]
): Record<string, number> {
  const total = items.reduce((acc, it, i) => acc + (it.expanded ? Math.max(0, sizes[i] ?? 0) : 0), 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  items.forEach((it, i) => {
    if (it.expanded) out[it.id] = Math.round((Math.max(0, sizes[i] ?? 0) / total) * 10000) / 10000;
  });
  return out;
}

/** Estado persistido de um container (`localStorage["ui.viewPanes.<id>"]`). */
export interface ViewPaneState {
  version: 1;
  expanded: Record<string, boolean>;
  weights: Record<string, number>;
}

export function emptyViewPaneState(): ViewPaneState {
  return { version: 1, expanded: {}, weights: {} };
}

/** Lê o JSON persistido; qualquer coisa inválida vira o estado vazio. */
export function parseViewPaneState(raw: string | null | undefined): ViewPaneState {
  if (!raw) return emptyViewPaneState();
  try {
    const v = JSON.parse(raw) as Partial<ViewPaneState> | null;
    if (!v || typeof v !== "object" || v.version !== 1) return emptyViewPaneState();
    const expanded: Record<string, boolean> = {};
    const weights: Record<string, number> = {};
    for (const [k, b] of Object.entries(v.expanded ?? {})) if (typeof b === "boolean") expanded[k] = b;
    for (const [k, w] of Object.entries(v.weights ?? {})) {
      if (typeof w === "number" && Number.isFinite(w) && w > 0) weights[k] = w;
    }
    return { version: 1, expanded, weights };
  } catch {
    return emptyViewPaneState();
  }
}

/** Teclado na sash: ↑/↓ ±16 px, Shift ±64. Outras teclas → null. */
export function sashKeyDelta(key: string, shift: boolean): number | null {
  const step = shift ? 64 : 16;
  if (key === "ArrowUp") return -step;
  if (key === "ArrowDown") return step;
  return null;
}

/**
 * Navegação por teclado entre cabeçalhos (↑/↓ com wrap, Home/End). Retorna o
 * índice do cabeçalho a focar, ou null para teclas que não navegam.
 */
export function headerKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "ArrowDown":
      return (index + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Quantas ações cabem inline numa barra de `width` px, com botões de `slot`
 * px. Quando nem todas cabem (ou `forceMenu`), um slot vai para o "…" — que
 * nunca some: sempre sobra ao menos o botão de overflow.
 */
export function fitActions(
  count: number,
  width: number,
  slot: number,
  forceMenu = false
): { inline: number; menu: boolean } {
  if (count <= 0) return { inline: 0, menu: forceMenu };
  const fits = Math.max(0, Math.floor(Math.max(0, width) / Math.max(1, slot)));
  if (!forceMenu && fits >= count) return { inline: count, menu: false };
  return { inline: Math.min(count, Math.max(0, fits - 1)), menu: true };
}
