/**
 * Explorer `files.exclude` — which paths the file tree hides, mirroring VS Code's
 * setting of the same name. Stored as a VS Code-style object (`{ glob: boolean }`)
 * in `localStorage`, so a glob can be turned off without deleting it.
 *
 * The default mirrors VS Code's built-in `files.exclude` EXACTLY (the six VCS /
 * OS-noise globs it ships with), plus the two the C# Dev Kit contributes for a
 * C# project (bin, obj) — since this editor is C#-centric. So a freshly opened
 * project is as clean as VS Code's out of the box. The user can edit the object
 * to add or disable patterns.
 *
 * Follows the codebase's `localStorage` settings idiom (see
 * `lsp/razorProjectionFlag.ts`). Read live so a change + reload takes effect.
 */
export const FILES_EXCLUDE_KEY = "files.exclude";

/**
 * Default `files.exclude` (glob → enabled). The first five are VS Code's current
 * verbatim core desktop defaults (from files.contribution.ts on `main`); the last
 * two (bin/obj) are the C# build outputs the C# Dev Kit hides. Note `node_modules`
 * is intentionally absent — VS Code does NOT exclude it via `files.exclude` (it's
 * handled through ignore files / search settings).
 */
export const DEFAULT_FILES_EXCLUDE: Record<string, boolean> = {
  // VS Code core desktop defaults (verbatim, current `main`):
  "**/.git": true,
  "**/.svn": true,
  "**/.hg": true,
  "**/.DS_Store": true,
  "**/Thumbs.db": true,
  // C# build-output defaults (this editor is C#-centric):
  "**/bin": true,
  "**/obj": true,
};

/**
 * The active `files.exclude` map: the stored object merged over the defaults so
 * new defaults appear for existing users, while their explicit on/off choices
 * (including disabling a default by setting it to `false`) win. Returns the
 * defaults if storage is unavailable or the stored value is malformed.
 */
export function getFilesExcludeMap(): Record<string, boolean> {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_FILES_EXCLUDE };
    const raw = localStorage.getItem(FILES_EXCLUDE_KEY);
    if (!raw) return { ...DEFAULT_FILES_EXCLUDE };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_FILES_EXCLUDE };
    }
    const merged: Record<string, boolean> = { ...DEFAULT_FILES_EXCLUDE };
    for (const [glob, on] of Object.entries(parsed as Record<string, unknown>)) {
      // Only honor real booleans — `Boolean("false")` is `true`, so a malformed
      // stored value mustn't accidentally enable/disable a pattern.
      if (typeof on === "boolean") merged[glob] = on;
    }
    return merged;
  } catch {
    return { ...DEFAULT_FILES_EXCLUDE };
  }
}

/**
 * The enabled glob patterns, as a flat array — the shape the backend `read_dir`
 * command expects. Empty array means "hide nothing".
 */
export function getFilesExcludeGlobs(): string[] {
  return Object.entries(getFilesExcludeMap())
    .filter(([, on]) => on)
    .map(([glob]) => glob);
}

/** Persists the full `files.exclude` map (used by future settings UI / commands). */
export function setFilesExcludeMap(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(FILES_EXCLUDE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — ignore */
  }
}
