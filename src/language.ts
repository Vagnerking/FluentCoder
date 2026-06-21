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
  cshtml: "aspnetcorerazor",
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

/** Best-effort Monaco language id for a filename. Falls back to plaintext. */
export function languageForFile(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = lower.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? "plaintext";
}
