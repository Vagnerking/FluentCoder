/**
 * Mapeia os tokens Fluent do app (styles.css) nas variáveis `--vscode-*` que
 * as UIs de webview das extensões consomem — é o que faz Claude Code e Codex
 * parecerem nativos do Fluent Coder (acrílico, accent, raios) em vez de
 * carregarem o tema do VS Code.
 *
 * `resolve(token)` devolve o valor computado de um token (`--accent` etc.).
 * Mantido puro para teste; `readFluentThemeVars()` liga ao DOM.
 */

import { getActiveColorTheme, webviewThemeKind } from "../theme/activeTheme.ts";

type Resolve = (token: string) => string;

/** `rgba(r, g, b, a)` → `rgb(r, g, b)`; outras cores passam inalteradas. */
export function opaque(color: string): string {
  const m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i.exec(color.trim());
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : color.trim();
}

const FONT_UI =
  "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
const FONT_MONO = "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace";

export function buildVscodeThemeVars(resolve: Resolve): Record<string, string> {
  const t = (name: string, fallback: string) => resolve(name).trim() || fallback;
  const accent = t("--accent", "#60cdff");
  const accentStrong = t("--accent-strong", "#0e639c");
  const text = t("--text", "#ffffff");
  const textSecondary = t("--text-secondary", "rgba(255,255,255,0.82)");
  const textMuted = t("--text-muted", "rgba(255,255,255,0.54)");
  const textDisabled = t("--text-disabled", "rgba(255,255,255,0.36)");
  const sidebarBg = t("--acrylic-tint-strong", "rgba(28,34,43,0.9)");
  const editorBg = t("--editor-bg", "#1c222b");
  const overlay = t("--color-surface-overlay", "#202734");
  const overlayBorder = t("--color-surface-overlay-border", "#3a4150");
  const control = t("--acrylic-control", "rgba(211,229,243,0.075)");
  const controlHover = t("--acrylic-control-hover", "rgba(211,229,243,0.12)");
  const border = t("--acrylic-border", "rgba(210,228,242,0.13)");
  const borderStrong = t("--acrylic-border-strong", "rgba(210,228,242,0.2)");
  const subtle = t("--border-subtle", "rgba(255,255,255,0.08)");
  const selected = t("--fill-selected", "rgba(96,205,255,0.16)");
  const selectedHover = t("--fill-selected-hover", "rgba(96,205,255,0.22)");
  const error = t("--color-status-error", "#f14c4c");
  const warning = t("--color-status-warning", "#cca700");
  const success = t("--color-status-success", "#73c991");
  const info = t("--color-status-info", accent);
  const added = t("--color-git-added", "#73c991");
  const deleted = t("--color-git-deleted", "#f14c4c");
  const modified = t("--color-git-modified", "#e2c08d");
  const radius = t("--radius-control", "6px");

  return {
    // Tipografia
    // Pilhas por SO (tokens.css → html.platform-*); as constantes são o fallback.
    "--vscode-font-family": t("--font-ui", FONT_UI),
    "--vscode-font-size": "13px",
    "--vscode-font-weight": "normal",
    "--vscode-editor-font-family": t("--font-mono", FONT_MONO),
    "--vscode-editor-font-size": "13px",
    "--vscode-editor-font-weight": "normal",
    "--monaco-monospace-font": t("--font-mono", FONT_MONO),
    // Base
    "--vscode-foreground": text,
    "--vscode-descriptionForeground": textMuted,
    "--vscode-disabledForeground": textDisabled,
    "--vscode-errorForeground": error,
    "--vscode-icon-foreground": textSecondary,
    "--vscode-focusBorder": accent,
    "--vscode-contrastBorder": "transparent",
    "--vscode-widget-border": border,
    "--vscode-widget-shadow": "rgba(0,0,0,0.36)",
    "--vscode-selection-background": selected,
    "--vscode-sash-hoverBorder": accent,
    // Superfícies — o tom do acrílico do dock, porém OPACO: as UIs usam a cor
    // da sidebar em cabeçalhos fixos, máscaras e color-mix (transparente
    // deixaria o conteúdo rolando aparecer por trás).
    "--vscode-sideBar-background": opaque(sidebarBg),
    "--vscode-sideBar-foreground": text,
    "--vscode-sideBar-border": subtle,
    "--vscode-sideBarTitle-foreground": textSecondary,
    "--vscode-sideBarSectionHeader-background": "transparent",
    "--vscode-sideBarSectionHeader-foreground": textSecondary,
    "--vscode-sideBarSectionHeader-border": subtle,
    "--vscode-panel-background": opaque(sidebarBg),
    "--vscode-panel-border": subtle,
    "--vscode-editor-background": editorBg,
    "--vscode-editor-foreground": text,
    "--vscode-editorWidget-background": overlay,
    "--vscode-editorWidget-foreground": text,
    "--vscode-editorWidget-border": overlayBorder,
    "--vscode-editorGroupHeader-tabsBackground": "transparent",
    "--vscode-editor-selectionBackground": selectedHover,
    "--vscode-editor-inactiveSelectionBackground": selected,
    "--vscode-editor-findMatchHighlightBackground": "rgba(234,92,0,0.33)",
    "--vscode-editorLineNumber-foreground": textMuted,
    "--vscode-editorCursor-foreground": accent,
    "--vscode-editorHoverWidget-background": overlay,
    "--vscode-editorHoverWidget-border": overlayBorder,
    // Controles
    "--vscode-button-background": accent,
    "--vscode-button-foreground": "#000000",
    "--vscode-button-hoverBackground": accentStrong,
    "--vscode-button-border": "transparent",
    "--vscode-button-secondaryBackground": control,
    "--vscode-button-secondaryForeground": text,
    "--vscode-button-secondaryHoverBackground": controlHover,
    "--vscode-input-background": control,
    "--vscode-input-foreground": text,
    "--vscode-input-border": border,
    "--vscode-input-placeholderForeground": textMuted,
    "--vscode-inputOption-activeBorder": accent,
    "--vscode-inputOption-activeBackground": selected,
    "--vscode-inputValidation-errorBackground": "rgba(241,76,76,0.16)",
    "--vscode-inputValidation-errorBorder": error,
    "--vscode-inputValidation-warningBackground": "rgba(204,167,0,0.16)",
    "--vscode-inputValidation-warningBorder": warning,
    "--vscode-inputValidation-infoBackground": selected,
    "--vscode-inputValidation-infoBorder": info,
    "--vscode-dropdown-background": overlay,
    "--vscode-dropdown-foreground": text,
    "--vscode-dropdown-border": overlayBorder,
    "--vscode-dropdown-listBackground": overlay,
    "--vscode-checkbox-background": control,
    "--vscode-checkbox-border": borderStrong,
    "--vscode-checkbox-foreground": text,
    "--vscode-badge-background": accent,
    "--vscode-badge-foreground": "#000000",
    "--vscode-progressBar-background": accent,
    "--vscode-toolbar-hoverBackground": controlHover,
    "--vscode-toolbar-activeBackground": selected,
    "--vscode-keybindingLabel-background": control,
    "--vscode-keybindingLabel-foreground": text,
    "--vscode-keybindingLabel-border": border,
    "--vscode-keybindingLabel-bottomBorder": borderStrong,
    // Listas / menus
    "--vscode-list-hoverBackground": controlHover,
    "--vscode-list-hoverForeground": text,
    "--vscode-list-activeSelectionBackground": selected,
    "--vscode-list-activeSelectionForeground": text,
    "--vscode-list-inactiveSelectionBackground": selected,
    "--vscode-list-focusOutline": accent,
    "--vscode-list-highlightForeground": accent,
    "--vscode-quickInput-background": overlay,
    "--vscode-quickInput-foreground": text,
    "--vscode-quickInputList-focusBackground": selected,
    "--vscode-menu-background": overlay,
    "--vscode-menu-foreground": text,
    "--vscode-menu-border": overlayBorder,
    "--vscode-menu-selectionBackground": selected,
    "--vscode-menu-selectionForeground": text,
    "--vscode-menu-separatorBackground": subtle,
    // Texto rico / links / código
    "--vscode-textLink-foreground": accent,
    "--vscode-textLink-activeForeground": accent,
    "--vscode-textPreformat-foreground": "#d7ba7d",
    "--vscode-textPreformat-background": control,
    "--vscode-textCodeBlock-background": "rgba(0,0,0,0.24)",
    "--vscode-textBlockQuote-background": control,
    "--vscode-textBlockQuote-border": accent,
    "--vscode-textSeparator-foreground": subtle,
    // Scrollbar
    "--vscode-scrollbar-shadow": "transparent",
    "--vscode-scrollbarSlider-background": "rgba(255,255,255,0.14)",
    "--vscode-scrollbarSlider-hoverBackground": "rgba(255,255,255,0.22)",
    "--vscode-scrollbarSlider-activeBackground": "rgba(255,255,255,0.3)",
    // Status / diff / git
    "--vscode-editorError-foreground": error,
    "--vscode-editorWarning-foreground": warning,
    "--vscode-editorInfo-foreground": info,
    "--vscode-testing-iconPassed": success,
    "--vscode-charts-red": error,
    "--vscode-charts-yellow": warning,
    "--vscode-charts-green": success,
    "--vscode-charts-blue": accent,
    "--vscode-charts-orange": "#e0a23b",
    "--vscode-charts-purple": "#b180d7",
    "--vscode-diffEditor-insertedTextBackground": "rgba(115,201,145,0.18)",
    "--vscode-diffEditor-removedTextBackground": "rgba(241,76,76,0.18)",
    "--vscode-diffEditor-insertedLineBackground": "rgba(115,201,145,0.10)",
    "--vscode-diffEditor-removedLineBackground": "rgba(241,76,76,0.10)",
    "--vscode-gitDecoration-addedResourceForeground": added,
    "--vscode-gitDecoration-deletedResourceForeground": deleted,
    "--vscode-gitDecoration-modifiedResourceForeground": modified,
    "--vscode-notifications-background": overlay,
    "--vscode-notifications-foreground": text,
    "--vscode-notifications-border": overlayBorder,
    // Chat (VS Code ≥ 1.9x)
    "--vscode-chat-requestBackground": control,
    "--vscode-chat-requestBorder": border,
    "--vscode-chat-slashCommandBackground": selected,
    "--vscode-chat-slashCommandForeground": accent,
    "--vscode-chat-font-family": t("--font-ui", FONT_UI),
    "--vscode-chat-font-size": "13px",
    // Identidade Fluent extra (as extensões ignoram; útil para overrides)
    "--fluent-radius-control": radius,
  };
}

/**
 * Lê os tokens computados do documento do app. Com um tema de extensão ativo,
 * as cores dele (`colors` → `--vscode-*`) vencem as derivadas dos tokens: o
 * webview fica com o tema escolhido, não só com o Fluent.
 */
export function readFluentThemeVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return { ...buildVscodeThemeVars((name) => style.getPropertyValue(name)), ...getActiveColorTheme().vscodeVars };
}

/** `kind` do tema ativo no formato dos webviews/host (`dark`/`light`/`high-contrast`). */
export function activeWebviewThemeKind(): "dark" | "light" | "high-contrast" {
  return webviewThemeKind();
}
