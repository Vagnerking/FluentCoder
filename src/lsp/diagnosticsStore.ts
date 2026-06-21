import type { Problem } from "../types";

/**
 * Workspace-wide diagnostics store (issue #6).
 *
 * The Problems panel was limited to `monaco.editor.getModelMarkers` — i.e. only
 * files with an OPEN Monaco model. This store collects the diagnostics the LSP
 * reports for the whole workspace (including files that are closed, e.g. the
 * `relatedDocuments` Roslyn volunteers on a pull), so the panel can aggregate
 * across the project, not just the active editor.
 *
 * Keyed by `serverId → (uri → Problem[])` so each server's diagnostics can be
 * replaced or cleared independently (restart via the Command Palette, workspace
 * switch, server stop). Framework-free; the diagnostics bridge feeds it and App
 * reads it via `useSyncExternalStore`.
 */

const byServer = new Map<string, Map<string, Problem[]>>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  listeners.forEach((l) => l());
}

/** Replaces the diagnostics for `uri` under `serverId` (empty list clears it). */
export function setDiagnostics(
  serverId: string,
  uri: string,
  problems: Problem[]
): void {
  let forServer = byServer.get(serverId);
  if (problems.length === 0) {
    if (forServer?.delete(uri)) notify();
    return;
  }
  if (!forServer) {
    forServer = new Map();
    byServer.set(serverId, forServer);
  }
  forServer.set(uri, problems);
  notify();
}

/** Drops every diagnostic owned by `serverId` (server stop/restart). */
export function clearServerDiagnostics(serverId: string): void {
  if (byServer.delete(serverId)) notify();
}

/** Drops everything (closing/switching the workspace — issue #17). */
export function clearAllDiagnostics(): void {
  if (byServer.size) {
    byServer.clear();
    notify();
  }
}

/** Monotonic version — the stable snapshot for `useSyncExternalStore`. */
export function diagnosticsVersion(): number {
  return version;
}

export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every stored problem, flattened across servers and files. */
export function allStoredProblems(): Problem[] {
  const out: Problem[] = [];
  for (const forServer of byServer.values()) {
    for (const list of forServer.values()) out.push(...list);
  }
  return out;
}
