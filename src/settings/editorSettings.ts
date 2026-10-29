/**
 * Settings → Monaco. Puro (testável): `editorOptionsFromSettings` monta as
 * opções do editor a partir de um `get(key)` já resolvido para a linguagem e o
 * arquivo; `indentationFor` decide tabSize/insertSpaces/detecção do MODELO
 * (com o `.editorconfig` vencendo as settings, como a extensão EditorConfig do
 * VS Code); `applySaveTransforms` faz o trim/nova linha final do salvamento.
 *
 * Opções TRAVADAS em `components/editorOptions.ts` (hover acima, word-based
 * suggestions off, semantic highlighting nativo off, suggestLineHeight) NÃO
 * vêm de settings — são contratos do editor (ver docs/context/editor.md).
 */
import type { EditorConfigOverrides } from "./editorconfig.ts";

type Get = (key: string) => unknown;

const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

export interface EditorSettingsEnv {
  /** Pilha monoespaçada do SO (quando `editor.fontFamily` está vazio). */
  monoFont: string;
  reduceMotion: boolean;
}

/** Opções do editor (sem as travadas). Tipadas de forma solta para não puxar o Monaco nos testes. */
export function editorOptionsFromSettings(get: Get, env: EditorSettingsEnv, ec: EditorConfigOverrides = {}): Record<string, unknown> {
  const rulers = Array.isArray(get("editor.rulers")) ? (get("editor.rulers") as unknown[]).filter((r) => typeof r === "number") as number[] : [];
  if (ec.ruler && !rulers.includes(ec.ruler)) rulers.push(ec.ruler);
  const lineHeight = num(get("editor.lineHeight"), 0);
  const fontFamily = str(get("editor.fontFamily"), "").trim();
  const ligatures = get("editor.fontLigatures");
  const bracketGuides = get("editor.guides.bracketPairs");
  const opts: Record<string, unknown> = {
    fontFamily: fontFamily || env.monoFont,
    fontSize: num(get("editor.fontSize"), 14),
    fontLigatures: typeof ligatures === "string" ? ligatures : bool(ligatures, false),
    fontWeight: str(get("editor.fontWeight"), "normal"),
    wordWrap: str(get("editor.wordWrap"), "off"),
    wordWrapColumn: num(get("editor.wordWrapColumn"), 80),
    rulers,
    lineNumbers: str(get("editor.lineNumbers"), "on"),
    minimap: { enabled: bool(get("editor.minimap.enabled"), false) },
    stickyScroll: { enabled: bool(get("editor.stickyScroll.enabled"), false) },
    renderWhitespace: str(get("editor.renderWhitespace"), "selection"),
    renderLineHighlight: str(get("editor.renderLineHighlight"), "line"),
    cursorStyle: str(get("editor.cursorStyle"), "line"),
    cursorBlinking: str(get("editor.cursorBlinking"), "blink"),
    cursorSmoothCaretAnimation: env.reduceMotion ? "off" : str(get("editor.cursorSmoothCaretAnimation"), "off"),
    smoothScrolling: env.reduceMotion ? false : bool(get("editor.smoothScrolling"), false),
    mouseWheelZoom: bool(get("editor.mouseWheelZoom"), true),
    scrollBeyondLastLine: bool(get("editor.scrollBeyondLastLine"), false),
    formatOnPaste: bool(get("editor.formatOnPaste"), true),
    formatOnType: bool(get("editor.formatOnType"), true),
    autoClosingBrackets: str(get("editor.autoClosingBrackets"), "languageDefined"),
    "bracketPairColorization.enabled": bool(get("editor.bracketPairColorization.enabled"), true),
    guides: {
      bracketPairs: bracketGuides === "active" ? "active" : bool(bracketGuides, false),
      indentation: bool(get("editor.guides.indentation"), true),
    },
    folding: bool(get("editor.folding"), true),
    codeLens: bool(get("editor.codeLens"), true),
    inlayHints: { enabled: str(get("editor.inlayHints.enabled"), "on") },
    linkedEditing: bool(get("editor.linkedEditing"), false),
    acceptSuggestionOnEnter: str(get("editor.acceptSuggestionOnEnter"), "on"),
    largeFileOptimizations: bool(get("editor.largeFileOptimizations"), true),
    accessibilitySupport: str(get("editor.accessibilitySupport"), "auto"),
  };
  if (lineHeight > 0) opts.lineHeight = lineHeight;
  return opts;
}

export interface IndentationDecision {
  tabSize: number;
  indentSize: number;
  insertSpaces: boolean;
  /** Detectar a partir do conteúdo (só quando o .editorconfig não define). */
  detect: boolean;
  /** De onde veio (status bar / tooltip). */
  source: "editorconfig" | "settings";
}

export function indentationFor(get: Get, ec: EditorConfigOverrides = {}): IndentationDecision {
  const tabSize = Math.max(1, Math.min(32, Math.round(num(get("editor.tabSize"), 2))));
  const insertSpaces = bool(get("editor.insertSpaces"), true);
  const fromEc = ec.insertSpaces !== undefined || ec.tabSize !== undefined || ec.indentSize !== undefined;
  if (fromEc) {
    const t = ec.tabSize ?? tabSize;
    return {
      tabSize: t,
      indentSize: ec.indentSize ?? t,
      insertSpaces: ec.insertSpaces ?? insertSpaces,
      detect: false,
      source: "editorconfig",
    };
  }
  return { tabSize, indentSize: tabSize, insertSpaces, detect: bool(get("editor.detectIndentation"), true), source: "settings" };
}

export interface SaveTransforms {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
}

/** Transforms do salvamento: `.editorconfig` vence as settings. */
export function saveTransformsFor(get: Get, ec: EditorConfigOverrides = {}): SaveTransforms {
  return {
    trimTrailingWhitespace: ec.trimTrailingWhitespace ?? bool(get("files.trimTrailingWhitespace"), false),
    insertFinalNewline: ec.insertFinalNewline ?? bool(get("files.insertFinalNewline"), false),
    trimFinalNewlines: bool(get("files.trimFinalNewlines"), false),
  };
}

/** Aplica os transforms ao buffer (LF; o backend reaplica o EOL do arquivo). */
export function applySaveTransforms(text: string, t: SaveTransforms): string {
  let out = text;
  if (t.trimTrailingWhitespace) out = out.replace(/[ \t]+$/gm, "");
  if (t.trimFinalNewlines) {
    const body = out.replace(/\n+$/, "");
    out = out.length > body.length ? body + "\n" : body;
  }
  if (t.insertFinalNewline && out.length > 0 && !out.endsWith("\n")) out += "\n";
  return out;
}

/** EOL de arquivo NOVO (sem EOL detectado): `.editorconfig` > `files.eol` > SO. */
export function newFileEol(get: Get, ec: EditorConfigOverrides, isWindows: boolean): "Lf" | "Crlf" {
  if (ec.eol) return ec.eol === "\r\n" ? "Crlf" : "Lf";
  const v = get("files.eol");
  if (v === "\r\n") return "Crlf";
  if (v === "\n") return "Lf";
  return isWindows ? "Crlf" : "Lf";
}

const ENCODINGS: Record<string, { id: string; bom: boolean }> = {
  utf8: { id: "UTF-8", bom: false },
  utf8bom: { id: "UTF-8", bom: true },
  utf16le: { id: "UTF-16LE", bom: true },
  utf16be: { id: "UTF-16BE", bom: true },
  windows1252: { id: "windows-1252", bom: false },
  iso88591: { id: "windows-1252", bom: false },
};

/** Encoding de arquivo NOVO: `.editorconfig` > `files.encoding`. */
export function newFileEncoding(get: Get, ec: EditorConfigOverrides): { id: string; bom: boolean } {
  return ec.encoding ?? ENCODINGS[str(get("files.encoding"), "utf8")] ?? ENCODINGS.utf8;
}
