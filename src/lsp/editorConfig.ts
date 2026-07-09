/**
 * `.editorconfig` awareness (milestone #5). Roslyn already READS `.editorconfig`
 * (formatting + analyzer rules honor it); this adds user-facing FEEDBACK — a
 * command to find and open the config that applies to the current file, so the
 * user can see and edit the rules governing their code (like the C# Dev Kit).
 *
 * Pure — no Monaco/LSP imports, so it unit-tests under `node --test`. The wiring
 * (a palette command) lives in `App.tsx`.
 */

/** Normalizes a path to forward slashes and trims a trailing slash. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The directory portion of a normalized file path. */
function dirOf(path: string): string {
  const n = normalize(path);
  const slash = n.lastIndexOf("/");
  return slash === -1 ? "" : n.slice(0, slash);
}

/** True when `dir` is an ancestor of (or equal to) `child`'s directory. */
function isAncestorDir(dir: string, child: string): boolean {
  const d = normalize(dir);
  const c = normalize(child);
  return c === d || c.startsWith(d + "/");
}

/** A minimal file entry — matches the `ProjectFile` fields we use. */
export interface FileEntry {
  name: string;
  path: string;
}

/**
 * Finds the `.editorconfig` that governs `activeFilePath` — the DEEPEST one whose
 * directory is an ancestor of the file (nearest wins, as EditorConfig resolves).
 * With no active file, returns the shallowest `.editorconfig` (the root one).
 * Returns null when the project has none.
 */
export function findNearestEditorConfig(
  files: readonly FileEntry[],
  activeFilePath: string | null
): string | null {
  const configs = files.filter((f) => f.name === ".editorconfig");
  if (configs.length === 0) return null;

  if (!activeFilePath) {
    // No context — pick the one with the shortest directory (closest to root).
    return configs
      .slice()
      .sort((a, b) => dirOf(a.path).length - dirOf(b.path).length)[0].path;
  }

  const fileDir = dirOf(activeFilePath);
  const applicable = configs
    .filter((c) => isAncestorDir(dirOf(c.path), fileDir))
    // Deepest ancestor first (nearest wins).
    .sort((a, b) => dirOf(b.path).length - dirOf(a.path).length);
  // If none is an ancestor (unusual layout), fall back to the root-most config.
  return applicable[0]?.path ?? findNearestEditorConfig(files, null);
}

/** True when the project contains at least one `.editorconfig`. */
export function hasEditorConfig(files: readonly FileEntry[]): boolean {
  return files.some((f) => f.name === ".editorconfig");
}
