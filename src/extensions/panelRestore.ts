/**
 * Painéis de webview das extensões que voltam depois de reiniciar o app
 * (`window.registerWebviewPanelSerializer` e custom editors), como no VS Code.
 *
 * O host publica a lista persistível (`webviewPanels`: viewType, extensão,
 * título, coluna, estado do `setState`, uri do custom editor) a cada mudança;
 * guardamos por workspace no `localStorage` e, quando o host sobe de novo
 * (startup ou "Reiniciar Host de Extensões"), devolvemos em
 * `restoreWebviewPanels` — o host ativa a extensão dona e chama o
 * `deserializeWebviewPanel`/`resolveCustomEditor` dela. As abas
 * `extwebview:<handle>` continuam fora da sessão salva do editor (regra 14).
 */

export interface PersistedPanel {
  viewType: string;
  extensionId: string;
  title?: string;
  viewColumn?: number;
  active?: boolean;
  customUri?: string;
  state?: unknown;
  options?: Record<string, boolean>;
}

const KEY_PREFIX = "ext.webviewPanels:";
const MAX_PANELS = 32;
/** Teto do JSON guardado por workspace (o localStorage é pequeno). */
const MAX_BYTES = 1024 * 1024;

export function panelsKey(rootPath: string | null): string {
  return `${KEY_PREFIX}${rootPath ?? ""}`;
}

/** Valida/normaliza a lista lida do armazenamento (dados não confiáveis). */
export function sanitizePersistedPanels(raw: unknown): PersistedPanel[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedPanel[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.viewType !== "string" || !o.viewType || o.viewType.length > 256) continue;
    if (typeof o.extensionId !== "string" || !/^[\w-]+\.[\w.-]+$/.test(o.extensionId)) continue;
    const p: PersistedPanel = { viewType: o.viewType, extensionId: o.extensionId };
    if (typeof o.title === "string") p.title = o.title.slice(0, 1024);
    if (typeof o.viewColumn === "number" && Number.isInteger(o.viewColumn) && o.viewColumn >= 1 && o.viewColumn <= 64) p.viewColumn = o.viewColumn;
    if (o.active === true) p.active = true;
    if (typeof o.customUri === "string" && /^[a-z][\w+.-]*:/i.test(o.customUri) && o.customUri.length <= 8192 && !o.customUri.includes("\0")) p.customUri = o.customUri;
    if (o.state !== undefined) p.state = o.state;
    if (o.options && typeof o.options === "object" && !Array.isArray(o.options)) {
      const opts: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(o.options as Record<string, unknown>)) if (typeof v === "boolean" && /^\w{1,40}$/.test(k)) opts[k] = v;
      p.options = opts;
    }
    out.push(p);
    if (out.length >= MAX_PANELS) break;
  }
  return out;
}

/**
 * Ordem de restauração: o painel que estava ATIVO por último (ele fica em
 * primeiro plano no grupo dele), os demais na ordem em que estavam.
 */
export function restoreOrder(panels: PersistedPanel[]): PersistedPanel[] {
  return [...panels.filter((p) => !p.active), ...panels.filter((p) => p.active)];
}

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadPersistedPanels(rootPath: string | null, store: StorageLike | null = storage()): PersistedPanel[] {
  try {
    const raw = store?.getItem(panelsKey(rootPath));
    return raw ? sanitizePersistedPanels(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function savePersistedPanels(rootPath: string | null, panels: unknown, store: StorageLike | null = storage()): void {
  if (!store) return;
  try {
    const list = sanitizePersistedPanels(panels);
    if (list.length === 0) {
      store.removeItem(panelsKey(rootPath));
      return;
    }
    let json = JSON.stringify(list);
    // Grande demais: guarda sem o estado (o painel volta, a extensão recomeça a view).
    if (json.length > MAX_BYTES) json = JSON.stringify(list.map(({ state: _s, ...rest }) => rest));
    store.setItem(panelsKey(rootPath), json);
  } catch {
    /* armazenamento indisponível/cheio: segue sem persistir */
  }
}
