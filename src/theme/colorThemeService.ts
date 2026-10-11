/**
 * Motor dos temas de COR: embutidos (Fluent Escuro/Claro, Alto Contraste) +
 * `contributes.themes` das extensões (modo somente contribuições). Aplicar =
 *
 * 1. Monaco: `defineTheme` + `setTheme` (caminho standalone — ADR 0003 /
 *    `src/lsp/vscodeServices.ts`); troca ao vivo em todos os editores;
 * 2. UI: tokens Fluent no `<html>` (`vscodeThemeMap.ts`) + `color-scheme`;
 *    `fluent.theme.applyToUi = false` limita a editor e terminal;
 * 3. terminal, webviews (`--vscode-*`) e gramáticas TextMate via
 *    `activeTheme.ts`.
 *
 * O último tema aplicado fica em cache (`localStorage`) e é reaplicado ANTES do
 * 1º paint (`applyCachedColorTheme`), sem piscar o tema padrão enquanto a
 * extensão é lida.
 */
import * as monaco from "monaco-editor";
import { whenMonacoReady } from "../monaco-loader";
import { getContributingExtensions, onDidChangeContributions, readExtensionFile, contributionsLog, type ContributingExtension } from "../extensions/contributions/source";
import { normalizeInside } from "../extensions/contributions/paths";
import { BUILTIN_COLOR_THEMES, DEFAULT_COLOR_THEME_ID, type BuiltinColorTheme } from "./builtinThemes";
import { loadColorTheme, normalizeUiTheme, uiThemeKind, type ResolvedColorTheme } from "./colorThemeModel";
import { buildMonacoTheme, defaultForeground } from "./monacoTheme";
import { cssTokensFromTheme, terminalThemeFromColors, vscodeCssVars } from "./vscodeThemeMap";
import { getActiveColorTheme, setActiveColorTheme, type ActiveColorTheme } from "./activeTheme";
import { notifyThemeListChanged, registerThemeProvider, type ThemeEntry } from "./registry";
import { SETTING, getSetting, onDidChangeSetting } from "./settingsAdapter";

const CACHE_KEY = "fluent.theme.colorCache";

interface ExtThemeRef {
  ext: ContributingExtension;
  path: string;
  label: string;
  uiTheme: ReturnType<typeof normalizeUiTheme>;
}

const builtinById = new Map(BUILTIN_COLOR_THEMES.map((t) => [t.id, t]));
let extThemes = new Map<string, ExtThemeRef>();

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `contributes.themes` das extensões que contribuem → refs por id de settings. */
function collectExtensionThemes(): Map<string, ExtThemeRef> {
  const out = new Map<string, ExtThemeRef>();
  for (const ext of getContributingExtensions()) {
    const c = isObj(ext.manifest.contributes) ? ext.manifest.contributes : {};
    if (!Array.isArray(c.themes)) continue;
    for (const t of c.themes) {
      if (!isObj(t) || typeof t.path !== "string") continue;
      const label = typeof t.label === "string" && !/^%.*%$/.test(t.label) ? t.label : typeof t.id === "string" ? t.id : "";
      const id = typeof t.id === "string" && t.id ? t.id : label;
      const path = normalizeInside(t.path);
      if (!id || !path || builtinById.has(id) || out.has(id)) continue;
      out.set(id, { ext, path, label: label || id, uiTheme: normalizeUiTheme(t.uiTheme) });
    }
  }
  return out;
}

function entries(): ThemeEntry[] {
  const list: ThemeEntry[] = BUILTIN_COLOR_THEMES.map((t) => ({ kind: "color", id: t.id, label: t.label, uiTheme: t.theme.uiTheme, origin: { type: "builtin" } }));
  for (const [id, r] of extThemes) {
    list.push({ kind: "color", id, label: r.label, uiTheme: r.uiTheme, origin: { type: "extension", extensionId: r.ext.id, extensionName: r.ext.displayName } });
  }
  return list;
}

/** Id aceito pelo Monaco (`/^[a-z0-9-]+$/i`). */
export function monacoIdFor(settingsId: string): string {
  let h = 0;
  for (const ch of settingsId) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const slug = settingsId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `ext-${slug || "tema"}-${(h >>> 0).toString(36)}`;
}

function fromBuiltin(t: BuiltinColorTheme): ActiveColorTheme {
  return {
    id: t.id,
    label: t.label,
    monacoId: t.monacoId,
    monacoTheme: buildMonacoTheme(t.theme, { overrideRules: t.rules, deriveTokenRules: false }),
    kind: uiThemeKind(t.theme.uiTheme),
    colorScheme: t.colorScheme,
    uiTokens: t.uiTokens,
    terminal: t.terminal,
    vscodeVars: {},
    tokenColors: t.theme.tokenColors,
    defaultForeground: defaultForeground(t.theme),
  };
}

function fromResolved(id: string, theme: ResolvedColorTheme): ActiveColorTheme {
  const ui = cssTokensFromTheme(theme.colors, theme.uiTheme);
  return {
    id,
    label: theme.name,
    monacoId: monacoIdFor(id),
    monacoTheme: buildMonacoTheme(theme),
    kind: uiThemeKind(theme.uiTheme),
    colorScheme: ui.colorScheme,
    uiTokens: ui.tokens,
    terminal: terminalThemeFromColors(theme.colors, theme.uiTheme),
    vscodeVars: vscodeCssVars(theme.colors),
    tokenColors: theme.tokenColors,
    defaultForeground: defaultForeground(theme),
  };
}

const resolvedCache = new Map<string, Promise<ActiveColorTheme>>();

function resolveEntry(entry: ThemeEntry): Promise<ActiveColorTheme> {
  const b = builtinById.get(entry.id);
  if (b) return Promise.resolve(fromBuiltin(b));
  const ref = extThemes.get(entry.id);
  if (!ref) return Promise.reject(new Error(`tema ${entry.id} indisponível`));
  const key = `${ref.ext.id}@${ref.ext.version}:${ref.path}`;
  let p = resolvedCache.get(key);
  if (!p) {
    p = loadColorTheme({ readFile: (rel) => readExtensionFile(ref.ext, rel) }, ref.path, { label: ref.label, uiTheme: ref.uiTheme }).then((t) => fromResolved(entry.id, t));
    resolvedCache.set(key, p);
    p.catch((err) => {
      resolvedCache.delete(key);
      contributionsLog(`tema "${entry.label}" (${ref.ext.id}) não pôde ser carregado: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return p;
}

// ------------------------------------------------------------------ aplicação

let appliedTokenNames: string[] = [];

/** Aplica os tokens da UI no `<html>` (remove os do tema anterior). */
function applyUiTokens(t: Pick<ActiveColorTheme, "uiTokens" | "colorScheme" | "kind">): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const toUi = getSetting(SETTING.colorThemeAppliesToUi, true);
  const tokens = toUi ? t.uiTokens : pickEditorOnly(t.uiTokens);
  for (const name of appliedTokenNames) if (!(name in tokens)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  appliedTokenNames = Object.keys(tokens);
  const scheme = toUi ? t.colorScheme : "dark";
  root.style.colorScheme = scheme;
  root.dataset.themeKind = toUi ? t.kind : "dark";
  root.classList.toggle("theme-light", toUi && scheme === "light");
  root.classList.toggle("theme-hc", toUi && (t.kind === "high-contrast" || t.kind === "high-contrast-light"));
}

/** "Só editor e terminal": mantém só o fundo do editor (o resto segue o Fluent). */
function pickEditorOnly(tokens: Record<string, string>): Record<string, string> {
  return tokens["--editor-bg"] ? { "--editor-bg": tokens["--editor-bg"] } : {};
}

// Estado inicial completo (o Monaco precisa da definição do Fluent Escuro).
if (!getActiveColorTheme().monacoTheme) setActiveColorTheme(fromBuiltin(builtinById.get(DEFAULT_COLOR_THEME_ID)!));

let monacoReady = false;
void whenMonacoReady.then(() => {
  monacoReady = true;
  defineAndSet(getActiveColorTheme());
});

function defineAndSet(t: ActiveColorTheme): void {
  if (!monacoReady) return;
  try {
    if (t.monacoTheme) monaco.editor.defineTheme(t.monacoId, t.monacoTheme as monaco.editor.IStandaloneThemeData);
    monaco.editor.setTheme(t.monacoId);
  } catch (err) {
    contributionsLog(`Monaco recusou o tema "${t.label}": ${String(err)}`);
  }
}

function commit(t: ActiveColorTheme): void {
  applyUiTokens(t);
  setActiveColorTheme(t);
  defineAndSet(t);
  writeCache(t);
}

function writeCache(t: ActiveColorTheme): void {
  try {
    if (builtinById.get(t.id)?.id === DEFAULT_COLOR_THEME_ID) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, JSON.stringify(t));
  } catch {
    /* sem cache: o boot aplica o padrão até o tema carregar */
  }
}

/**
 * Antes do 1º paint: reaplica o último tema (tokens da UI já; Monaco quando
 * estiver pronto). Só vale se for o tema da setting atual.
 */
export function applyCachedColorTheme(): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const t = JSON.parse(raw) as ActiveColorTheme;
    const wanted = getSetting(SETTING.colorTheme, DEFAULT_COLOR_THEME_ID);
    if (!t || t.id !== wanted || !t.monacoId || !isObj(t.uiTokens)) return;
    applyUiTokens(t);
    setActiveColorTheme(t);
  } catch {
    /* cache corrompido: ignora */
  }
}

let started = false;

/** Registra o motor no `themeRegistry` (uma vez, no boot). */
export function startColorThemes(): void {
  if (started) return;
  started = true;
  extThemes = collectExtensionThemes();
  // Aplicação inicial depois que a lista de extensões chegar (boot.ts): até
  // lá vale o tema do cache, sem piscar o padrão.
  void registerThemeProvider(
    {
      kind: "color",
      defaultId: DEFAULT_COLOR_THEME_ID,
      entries,
      async applyEntry(entry) {
        commit(await resolveEntry(entry));
      },
    },
    { initialApply: false },
  );
  onDidChangeContributions(() => {
    extThemes = collectExtensionThemes();
    notifyThemeListChanged("color");
  });
  onDidChangeSetting(SETTING.colorThemeAppliesToUi, () => applyUiTokens(getActiveColorTheme()));
}
