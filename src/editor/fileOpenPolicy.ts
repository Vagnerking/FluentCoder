/**
 * Política de abertura de arquivos por tamanho/conteúdo (par do
 * `probe_file`/`read_file` do Rust, `src-tauri/src/fs_commands.rs`).
 *
 * - binário (NUL nos primeiros 8 KB): pergunta antes de abrir como texto;
 * - acima de `HUGE_FILE_BYTES` (50 MB, o `files.maxMemoryForLargeFilesMB` do
 *   VS Code): pergunta e, se o usuário aceitar, abre SOMENTE LEITURA em modo
 *   de arquivo grande;
 * - acima de `LARGE_FILE_BYTES` (5 MB): modo de arquivo grande — sem LSP,
 *   tokens semânticos, folding, minimap, codeLens, quebra de linha etc.
 */

export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
export const HUGE_FILE_BYTES = 50 * 1024 * 1024;

export interface FileProbe {
  size: number;
  binary: boolean;
}

export type OpenDecision =
  | { kind: "normal" }
  | { kind: "large" }
  /** Precisa de confirmação; se aceito, abre somente leitura + modo grande. */
  | { kind: "confirm-huge" }
  /** Precisa de confirmação para abrir binário como texto. */
  | { kind: "confirm-binary"; large: boolean };

/** Limites efetivos (settings `fluent.editor.largeFileThresholdMB` e
 *  `files.maxMemoryForLargeFilesMB`; o "enorme" nunca passa dos 50 MB que o
 *  `read_file` do Rust aceita sem confirmação). */
export interface OpenLimits {
  large: number;
  huge: number;
}

export function openLimitsFromSettings(largeMB: unknown, hugeMB: unknown): OpenLimits {
  const mb = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d) * 1024 * 1024;
  const huge = Math.min(mb(hugeMB, 50), HUGE_FILE_BYTES);
  return { large: Math.min(mb(largeMB, 5), huge), huge };
}

export function decideOpen(probe: FileProbe, limits: OpenLimits = { large: LARGE_FILE_BYTES, huge: HUGE_FILE_BYTES }): OpenDecision {
  if (probe.binary) return { kind: "confirm-binary", large: probe.size > limits.large };
  if (probe.size > limits.huge) return { kind: "confirm-huge" };
  if (probe.size > limits.large) return { kind: "large" };
  return { kind: "normal" };
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Opções do Monaco no modo de arquivo grande: desliga o que custa
 * proporcionalmente ao tamanho do documento. A linguagem também vira
 * `plaintext` (ver `largeFileLanguage`), o que impede o `didOpen` nos
 * servidores LSP e os tokens semânticos.
 */
export const LARGE_FILE_EDITOR_OPTIONS = {
  largeFileOptimizations: true,
  maxTokenizationLineLength: 2000,
  stopRenderingLineAfter: 10000,
  folding: false,
  wordWrap: "off",
  minimap: { enabled: false },
  codeLens: false,
  occurrencesHighlight: "off",
  selectionHighlight: false,
  renderWhitespace: "none",
  links: false,
  colorDecorators: false,
  bracketPairColorization: { enabled: false },
  guides: { indentation: false, bracketPairs: false },
  stickyScroll: { enabled: false },
  semanticHighlighting: { enabled: false },
  quickSuggestions: false,
  wordBasedSuggestions: "off",
  hover: { enabled: "off" },
} as const;

export function largeFileLanguage(language: string, largeFile: boolean | undefined): string {
  return largeFile ? "plaintext" : language;
}
