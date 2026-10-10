/**
 * Conversões puras entre o estado do editor (Monaco, abas do App) e os
 * formatos do protocolo IDE do Claude Code (ver `src-tauri/src/agents/
 * ide_bridge.rs` e o ADR 0006). Módulo folha, sem Monaco/Tauri, para os testes
 * unitários travarem os formatos — o CLI espera linhas/colunas **0-based**
 * (convenção LSP), enquanto o Monaco é 1-based.
 */

export interface IdePosition {
  line: number;
  character: number;
}

export interface IdeSelection {
  text: string;
  filePath: string;
  selection: { start: IdePosition; end: IdePosition; isEmpty: boolean };
}

export interface IdeDiagnostic {
  message: string;
  severity: "Error" | "Warning" | "Information" | "Hint";
  range: { start: IdePosition; end: IdePosition };
  source?: string;
}

export interface IdeFileDiagnostics {
  uri: string;
  diagnostics: IdeDiagnostic[];
}

export interface IdeTab {
  uri: string;
  path: string;
  isActive: boolean;
  label: string;
  languageId: string;
  isDirty: boolean;
}

/** Faixa no formato do Monaco (1-based). */
export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Subconjunto de `monaco.editor.IMarker` usado aqui. */
export interface MarkerLike extends MonacoRange {
  /** Caminho do arquivo dono do marker. */
  path: string;
  /** URI `file://` do arquivo. */
  uri: string;
  message: string;
  /** `monaco.MarkerSeverity`: Hint=1, Info=2, Warning=4, Error=8. */
  severity: number;
  source?: string;
  owner?: string;
}

/** Monaco (1-based) → posição do protocolo (0-based). */
export function toIdePosition(lineNumber: number, column: number): IdePosition {
  return { line: Math.max(0, lineNumber - 1), character: Math.max(0, column - 1) };
}

export function toIdeSelection(
  filePath: string,
  text: string,
  range: MonacoRange
): IdeSelection {
  const start = toIdePosition(range.startLineNumber, range.startColumn);
  const end = toIdePosition(range.endLineNumber, range.endColumn);
  return {
    text,
    filePath,
    selection: {
      start,
      end,
      isEmpty: start.line === end.line && start.character === end.character,
    },
  };
}

export function markerSeverityToIde(severity: number): IdeDiagnostic["severity"] {
  if (severity >= 8) return "Error";
  if (severity >= 4) return "Warning";
  if (severity >= 2) return "Information";
  return "Hint";
}

/** Agrupa markers por arquivo, na ordem em que os arquivos aparecem. */
export function markersToDiagnostics(markers: MarkerLike[]): IdeFileDiagnostics[] {
  const byUri = new Map<string, IdeFileDiagnostics>();
  for (const m of markers) {
    let entry = byUri.get(m.uri);
    if (!entry) {
      entry = { uri: m.uri, diagnostics: [] };
      byUri.set(m.uri, entry);
    }
    const diag: IdeDiagnostic = {
      message: m.message,
      severity: markerSeverityToIde(m.severity),
      range: {
        start: toIdePosition(m.startLineNumber, m.startColumn),
        end: toIdePosition(m.endLineNumber, m.endColumn),
      },
    };
    const source = m.source ?? m.owner;
    if (source) diag.source = source;
    entry.diagnostics.push(diag);
  }
  return [...byUri.values()];
}

/** Abas abertas no formato `getOpenEditors` (dedupe por caminho). */
export function filesToIdeTabs(
  files: { path: string; name: string; dirty: boolean }[],
  activePath: string | null,
  uriFor: (path: string) => string,
  languageFor: (name: string, path: string) => string
): IdeTab[] {
  const seen = new Set<string>();
  const tabs: IdeTab[] = [];
  for (const f of files) {
    if (seen.has(f.path) || !isDiskPath(f.path)) continue;
    seen.add(f.path);
    tabs.push({
      uri: uriFor(f.path),
      path: f.path,
      isActive: f.path === activePath,
      label: f.name,
      languageId: languageFor(f.name, f.path),
      isDirty: f.dirty,
    });
  }
  return tabs;
}

/** Abas sintéticas (`untitled:`, `fluentcoder://graph`) não são arquivos. */
export function isDiskPath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** O buffer do editor é sempre LF; o CLI pode mandar CRLF. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Faixa (1-based, Monaco) de `startText`…`endText` no conteúdo, para o
 * `openFile` com seleção. Sem `endText`, seleciona só o `startText`. `null`
 * quando o texto não é encontrado.
 */
export function findTextRange(
  content: string,
  startText?: string,
  endText?: string
): MonacoRange | null {
  if (!startText) return null;
  const startIdx = content.indexOf(startText);
  if (startIdx < 0) return null;
  let endIdx = startIdx + startText.length;
  if (endText) {
    const e = content.indexOf(endText, startIdx);
    if (e >= 0) endIdx = e + endText.length;
  }
  const pos = (offset: number) => {
    const before = content.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    return { line, column };
  };
  const s = pos(startIdx);
  const e = pos(endIdx);
  return {
    startLineNumber: s.line,
    startColumn: s.column,
    endLineNumber: e.line,
    endColumn: e.column,
  };
}

// ---- resultados de ferramenta (MCP `tools/call`) -------------------------

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value));
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Diff aceito: `FILE_SAVED` + o conteúdo final (o usuário pode ter ajustado o
 * lado direito do diff antes de aceitar — mesmo formato da extensão oficial).
 */
export function diffAcceptedResult(finalContents: string): ToolResult {
  return {
    content: [
      { type: "text", text: "FILE_SAVED" },
      { type: "text", text: finalContents },
    ],
  };
}

export function diffRejectedResult(): ToolResult {
  return textResult("DIFF_REJECTED");
}

export function saveDocumentResult(filePath: string, saved: boolean, error?: string): ToolResult {
  return jsonResult(
    saved
      ? { success: true, filePath, saved: true, message: "Document saved successfully" }
      : { success: false, filePath, saved: false, message: error ?? "Failed to save document" }
  );
}

/** Request de ferramenta encaminhado pelo backend (`ide-bridge://request`). */
export interface IdeBridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Argumentos de `openDiff`, validados. `null` se faltar campo obrigatório. */
export function parseOpenDiffArgs(args: Record<string, unknown>): {
  oldPath: string;
  newPath: string;
  newContents: string;
  tabName: string;
} | null {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : null);
  const newPath = str("new_file_path") ?? str("old_file_path");
  const newContents = str("new_file_contents");
  if (!newPath || newContents == null) return null;
  return {
    oldPath: str("old_file_path") ?? newPath,
    newPath,
    newContents: normalizeEol(newContents),
    tabName: str("tab_name") ?? baseName(newPath),
  };
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
