/**
 * Onde cada view vive: região, ordem, visibilidade e a ativa de cada região.
 * Estado puro + persistência (localStorage `ui.viewLayout`) + migração das
 * preferências antigas (`ui.panelTabOrder`, `ui.agentsDockTab`).
 *
 * Só guarda o que o usuário mudou: uma view sem `placement` salvo fica na
 * região/ordem padrão do descriptor. Placements de views ausentes (extensão
 * desinstalada nesta sessão) são preservados para quando ela voltar.
 */
import {
  isRegionAllowed,
  VIEW_REGIONS,
  extensionViewId,
  type ViewDescriptor,
  type ViewRegion,
} from "./viewRegistry.ts";

export const VIEW_LAYOUT_KEY = "ui.viewLayout";
export const VIEW_LAYOUT_VERSION = 1;

export interface ViewPlacement {
  region: ViewRegion;
  order: number;
  hidden?: boolean;
}

export interface ViewLayoutState {
  version: typeof VIEW_LAYOUT_VERSION;
  placements: Record<string, ViewPlacement>;
  /** View ativa por região (fallback: a primeira visível da região). */
  active: Partial<Record<ViewRegion, string>>;
}

export function emptyViewLayout(): ViewLayoutState {
  return { version: VIEW_LAYOUT_VERSION, placements: {}, active: {} };
}

type Desc = Pick<ViewDescriptor, "id" | "defaultRegion" | "defaultOrder" | "allowedRegions">;

/** Região/ordem efetivas de uma view (salvas, ou as padrão). */
export function placementOf(state: ViewLayoutState, desc: Desc): ViewPlacement {
  const saved = state.placements[desc.id];
  if (saved && isRegionAllowed(desc, saved.region)) return saved;
  return { region: desc.defaultRegion, order: desc.defaultOrder, hidden: saved?.hidden };
}

/** Views de uma região na ordem de exibição (ocultas fora, salvo `includeHidden`). */
export function viewsInRegion<T extends Desc>(
  state: ViewLayoutState,
  descs: readonly T[],
  region: ViewRegion,
  opts: { includeHidden?: boolean } = {},
): T[] {
  return descs
    .map((d) => ({ d, p: placementOf(state, d) }))
    .filter(({ p }) => p.region === region && (opts.includeHidden || !p.hidden))
    .sort((a, b) => a.p.order - b.p.order || a.d.defaultOrder - b.d.defaultOrder || a.d.id.localeCompare(b.d.id))
    .map(({ d }) => d);
}

export function regionOfView(state: ViewLayoutState, descs: readonly Desc[], id: string): ViewRegion | null {
  const d = descs.find((x) => x.id === id);
  return d ? placementOf(state, d).region : null;
}

/** View ativa da região: a salva se ainda estiver lá e visível, senão a primeira. */
export function activeViewIn(state: ViewLayoutState, descs: readonly Desc[], region: ViewRegion): string | null {
  const list = viewsInRegion(state, descs, region);
  const want = state.active[region];
  if (want && list.some((d) => d.id === want)) return want;
  return list[0]?.id ?? null;
}

/**
 * Move `id` para `region` na posição `index` (fim por padrão) e a torna a ativa
 * de lá. A região de origem recai na vizinha (via `activeViewIn`). Mover para
 * uma região não permitida é no-op. Reexibe a view se estava oculta.
 */
export function moveView(
  state: ViewLayoutState,
  descs: readonly Desc[],
  id: string,
  region: ViewRegion,
  index?: number,
): ViewLayoutState {
  const desc = descs.find((d) => d.id === id);
  if (!desc || !isRegionAllowed(desc, region)) return state;
  const from = placementOf(state, desc);
  const target = viewsInRegion(state, descs, region, { includeHidden: true }).filter((d) => d.id !== id);
  const at = index == null ? target.length : Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, desc);
  const placements = { ...state.placements };
  target.forEach((d, i) => {
    const prev = placementOf(state, d);
    placements[d.id] = { region, order: i, ...(d.id !== id && prev.hidden ? { hidden: true } : {}) };
  });
  const active = { ...state.active, [region]: id };
  if (from.region !== region && state.active[from.region] === id) delete active[from.region];
  return { ...state, placements, active };
}

export function setActiveView(state: ViewLayoutState, region: ViewRegion, id: string): ViewLayoutState {
  if (state.active[region] === id) return state;
  return { ...state, active: { ...state.active, [region]: id } };
}

export function setViewHidden(state: ViewLayoutState, descs: readonly Desc[], id: string, hidden: boolean): ViewLayoutState {
  const desc = descs.find((d) => d.id === id);
  if (!desc) return state;
  const p = placementOf(state, desc);
  if (!!p.hidden === hidden) return state;
  const next: ViewPlacement = { region: p.region, order: p.order };
  if (hidden) next.hidden = true;
  return { ...state, placements: { ...state.placements, [id]: next } };
}

/** Volta tudo às posições padrão. */
export function resetViewLayout(): ViewLayoutState {
  return emptyViewLayout();
}

function isRegion(v: unknown): v is ViewRegion {
  return typeof v === "string" && (VIEW_REGIONS as readonly string[]).includes(v);
}

/** Valida um estado salvo; entradas inválidas são descartadas (nunca lança). */
export function parseViewLayout(raw: unknown): ViewLayoutState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== VIEW_LAYOUT_VERSION) return null;
  const out = emptyViewLayout();
  if (r.placements && typeof r.placements === "object") {
    for (const [id, p] of Object.entries(r.placements as Record<string, unknown>)) {
      if (!id || id.length > 256 || !p || typeof p !== "object") continue;
      const pp = p as Record<string, unknown>;
      if (!isRegion(pp.region) || typeof pp.order !== "number" || !Number.isFinite(pp.order)) continue;
      out.placements[id] = { region: pp.region, order: pp.order, ...(pp.hidden === true ? { hidden: true } : {}) };
    }
  }
  if (r.active && typeof r.active === "object") {
    for (const [region, id] of Object.entries(r.active as Record<string, unknown>)) {
      if (isRegion(region) && typeof id === "string" && id) out.active[region] = id;
    }
  }
  return out;
}

/** Ids antigos das abas do Fluent Chat / ExtensionDock (`ui.agentsDockTab`). */
const LEGACY_CHAT_TABS = new Set(["fluent-chat", "fluent-agents", "agents", "chat"]);
const LEGACY_PANEL_TABS = ["terminal", "problems", "output"];

/**
 * Converte as preferências antigas: ordem das abas do painel inferior e a aba
 * lembrada da sidebar secundária ("Chat"/"Agentes" → `fluentChat`; extensão →
 * `ext:<id>`). A aba "Agentes" deixou de existir: vira o Fluent Chat.
 */
export function migrateLegacyViewLayout(read: (key: string) => string | null): ViewLayoutState {
  const state = emptyViewLayout();
  try {
    const order = JSON.parse(read("ui.panelTabOrder") ?? "null");
    if (Array.isArray(order) && order.every((t) => LEGACY_PANEL_TABS.includes(t))) {
      order.forEach((t: string, i: number) => {
        state.placements[t] = { region: "panel", order: i };
      });
    }
  } catch {
    /* ausente/malformado */
  }
  const tab = read("ui.agentsDockTab");
  if (tab) {
    state.active.secondarySidebar = LEGACY_CHAT_TABS.has(tab) ? "fluentChat" : extensionViewId(tab);
  }
  return state;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadViewLayout(storage: KeyValueStorage | null): ViewLayoutState {
  if (!storage) return emptyViewLayout();
  try {
    const raw = storage.getItem(VIEW_LAYOUT_KEY);
    if (raw) {
      const parsed = parseViewLayout(JSON.parse(raw));
      if (parsed) return parsed;
    }
    return migrateLegacyViewLayout((k) => storage.getItem(k));
  } catch {
    return emptyViewLayout();
  }
}

export function saveViewLayout(storage: KeyValueStorage | null, state: ViewLayoutState): void {
  try {
    storage?.setItem(VIEW_LAYOUT_KEY, JSON.stringify(state));
  } catch {
    /* storage indisponível */
  }
}
