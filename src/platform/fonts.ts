/**
 * Pilhas de fonte por SO. O CSS usa `var(--font-ui)`/`var(--font-mono)`
 * (definidos em `styles/tokens.css`, redefinidos por `html.platform-*`); este
 * módulo dá as MESMAS pilhas para quem precisa de uma string em JS (xterm,
 * canvas do Git Graph, codeLens do Monaco, SVG de avatar).
 *
 * Linux: nenhuma Segoe/Cascadia instalada por padrão — sem isso o fallback
 * caía em DejaVu Sans Mono (larga demais para os painéis densos).
 */

import { getPlatform, type OsKind } from "./os.ts";

export interface FontStacks {
  ui: string;
  mono: string;
}

const STACKS: Record<OsKind, FontStacks> = {
  windows: {
    ui: '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    mono: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
  },
  macos: {
    ui: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
    mono: '"SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Code", monospace',
  },
  linux: {
    ui: 'system-ui, Cantarell, "Noto Sans", Ubuntu, "DejaVu Sans", sans-serif',
    mono: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Ubuntu Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace',
  },
};

export function fontStacks(os: OsKind = getPlatform().os): FontStacks {
  return STACKS[os];
}
