/**
 * Explorer `files.exclude` — which paths the file tree hides, mirroring VS Code's
 * setting of the same name (`{ glob: boolean }`, so a glob can be turned off
 * without deleting it).
 *
 * The default (declared in `coreSettings.ts`) mirrors VS Code's built-in
 * `files.exclude` EXACTLY (the VCS / OS-noise globs) plus the two the C# Dev
 * Kit contributes (bin, obj). Lido do sistema de settings (camadas user /
 * workspace / pasta, objetos mesclados sobre o default como no VS Code).
 */
import { settings } from "./instance.ts";

export const FILES_EXCLUDE_KEY = "files.exclude";

/** Default `files.exclude` (glob → enabled). */
export const DEFAULT_FILES_EXCLUDE: Record<string, boolean> = {
  "**/.git": true,
  "**/.svn": true,
  "**/.hg": true,
  "**/.DS_Store": true,
  "**/Thumbs.db": true,
  "**/bin": true,
  "**/obj": true,
};

/** Only real booleans count — `Boolean("false")` is `true`. */
export function booleanGlobMap(value: unknown, base: Record<string, boolean> = {}): Record<string, boolean> {
  const out: Record<string, boolean> = { ...base };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [glob, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on === "boolean") out[glob] = on;
  }
  return out;
}

/** The active `files.exclude` map (defaults merged with the user's choices). */
export function getFilesExcludeMap(resource?: string | null): Record<string, boolean> {
  return booleanGlobMap(settings.get(FILES_EXCLUDE_KEY, { resource }), DEFAULT_FILES_EXCLUDE);
}

/** The enabled glob patterns — the shape the backend `read_dir` expects. */
export function getFilesExcludeGlobs(resource?: string | null): string[] {
  return Object.entries(getFilesExcludeMap(resource))
    .filter(([, on]) => on)
    .map(([glob]) => glob);
}

/** Persists the full `files.exclude` map in the user settings. */
export function setFilesExcludeMap(map: Record<string, boolean>): void {
  void settings.update(FILES_EXCLUDE_KEY, map, "user").catch(() => {});
}
