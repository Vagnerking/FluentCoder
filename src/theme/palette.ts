/**
 * Central theme palette — F2-AUD-001.
 *
 * Monaco and xterm register their themes with concrete color strings; they
 * cannot read CSS custom properties at registration time. This module is the
 * single source of truth for those literals so the canvas/editor/terminal stay
 * in sync with the CSS token layer in `styles.css`.
 *
 * KEEP IN SYNC with the matching `:root` tokens. When a value here also exists
 * as a CSS token, the token name is noted in a comment.
 */
export const palette = {
  // Core surfaces (mirror --editor-bg / --color-surface-overlay).
  editorBg: "#1c222b",
  surfaceOverlay: "#202734", // --color-surface-overlay
  surfaceOverlayBorder: "#3a4150", // --color-surface-overlay-border

  // Accent (mirror --accent).
  accent: "#60cdff",

  // Foreground ramp.
  text: "#d2dce7",
  textBright: "#ffffff",
  textMuted: "#7d8795",
  textActive: "#d6e2f0",

  // Status (mirror --color-status-*).
  statusError: "#f14c4c",
  statusWarning: "#cca700",
  statusSuccess: "#73c991",

  // Graph node roles (mirror --color-graph-*).
  graphMarkdown: "#60cdff",
  graphCode: "#3ec9a7",
} as const;

/** Terminal (xterm) theme derived from the shared palette. */
export const terminalTheme = {
  background: palette.editorBg,
  foreground: palette.text,
  cursor: palette.accent,
  selectionBackground: "rgba(96,205,255,0.3)",
  black: palette.editorBg,
  brightBlack: "#708090",
  red: palette.statusError,
  brightRed: "#ff99a4",
  green: palette.statusSuccess,
  brightGreen: "#a6e3a1",
  yellow: palette.statusWarning,
  brightYellow: "#e2c08d",
  blue: "#75beff",
  brightBlue: "#9cdcfe",
  magenta: "#c586c0",
  brightMagenta: "#d7a6e0",
  cyan: "#4ec9b0",
  brightCyan: "#7fdbca",
  white: palette.text,
  brightWhite: palette.textBright,
} as const;
