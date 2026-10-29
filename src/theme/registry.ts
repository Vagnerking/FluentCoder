/**
 * Registro de TEMAS do app — a interface pública sobre a qual a UI de
 * configurações (frente F) e os seletores (Paleta, view Extensões) trabalham.
 *
 * Três tipos de tema, todos com a mesma API:
 *
 * | kind          | setting                       | padrão                 |
 * |---------------|-------------------------------|------------------------|
 * | `color`       | `workbench.colorTheme`        | "Fluent Escuro"        |
 * | `fileIcon`    | `workbench.iconTheme`         | "material-icon-theme"  |
 * | `productIcon` | `workbench.productIconTheme`  | "Default"              |
 *
 * ```ts
 * import { themeRegistry } from "src/theme/registry";
 * themeRegistry.list("color");                 // embutidos + de extensões
 * themeRegistry.active("color");               // o aplicado agora
 * await themeRegistry.apply("color", "Dracula");                  // aplica e salva
 * await themeRegistry.apply("color", "Dracula", { preview: true }); // só pré-visualiza
 * await themeRegistry.restore("color");        // volta ao salvo (cancelar prévia)
 * const off = themeRegistry.onDidChange((e) => …); // lista ou ativo mudou
 * ```
 *
 * O id é o do VS Code (`id` ?? `label` do `contributes.themes[]`), então um
 * `settings.json` importado do VS Code funciona igual. Tema salvo que ainda não
 * carregou (extensão lendo) ou foi removido: o padrão é aplicado, a setting é
 * mantida e o tema volta sozinho quando reaparecer na lista.
 *
 * Os motores (cor: `colorThemeService.ts`; ícones de arquivo:
 * `src/icon-theme/iconThemeService.ts`; ícones de produto:
 * `src/icons/productIconTheme.ts`) se registram com `registerThemeProvider`.
 */
import type { UiTheme } from "./colorThemeModel.ts";
import { SETTING, getSetting, onDidChangeSetting, setSetting } from "./settingsAdapter.ts";

export type ThemeKind = "color" | "fileIcon" | "productIcon";

export type ThemeOrigin = { type: "builtin" } | { type: "extension"; extensionId: string; extensionName: string };

export interface ThemeEntry {
  kind: ThemeKind;
  /** Id de settings (o mesmo do VS Code). */
  id: string;
  /** Nome exibido (já traduzido pelo NLS da extensão). */
  label: string;
  /** Só `color`: base clara/escura/alto contraste. */
  uiTheme?: UiTheme;
  origin: ThemeOrigin;
  description?: string;
}

export interface ThemeChangeEvent {
  kind: ThemeKind;
  /** `list` = temas disponíveis mudaram; `active` = outro tema foi aplicado. */
  type: "list" | "active";
  /** O tema ativo é só uma pré-visualização (não salvo). */
  preview?: boolean;
}

export interface ThemeRegistry {
  list(kind: ThemeKind): readonly ThemeEntry[];
  get(kind: ThemeKind, id: string): ThemeEntry | undefined;
  /** O tema aplicado agora (prévia inclusa). */
  active(kind: ThemeKind): ThemeEntry;
  /** O id salvo na setting (pode não estar na lista ainda). */
  configured(kind: ThemeKind): string;
  /** Aplica `id`; `preview: true` não salva. Rejeita se `id` não existe. */
  apply(kind: ThemeKind, id: string, opts?: { preview?: boolean }): Promise<void>;
  /** Volta ao tema salvo (fim de uma pré-visualização sem escolher). */
  restore(kind: ThemeKind): Promise<void>;
  onDidChange(listener: (e: ThemeChangeEvent) => void): () => void;
}

/** O que cada motor implementa. */
export interface ThemeKindProvider {
  kind: ThemeKind;
  defaultId: string;
  entries(): ThemeEntry[];
  /** Aplica de fato (CSS, Monaco, ícones…). Pode demorar (lê arquivos da extensão). */
  applyEntry(entry: ThemeEntry): Promise<void>;
}

const SETTING_OF: Record<ThemeKind, string> = {
  color: SETTING.colorTheme,
  fileIcon: SETTING.iconTheme,
  productIcon: SETTING.productIconTheme,
};

interface KindState {
  provider: ThemeKindProvider;
  active: ThemeEntry;
  preview: boolean;
  /** Sequência das aplicações: só a última vale (troca rápida nas setas). */
  seq: number;
  /** Algum tema já foi aplicado de fato por este motor. */
  applied: boolean;
}

const kinds = new Map<ThemeKind, KindState>();
const listeners = new Set<(e: ThemeChangeEvent) => void>();

function emit(e: ThemeChangeEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      /* ouvinte com erro não derruba o registro */
    }
  }
}

function stateOf(kind: ThemeKind): KindState {
  const s = kinds.get(kind);
  if (!s) throw new Error(`motor de temas "${kind}" não registrado`);
  return s;
}

function findEntry(p: ThemeKindProvider, id: string): ThemeEntry | undefined {
  const list = p.entries();
  return list.find((e) => e.id === id) ?? list.find((e) => e.id.toLowerCase() === id.toLowerCase() || e.label === id);
}

function defaultEntry(p: ThemeKindProvider): ThemeEntry {
  const d = findEntry(p, p.defaultId) ?? p.entries()[0];
  if (!d) throw new Error(`motor de temas "${p.kind}" sem tema padrão`);
  return d;
}

async function applyResolved(s: KindState, entry: ThemeEntry, preview: boolean): Promise<void> {
  const seq = ++s.seq;
  try {
    await s.provider.applyEntry(entry);
  } catch (err) {
    if (seq !== s.seq) return;
    // Falhou (tema quebrado): fica o padrão, com o erro na saída do motor.
    const d = defaultEntry(s.provider);
    if (d.id !== entry.id) {
      await s.provider.applyEntry(d).catch(() => {});
      s.applied = true;
      s.active = d;
      s.preview = preview;
      emit({ kind: s.provider.kind, type: "active", preview });
    }
    throw err;
  }
  if (seq !== s.seq) return; // outra aplicação começou depois
  s.applied = true;
  s.active = entry;
  s.preview = preview;
  emit({ kind: s.provider.kind, type: "active", preview });
}

export const themeRegistry: ThemeRegistry = {
  list: (kind) => kinds.get(kind)?.provider.entries() ?? [],
  get: (kind, id) => {
    const s = kinds.get(kind);
    return s ? findEntry(s.provider, id) : undefined;
  },
  active: (kind) => stateOf(kind).active,
  configured: (kind) => {
    const s = kinds.get(kind);
    return getSetting(SETTING_OF[kind], s?.provider.defaultId ?? "");
  },
  async apply(kind, id, opts = {}) {
    const s = stateOf(kind);
    const entry = findEntry(s.provider, id);
    if (!entry) throw new Error(`tema não encontrado: ${id}`);
    if (!opts.preview) setSettingQuiet(SETTING_OF[kind], entry.id);
    await applyResolved(s, entry, !!opts.preview);
  },
  async restore(kind) {
    const s = stateOf(kind);
    const entry = findEntry(s.provider, themeRegistry.configured(kind)) ?? defaultEntry(s.provider);
    if (entry.id === s.active.id && !s.preview && s.applied) return;
    await applyResolved(s, entry, false);
  },
  onDidChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// Gravar a setting dispara `onDidChangeSetting` → evitar reaplicar o mesmo tema.
let writingSetting = false;
function setSettingQuiet(key: string, value: string): void {
  writingSetting = true;
  try {
    setSetting(key, value);
  } finally {
    writingSetting = false;
  }
}

/**
 * Registra um motor e aplica o tema salvo (ou o padrão). Com
 * `initialApply: false` o motor aplica depois (`themeRegistry.restore`) —
 * usado no boot enquanto a lista de extensões ainda carrega, para não trocar
 * o tema do cache pelo padrão por um instante.
 */
export function registerThemeProvider(provider: ThemeKindProvider, opts: { initialApply?: boolean } = {}): Promise<void> {
  const fallback = defaultEntry(provider);
  const s: KindState = { provider, active: fallback, preview: false, seq: 0, applied: false };
  kinds.set(provider.kind, s);
  onDidChangeSetting(SETTING_OF[provider.kind], () => {
    if (writingSetting) return;
    void themeRegistry.restore(provider.kind).catch(() => {});
  });
  const configured = findEntry(provider, themeRegistry.configured(provider.kind)) ?? fallback;
  s.active = configured;
  emit({ kind: provider.kind, type: "list" });
  if (opts.initialApply === false) return Promise.resolve();
  return applyResolved(s, configured, false).catch(() => {});
}

/**
 * O motor avisa que a LISTA mudou (extensão instalada/removida). Se o tema
 * salvo apareceu, aplica; se o ativo sumiu, volta ao padrão (sem mexer na setting).
 */
export function notifyThemeListChanged(kind: ThemeKind): void {
  const s = kinds.get(kind);
  if (!s) return;
  emit({ kind, type: "list" });
  if (s.preview || !s.applied) return; // não interrompe prévia nem o boot
  const wanted = findEntry(s.provider, themeRegistry.configured(kind));
  if (wanted && wanted.id !== s.active.id) {
    void applyResolved(s, wanted, false).catch(() => {});
    return;
  }
  if (!findEntry(s.provider, s.active.id)) void applyResolved(s, defaultEntry(s.provider), false).catch(() => {});
  else if (wanted && wanted.id === s.active.id && s.active.origin.type === "extension") {
    // Mesma id, extensão atualizada: reaplica (o conteúdo pode ter mudado).
    void applyResolved(s, wanted, false).catch(() => {});
  }
}

/** Só para testes: zera o registro. */
export function __resetThemeRegistryForTests(): void {
  kinds.clear();
  listeners.clear();
}
