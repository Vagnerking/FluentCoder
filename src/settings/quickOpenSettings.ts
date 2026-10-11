/**
 * Regras do índice do Quick Open (Ctrl+P), no mesmo idioma `localStorage` de
 * `filesExclude.ts` até existir o sistema de settings:
 *
 * - `search.exclude` (objeto `{ glob: boolean }`, como no VS Code), mesclado
 *   sobre os defaults do VS Code;
 * - `files.exclude` (o mesmo do Explorer) também vale para o Quick Open;
 * - `fluent.quickOpen.maxFiles`: teto do índice (o Rust limita a 1k–1M). Ao
 *   bater no teto o Quick Open AVISA — nunca corta em silêncio.
 */

import { getFilesExcludeGlobs } from "./filesExclude.ts";

export const SEARCH_EXCLUDE_KEY = "search.exclude";
export const QUICK_OPEN_MAX_FILES_KEY = "fluent.quickOpen.maxFiles";

/** Defaults do VS Code para `search.exclude`. */
export const DEFAULT_SEARCH_EXCLUDE: Record<string, boolean> = {
  "**/node_modules": true,
  "**/bower_components": true,
  "**/*.code-search": true,
};

export const DEFAULT_QUICK_OPEN_MAX_FILES = 50_000;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getSearchExcludeMap(): Record<string, boolean> {
  const merged = { ...DEFAULT_SEARCH_EXCLUDE };
  try {
    const raw = storage()?.getItem(SEARCH_EXCLUDE_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return merged;
    for (const [glob, on] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof on === "boolean") merged[glob] = on;
    }
  } catch {
    /* valor malformado: defaults */
  }
  return merged;
}

/** `files.exclude` + `search.exclude` ativos, sem duplicatas. */
export function getQuickOpenExcludeGlobs(): string[] {
  const search = Object.entries(getSearchExcludeMap())
    .filter(([, on]) => on)
    .map(([g]) => g);
  return [...new Set([...getFilesExcludeGlobs(), ...search])];
}

export function getQuickOpenMaxFiles(): number {
  try {
    const n = Number(storage()?.getItem(QUICK_OPEN_MAX_FILES_KEY));
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* ignora */
  }
  return DEFAULT_QUICK_OPEN_MAX_FILES;
}
