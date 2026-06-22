/** Maps a file extension to a Monaco language id for syntax highlighting. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  dart: "dart",
  cs: "csharp",
  cshtml: "cshtml",
  razor: "aspnetcorerazor",
  php: "php",
  rb: "ruby",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  sql: "sql",
  lua: "lua",
  swift: "swift",
  kt: "kotlin",
  dockerfile: "dockerfile",
};

/**
 * Per-file language overrides — VS Code's "Change Language Mode". Keyed by the
 * file's path. A module-level map (not React state) so EVERY `languageForFile`
 * consumer sees the override, including the `language` prop computed deep inside
 * `EditorPane`, without threading state through the editor-grid tree. The App
 * mirrors its own React state into here so the status bar + LSP stay reactive.
 */
const languageOverrides = new Map<string, string>();

function languageOverrideKey(path: string): string {
  const remote = getActiveRemote();
  if (!remote) return `local:${path}`;
  return `ssh:${remote.user}@${remote.host}:${remote.rootPath}:${path}`;
}

/** Sets (or, with `null`, clears → auto-detect) the language for a file path. */
export function setLanguageOverride(path: string, languageId: string | null): void {
  const key = languageOverrideKey(path);
  if (languageId) languageOverrides.set(key, languageId);
  else languageOverrides.delete(key);
}

/** The user-chosen language for a path, if any (else undefined → auto-detect). */
export function getLanguageOverride(path: string): string | undefined {
  return languageOverrides.get(languageOverrideKey(path));
}

/**
 * Best-effort Monaco language id for a filename. Falls back to plaintext.
 *
 * When `path` is given and the user picked a language mode for it (see
 * {@link setLanguageOverride}), that choice wins over extension detection.
 */
export function languageForFile(name: string, path?: string): string {
  if (path) {
    const override = getLanguageOverride(path);
    if (override) return override;
  }
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = lower.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? "plaintext";
}

/**
 * Friendly, VS Code-style display names for Monaco language ids — the single
 * source the status bar and the language-mode picker share. Ids without an entry
 * fall back to a registered alias (e.g. Monaco's "Python") or a capitalized id.
 */
export const LANGUAGE_LABELS: Record<string, string> = {
  aspnetcorerazor: "ASP.NET Razor",
  csharp: "C#",
  typescript: "TypeScript",
  typescriptreact: "TypeScript JSX",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  cpp: "C++",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  json: "JSON",
  yaml: "YAML",
  dockerfile: "Dockerfile",
  shell: "Shell Script",
  plaintext: "Texto sem formatação",
};

/** Human-readable name for a Monaco language id (optionally using its aliases). */
export function languageLabel(id: string, aliases?: readonly string[]): string {
  if (!id) return "";
  if (LANGUAGE_LABELS[id]) return LANGUAGE_LABELS[id];
  const alias = aliases?.find((a) => a && a !== id);
  if (alias) return alias;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
import { getActiveRemote } from "./remote/host.ts";
