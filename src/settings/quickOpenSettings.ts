/**
 * Regras do índice do Quick Open (Ctrl+P), lidas do sistema de settings:
 *
 * - `search.exclude` (objeto `{ glob: boolean }`, como no VS Code), mesclado
 *   sobre os defaults do VS Code;
 * - `files.exclude` (o mesmo do Explorer) também vale para o Quick Open;
 * - `fluent.quickOpen.maxFiles`: teto do índice (o Rust limita a 1k–1M). Ao
 *   bater no teto o Quick Open AVISA — nunca corta em silêncio.
 */

import { booleanGlobMap, getFilesExcludeGlobs } from "./filesExclude.ts";
import { settings } from "./instance.ts";

export const SEARCH_EXCLUDE_KEY = "search.exclude";
export const QUICK_OPEN_MAX_FILES_KEY = "fluent.quickOpen.maxFiles";

/** Defaults do VS Code para `search.exclude`. */
export const DEFAULT_SEARCH_EXCLUDE: Record<string, boolean> = {
  "**/node_modules": true,
  "**/bower_components": true,
  "**/*.code-search": true,
};

export const DEFAULT_QUICK_OPEN_MAX_FILES = 50_000;

export function getSearchExcludeMap(resource?: string | null): Record<string, boolean> {
  return booleanGlobMap(settings.get(SEARCH_EXCLUDE_KEY, { resource }), DEFAULT_SEARCH_EXCLUDE);
}

/** `files.exclude` + `search.exclude` ativos, sem duplicatas. */
export function getQuickOpenExcludeGlobs(resource?: string | null): string[] {
  const search = Object.entries(getSearchExcludeMap(resource))
    .filter(([, on]) => on)
    .map(([g]) => g);
  return [...new Set([...getFilesExcludeGlobs(resource), ...search])];
}

export function getQuickOpenMaxFiles(): number {
  const n = Number(settings.get(QUICK_OPEN_MAX_FILES_KEY));
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_QUICK_OPEN_MAX_FILES;
}
