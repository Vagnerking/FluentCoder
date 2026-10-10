/**
 * Estado do QuickPick/InputBox das extensões (evento `quickInput` do host) e o
 * filtro dos itens, como o VS Code: casa o rótulo (e descrição/detalhe se
 * `matchOnDescription`/`matchOnDetail`), `alwaysShow` sempre aparece e os
 * separadores só ficam se algum item do grupo sobrou. Puro (testável em Node).
 */

export interface QuickInputButtonInfo {
  index: number;
  icon?: string;
  tooltip?: string;
  back: boolean;
}

export interface QuickPickItemInfo {
  index: number;
  label: string;
  description?: string;
  detail?: string;
  /** -1 = separador. */
  kind: number;
  alwaysShow: boolean;
  icon?: string;
  buttons: QuickInputButtonInfo[];
}

export interface QuickInputState {
  id: string;
  kind: "pick" | "input";
  extensionId: string;
  title?: string;
  step?: number;
  totalSteps?: number;
  enabled: boolean;
  busy: boolean;
  ignoreFocusOut: boolean;
  placeholder?: string;
  value: string;
  buttons: QuickInputButtonInfo[];
  // pick
  canSelectMany?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  items?: QuickPickItemInfo[];
  activeIndexes?: number[];
  selectedIndexes?: number[];
  // input
  password?: boolean;
  prompt?: string;
  validationMessage?: { text: string; severity: number } | null;
}

/** Itens visíveis para o filtro `query` (índices originais preservados). */
export function filterQuickPickItems(
  items: QuickPickItemInfo[],
  query: string,
  opts: { matchOnDescription?: boolean; matchOnDetail?: boolean } = {},
): QuickPickItemInfo[] {
  const q = query.trim().toLowerCase();
  const matches = (it: QuickPickItemInfo) =>
    it.alwaysShow ||
    !q ||
    it.label.toLowerCase().includes(q) ||
    (!!opts.matchOnDescription && !!it.description && it.description.toLowerCase().includes(q)) ||
    (!!opts.matchOnDetail && !!it.detail && it.detail.toLowerCase().includes(q));
  const out: QuickPickItemInfo[] = [];
  let pendingSeparator: QuickPickItemInfo | null = null;
  for (const it of items) {
    if (it.kind === -1) {
      pendingSeparator = it;
      continue;
    }
    if (!matches(it)) continue;
    if (pendingSeparator) {
      out.push(pendingSeparator);
      pendingSeparator = null;
    }
    out.push(it);
  }
  return out;
}

/** Próximo item selecionável (pula separadores), circular. */
export function moveActive(visible: QuickPickItemInfo[], current: number, delta: 1 | -1): number {
  const selectable = visible.filter((i) => i.kind !== -1);
  if (!selectable.length) return -1;
  const pos = selectable.findIndex((i) => i.index === current);
  const next = pos === -1 ? (delta === 1 ? 0 : selectable.length - 1) : (pos + delta + selectable.length) % selectable.length;
  return selectable[next].index;
}

/** Título com o passo ("Título (2/3)"), como o VS Code. */
export function quickInputTitle(s: Pick<QuickInputState, "title" | "step" | "totalSteps">): string | undefined {
  const step = s.step !== undefined ? (s.totalSteps !== undefined ? `${s.step}/${s.totalSteps}` : String(s.step)) : "";
  if (!s.title && !step) return undefined;
  return [s.title, step && `(${step})`].filter(Boolean).join(" ");
}

// ---- store (um quick input por vez)
let current: QuickInputState | null = null;
const listeners = new Set<() => void>();

export function setQuickInput(s: QuickInputState | null): void {
  current = s;
  listeners.forEach((l) => l());
}

export function hideQuickInput(id: string): void {
  if (current?.id === id) setQuickInput(null);
}

export function quickInputSnapshot(): QuickInputState | null {
  return current;
}

export function subscribeQuickInput(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
