/**
 * Estado do tema de cor APLICADO (o que o editor, o terminal, os webviews de
 * extensão e as gramáticas TextMate consomem). Sem Monaco/React: qualquer
 * módulo pode ler (`getActiveColorTheme`) e assinar (`onDidChangeActiveColorTheme`).
 * Quem escreve é o serviço de temas (`colorThemeService.ts`).
 */
import type { TerminalThemeColors } from "./vscodeThemeMap.ts";
import type { MonacoThemeData } from "./monacoTheme.ts";
import type { TokenColorRule } from "./tmScopes.ts";
import { FLUENT_DARK } from "./builtinThemes.ts";

export type ColorThemeKind = "light" | "dark" | "high-contrast" | "high-contrast-light";

export interface ActiveColorTheme {
  /** Id de settings (`workbench.colorTheme`). */
  id: string;
  label: string;
  /** Id do tema no Monaco standalone (`defineTheme`). */
  monacoId: string;
  monacoTheme: MonacoThemeData | null;
  kind: ColorThemeKind;
  colorScheme: "dark" | "light";
  /** Tokens CSS aplicados no `<html>` (vazio = os do tokens.css). */
  uiTokens: Record<string, string>;
  terminal: TerminalThemeColors;
  /** `colors` do tema como `--vscode-*` (webviews de extensão). */
  vscodeVars: Record<string, string>;
  /** `tokenColors` (as gramáticas TextMate resolvem estilo por escopo). */
  tokenColors: TokenColorRule[];
  defaultForeground: string;
}

let active: ActiveColorTheme = {
  id: FLUENT_DARK.id,
  label: FLUENT_DARK.label,
  monacoId: FLUENT_DARK.monacoId,
  monacoTheme: null,
  kind: "dark",
  colorScheme: "dark",
  uiTokens: {},
  terminal: FLUENT_DARK.terminal,
  vscodeVars: {},
  tokenColors: FLUENT_DARK.theme.tokenColors,
  defaultForeground: FLUENT_DARK.theme.colors["editor.foreground"] ?? "#d4d4d4",
};
const listeners = new Set<(t: ActiveColorTheme) => void>();

export function getActiveColorTheme(): ActiveColorTheme {
  return active;
}

export function setActiveColorTheme(next: ActiveColorTheme): void {
  active = next;
  for (const l of [...listeners]) {
    try {
      l(next);
    } catch {
      /* um consumidor com erro não impede os demais */
    }
  }
}

export function onDidChangeActiveColorTheme(listener: (t: ActiveColorTheme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `kind` no formato do host de extensões/webviews (`dark`/`light`/`high-contrast`). */
export function webviewThemeKind(kind: ColorThemeKind = active.kind): "dark" | "light" | "high-contrast" {
  return kind === "light" || kind === "high-contrast-light" ? "light" : kind === "high-contrast" ? "high-contrast" : "dark";
}
