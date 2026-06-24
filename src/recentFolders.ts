/**
 * Recently-opened folders, kept in localStorage (shared across the app's windows
 * on the same origin). Powers the welcome screen's "Recentes" list.
 */
const KEY = "recentFolders";
const MAX = 8;

export function getRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Adds `folder` to the front (deduped), capping the list. */
export function addRecentFolder(folder: string): void {
  if (!folder) return;
  const next = [folder, ...getRecentFolders().filter((p) => p !== folder)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
