/**
 * Registro de temas — interface MÍNIMA usada pela tela de Configurações
 * (pickers de `workbench.colorTheme`/`workbench.iconTheme`). Mesma API pública
 * do registro da frente de temas (branch w2/temas: `list`, `get`, `active`,
 * `configured`, `apply`, `restore`, `onDidChange`, `registerThemeProvider`);
 * na integração a implementação de lá substitui esta, e o adaptador de
 * settings dela (`setSettingsBackend`) passa a apontar para `src/settings/`.
 *
 * Aqui só existem os temas embutidos; `src/settings/applyTheme.ts` aplica a
 * setting por este registro.
 */
import { settings } from "../settings/instance.ts";

export type ThemeKind = "color" | "fileIcon" | "productIcon";

export type ThemeOrigin = { type: "builtin" } | { type: "extension"; extensionId: string; extensionName: string };

export interface ThemeEntry {
  kind: ThemeKind;
  id: string;
  label: string;
  uiTheme?: "vs" | "vs-dark" | "hc-black" | "hc-light";
  origin: ThemeOrigin;
  description?: string;
}

export interface ThemeChangeEvent {
  kind: ThemeKind;
  type: "list" | "active";
  preview?: boolean;
}

export interface ThemeKindProvider {
  kind: ThemeKind;
  defaultId: string;
  entries(): ThemeEntry[];
  applyEntry(entry: ThemeEntry): Promise<void>;
}

export interface ThemeRegistry {
  list(kind: ThemeKind): readonly ThemeEntry[];
  get(kind: ThemeKind, id: string): ThemeEntry | undefined;
  active(kind: ThemeKind): ThemeEntry | undefined;
  configured(kind: ThemeKind): string;
  apply(kind: ThemeKind, id: string, opts?: { preview?: boolean }): Promise<void>;
  restore(kind: ThemeKind): Promise<void>;
  onDidChange(listener: (e: ThemeChangeEvent) => void): () => void;
}

export const THEME_SETTING: Record<ThemeKind, string> = {
  color: "workbench.colorTheme",
  fileIcon: "workbench.iconTheme",
  productIcon: "workbench.productIconTheme",
};

export const DEFAULT_COLOR_THEME = "Fluent Escuro";
export const DEFAULT_ICON_THEME = "material-icon-theme";

const providers = new Map<ThemeKind, ThemeKindProvider>();
const activeId = new Map<ThemeKind, string>();
const listeners = new Set<(e: ThemeChangeEvent) => void>();

function emit(e: ThemeChangeEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      /* ignora */
    }
  }
}

function find(kind: ThemeKind, id: string): ThemeEntry | undefined {
  const list = providers.get(kind)?.entries() ?? [];
  return list.find((e) => e.id === id) ?? list.find((e) => e.id.toLowerCase() === id.toLowerCase() || e.label === id);
}

async function applyEntry(kind: ThemeKind, entry: ThemeEntry, preview: boolean): Promise<void> {
  await providers.get(kind)!.applyEntry(entry);
  activeId.set(kind, entry.id);
  emit({ kind, type: "active", preview });
}

export const themeRegistry: ThemeRegistry = {
  list: (kind) => providers.get(kind)?.entries() ?? [],
  get: (kind, id) => find(kind, id),
  active: (kind) => {
    const id = activeId.get(kind);
    return id ? find(kind, id) : undefined;
  },
  configured: (kind) => {
    const v = settings.get<string | null>(THEME_SETTING[kind]);
    return typeof v === "string" && v ? v : providers.get(kind)?.defaultId ?? "";
  },
  async apply(kind, id, opts = {}) {
    const entry = find(kind, id);
    if (!entry) throw new Error(`tema não encontrado: ${id}`);
    if (!opts.preview) await settings.update(THEME_SETTING[kind], entry.id, "user");
    await applyEntry(kind, entry, !!opts.preview);
  },
  async restore(kind) {
    const p = providers.get(kind);
    if (!p) return;
    const entry = find(kind, themeRegistry.configured(kind)) ?? find(kind, p.defaultId);
    if (entry) await applyEntry(kind, entry, false);
  },
  onDidChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function registerThemeProvider(provider: ThemeKindProvider): Promise<void> {
  providers.set(provider.kind, provider);
  emit({ kind: provider.kind, type: "list" });
  return themeRegistry.restore(provider.kind).catch(() => {});
}

export function notifyThemeListChanged(kind: ThemeKind): void {
  emit({ kind, type: "list" });
}

// Embutidos.
void registerThemeProvider({
  kind: "color",
  defaultId: DEFAULT_COLOR_THEME,
  entries: () => [{ kind: "color", id: DEFAULT_COLOR_THEME, label: "Fluent Escuro", uiTheme: "vs-dark", origin: { type: "builtin" }, description: "Tema padrão (Windows 11)" }],
  applyEntry: async () => {},
});
void registerThemeProvider({
  kind: "fileIcon",
  defaultId: DEFAULT_ICON_THEME,
  entries: () => [{ kind: "fileIcon", id: DEFAULT_ICON_THEME, label: "Material Icon Theme", origin: { type: "builtin" } }],
  applyEntry: async () => {},
});
