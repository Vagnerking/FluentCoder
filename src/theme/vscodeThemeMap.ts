/**
 * Cores de workbench de um tema VS Code (`colors`) → tokens Fluent da UI
 * (`src/styles/tokens.css`) e → tema do terminal (xterm).
 *
 * Tabela explícita (`TOKEN_MAP`): cada token lista as chaves VS Code que o
 * alimentam, em ordem de preferência, e uma reserva derivada das cores base
 * (fundo do editor, texto, acento). Cor ausente/inválida → reserva; nunca
 * `var()`/`url()` (só hex validado). Contraste mínimo garantido para texto
 * (4,5:1) e acento/ícones (3:1) — guia Fluent 2 (docs/design/fluent-design.md).
 * Seleção, raios, espaçamento, tipografia e motion continuam do Fluent.
 *
 * Puro (testado em themes.test.ts).
 */
import { ensureContrast, flatten, isDark, mix, parseColor, toCss, withAlpha, type Rgba } from "./colors.ts";
import type { UiTheme } from "./colorThemeModel.ts";

export interface DerivedBase {
  dark: boolean;
  editorBg: Rgba;
  fg: Rgba;
  sideBg: Rgba;
  accent: Rgba;
}

type Colors = Record<string, string>;

interface TokenRule {
  /** Token CSS (`--accent`…). */
  token: string;
  /** Chaves VS Code, em ordem de preferência. */
  from: readonly string[];
  /** Reserva derivada quando nenhuma chave existe. */
  fallback: (b: DerivedBase, pick: (k: string) => Rgba | null) => Rgba | string;
  /** Contraste mínimo contra outro token já resolvido (fundo). */
  contrast?: { against: "editorBg" | "sideBg" | "overlay"; min: number };
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const shade = (b: DerivedBase, t: number) => mix(b.editorBg, b.dark ? BLACK : WHITE, t);
const tint = (b: DerivedBase, t: number) => mix(b.editorBg, b.fg, t);

/**
 * Tabela completa: token Fluent ← cores do workbench VS Code.
 * (Documentada em docs/context/temas.md; a ordem importa: tokens usados como
 * fundo em `contrast.against` são resolvidos antes.)
 */
export const TOKEN_MAP: readonly TokenRule[] = [
  { token: "--editor-bg", from: ["editor.background"], fallback: (b) => b.editorBg },
  { token: "--sidebar-bg", from: ["sideBar.background"], fallback: (b) => b.sideBg },
  { token: "--acrylic-tint", from: ["sideBar.background", "panel.background"], fallback: (b) => b.sideBg },
  { token: "--acrylic-tint-strong", from: ["sideBar.background", "panel.background"], fallback: (b) => b.sideBg },
  { token: "--shell-bg", from: ["titleBar.activeBackground", "activityBar.background", "statusBar.background"], fallback: (b) => shade(b, 0.25) },
  { token: "--shell-bg-solid", from: ["titleBar.activeBackground", "activityBar.background", "statusBar.background"], fallback: (b) => shade(b, 0.25) },
  { token: "--shell-glow", from: [], fallback: () => "none" },
  { token: "--titlebar-bg", from: ["titleBar.activeBackground", "activityBar.background"], fallback: (b) => shade(b, 0.25) },
  { token: "--tabbar-bg", from: ["editorGroupHeader.tabsBackground", "tab.inactiveBackground"], fallback: (b) => b.sideBg },
  { token: "--color-surface-raised", from: ["editorWidget.background", "dropdown.background", "menu.background"], fallback: (b) => tint(b, 0.06) },
  { token: "--color-surface-overlay", from: ["editorWidget.background", "menu.background", "quickInput.background", "dropdown.background"], fallback: (b) => tint(b, 0.06) },
  { token: "--color-surface-overlay-border", from: ["editorWidget.border", "menu.border", "widget.border", "contrastBorder"], fallback: (b) => tint(b, 0.2) },
  { token: "--color-surface-flyout-acrylic", from: ["menu.background", "editorWidget.background", "quickInput.background"], fallback: (b) => tint(b, 0.06) },
  // Texto (contraste AA contra a superfície onde mais aparece).
  { token: "--text", from: ["foreground", "sideBar.foreground", "editor.foreground"], fallback: (b) => b.fg, contrast: { against: "sideBg", min: 4.5 } },
  { token: "--text-secondary", from: ["sideBarTitle.foreground", "sideBar.foreground"], fallback: (b) => withAlpha(b.fg, 0.82), contrast: { against: "sideBg", min: 4.5 } },
  { token: "--text-muted", from: ["descriptionForeground", "tab.inactiveForeground"], fallback: (b) => withAlpha(b.fg, 0.6), contrast: { against: "sideBg", min: 3 } },
  { token: "--text-disabled", from: ["disabledForeground"], fallback: (b) => withAlpha(b.fg, 0.38) },
  // Acento (focus, links, seleção ativa, botões primários).
  { token: "--accent", from: ["activityBarBadge.background", "progressBar.background", "focusBorder", "textLink.foreground", "button.background"], fallback: (b) => b.accent, contrast: { against: "editorBg", min: 3 } },
  { token: "--accent-strong", from: ["button.background", "focusBorder"], fallback: (b) => mix(b.accent, b.dark ? BLACK : WHITE, 0.35) },
  { token: "--accent-hover", from: ["button.hoverBackground"], fallback: (b) => mix(b.accent, b.dark ? WHITE : BLACK, 0.15) },
  { token: "--accent-pressed", from: [], fallback: (b) => mix(b.accent, b.dark ? BLACK : WHITE, 0.12) },
  { token: "--text-on-accent", from: ["activityBarBadge.foreground", "button.foreground"], fallback: (b) => (isDark(b.accent) ? WHITE : BLACK) },
  { token: "--stroke-focus", from: ["focusBorder"], fallback: (b) => b.accent },
  // Controles e bordas.
  { token: "--acrylic-control", from: ["input.background", "dropdown.background"], fallback: (b) => withAlpha(b.fg, 0.075) },
  { token: "--acrylic-control-hover", from: ["toolbar.hoverBackground", "list.hoverBackground"], fallback: (b) => withAlpha(b.fg, 0.12) },
  { token: "--acrylic-control-pressed", from: ["toolbar.activeBackground"], fallback: (b) => withAlpha(b.fg, 0.055) },
  { token: "--acrylic-luminosity", from: [], fallback: (b) => withAlpha(b.fg, 0.05) },
  { token: "--acrylic-border", from: ["widget.border", "sideBar.border", "panel.border", "contrastBorder"], fallback: (b) => withAlpha(b.fg, 0.13) },
  { token: "--acrylic-border-strong", from: ["input.border", "dropdown.border", "contrastActiveBorder"], fallback: (b) => withAlpha(b.fg, 0.2) },
  { token: "--border-subtle", from: ["editorGroup.border", "panel.border", "sideBarSectionHeader.border"], fallback: (b) => withAlpha(b.fg, 0.08) },
  { token: "--stroke", from: ["tree.indentGuidesStroke"], fallback: (b) => withAlpha(b.fg, 0.06) },
  { token: "--fill-selected", from: ["list.activeSelectionBackground", "list.inactiveSelectionBackground"], fallback: (b) => withAlpha(b.accent, 0.16) },
  { token: "--fill-selected-hover", from: ["list.focusBackground", "list.activeSelectionBackground"], fallback: (b) => withAlpha(b.accent, 0.22) },
  { token: "--fill-recessed", from: [], fallback: (b) => withAlpha(BLACK, b.dark ? 0.16 : 0.05) },
  // Status, git, busca.
  { token: "--error", from: ["errorForeground", "editorError.foreground"], fallback: () => parseColor("#f14c4c")! },
  { token: "--color-status-error", from: ["editorError.foreground", "errorForeground", "list.errorForeground"], fallback: () => parseColor("#f14c4c")! },
  { token: "--color-status-error-muted", from: ["gitDecoration.deletedResourceForeground"], fallback: () => parseColor("#c74e39")! },
  { token: "--color-status-warning", from: ["editorWarning.foreground", "list.warningForeground"], fallback: (b) => parseColor(b.dark ? "#cca700" : "#bf8803")! },
  { token: "--color-status-warning-strong", from: ["list.warningForeground", "editorWarning.foreground"], fallback: (b) => parseColor(b.dark ? "#e0a23b" : "#bf8803")! },
  { token: "--color-status-success", from: ["testing.iconPassed", "gitDecoration.addedResourceForeground", "terminal.ansiGreen"], fallback: (b) => parseColor(b.dark ? "#73c991" : "#388a34")! },
  { token: "--color-git-modified", from: ["gitDecoration.modifiedResourceForeground"], fallback: (b) => parseColor(b.dark ? "#e2c08d" : "#895503")! },
  { token: "--color-git-added", from: ["gitDecoration.addedResourceForeground"], fallback: (b) => parseColor(b.dark ? "#73c991" : "#587c0c")! },
  { token: "--color-git-untracked", from: ["gitDecoration.untrackedResourceForeground", "gitDecoration.addedResourceForeground"], fallback: (b) => parseColor(b.dark ? "#73c991" : "#007100")! },
  { token: "--color-git-deleted", from: ["gitDecoration.deletedResourceForeground"], fallback: (b) => parseColor(b.dark ? "#f14c4c" : "#ad0707")! },
  { token: "--color-git-deleted-strong", from: ["gitDecoration.deletedResourceForeground"], fallback: () => parseColor("#c74e39")! },
  { token: "--color-git-renamed", from: ["gitDecoration.renamedResourceForeground"], fallback: (b) => b.accent },
  { token: "--color-git-conflict", from: ["gitDecoration.conflictingResourceForeground"], fallback: (b) => parseColor(b.dark ? "#e4676b" : "#ad0707")! },
  { token: "--color-git-conflict-strong", from: ["gitDecoration.conflictingResourceForeground"], fallback: () => parseColor("#e0a23b")! },
  { token: "--color-find-match", from: ["editor.findMatchHighlightBackground"], fallback: () => parseColor("#ffc53d4d")! },
  { token: "--color-find-match-strong", from: ["editor.findMatchBackground"], fallback: () => parseColor("#ffc53d6b")! },
  { token: "--color-scrim", from: ["widget.shadow"], fallback: (b) => withAlpha(BLACK, b.dark ? 0.4 : 0.25) },
  { token: "--color-graph-code", from: ["terminal.ansiCyan"], fallback: () => parseColor("#3ec9a7")! },
];

function pickColor(colors: Colors, k: string): Rgba | null {
  return parseColor(colors[k]);
}

/** Cores base de um tema (fundo do editor, texto, barra lateral, acento). */
export function deriveBase(colors: Colors, ui: UiTheme): DerivedBase {
  const light = ui === "vs" || ui === "hc-light";
  const editorBg = pickColor(colors, "editor.background") ?? parseColor(ui === "hc-black" ? "#000000" : light ? "#ffffff" : "#1e1e1e")!;
  const dark = isDark(editorBg);
  const fg = pickColor(colors, "foreground") ?? pickColor(colors, "editor.foreground") ?? parseColor(dark ? "#cccccc" : "#3b3b3b")!;
  const sideBg = flatten(pickColor(colors, "sideBar.background") ?? editorBg, editorBg);
  const accentRaw =
    ["activityBarBadge.background", "progressBar.background", "focusBorder", "textLink.foreground", "button.background", "editorCursor.foreground"]
      .map((k) => pickColor(colors, k))
      .find((c): c is Rgba => !!c && c.a > 0.3) ?? parseColor(dark ? "#60cdff" : "#005fb8")!;
  return { dark, editorBg: flatten(editorBg, dark ? BLACK : WHITE), fg, sideBg, accent: flatten(accentRaw, editorBg) };
}

export interface UiTokens {
  /** Token CSS → valor (hex/rgba ou `none`). */
  tokens: Record<string, string>;
  colorScheme: "dark" | "light";
}

/** `colors` de um tema → valores dos tokens Fluent. */
export function cssTokensFromTheme(colors: Colors, ui: UiTheme): UiTokens {
  const b = deriveBase(colors, ui);
  const pick = (k: string) => pickColor(colors, k);
  const resolved: Record<string, Rgba | string> = {};
  const bgOf = (which: "editorBg" | "sideBg" | "overlay"): Rgba =>
    which === "editorBg" ? b.editorBg : which === "sideBg" ? b.sideBg : flatten((resolved["--color-surface-overlay"] as Rgba) ?? b.editorBg, b.editorBg);
  for (const rule of TOKEN_MAP) {
    let v: Rgba | string | null = null;
    for (const k of rule.from) {
      const c = pick(k);
      if (c) {
        v = c;
        break;
      }
    }
    if (!v) v = rule.fallback(b, pick);
    if (typeof v !== "string" && rule.contrast) v = ensureContrast(v, bgOf(rule.contrast.against), rule.contrast.min);
    resolved[rule.token] = v;
  }
  // Superfícies de flyout/overlay precisam ser OPACAS (texto do editor não vaza).
  for (const t of ["--color-surface-overlay", "--color-surface-raised"]) {
    const c = resolved[t];
    if (typeof c !== "string") resolved[t] = flatten(c, b.editorBg);
  }
  const fly = resolved["--color-surface-flyout-acrylic"];
  if (typeof fly !== "string") resolved["--color-surface-flyout-acrylic"] = withAlpha(flatten(fly, b.editorBg), 0.9);
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(resolved)) tokens[k] = typeof v === "string" ? v : toCss(v);
  return { tokens, colorScheme: b.dark ? "dark" : "light" };
}

/** Tema do xterm (`ITheme`). */
export interface TerminalThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"] as const;

/** Paleta ANSI padrão do VS Code (escura e clara). */
const ANSI_DEFAULTS = {
  dark: ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"],
  light: ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"],
};

export function terminalThemeFromColors(colors: Colors, ui: UiTheme): TerminalThemeColors {
  const b = deriveBase(colors, ui);
  const hex = (k: string) => {
    const c = pickColor(colors, k);
    return c ? toCss(c) : null;
  };
  const defaults = b.dark ? ANSI_DEFAULTS.dark : ANSI_DEFAULTS.light;
  const out: Record<string, string> = {
    background: hex("terminal.background") ?? hex("panel.background") ?? toCss(b.editorBg),
    foreground: hex("terminal.foreground") ?? toCss(b.fg),
    cursor: hex("terminalCursor.foreground") ?? toCss(b.accent),
    selectionBackground: hex("terminal.selectionBackground") ?? toCss(withAlpha(b.accent, 0.3)),
  };
  ANSI.forEach((name, i) => {
    out[name.toLowerCase()] = hex(`terminal.ansi${name}`) ?? defaults[i];
    out[`bright${name}`] = hex(`terminal.ansiBright${name}`) ?? defaults[i + 8];
  });
  return out as unknown as TerminalThemeColors;
}

/** `colors` do tema → variáveis `--vscode-*` (para os webviews de extensão). */
export function vscodeCssVars(colors: Colors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) {
    if (/^[\w.-]+$/.test(k) && parseColor(v)) out[`--vscode-${k.replace(/\./g, "-")}`] = v;
  }
  return out;
}
