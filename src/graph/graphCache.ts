/**
 * Shared, in-memory cache of the workspace context graph, so every consumer (the
 * graph view AND the backlinks panel) reuses ONE backend scan per workspace
 * instead of each re-walking the disk. Keyed by root; `invalidateGraph()` (the
 * "Atualizar" button / a future file-watch) forces a fresh scan.
 */
import { buildContextGraph } from "../api";
import type { GraphData } from "../types";

let cache: { key: string; data: GraphData } | null = null;
let inflight: { key: string; promise: Promise<GraphData> } | null = null;

function cacheKey(root: string, connId?: string | null): string {
  return `${connId ?? "local"}:${root}`;
}

/** The cached graph for `root`, or null if not yet loaded. */
export function getCachedGraph(root: string, connId?: string | null): GraphData | null {
  const key = cacheKey(root, connId);
  return cache && cache.key === key ? cache.data : null;
}

/** Loads (and caches) the graph for `root`, deduping concurrent calls. */
export function loadGraph(
  root: string,
  connId?: string | null,
  force = false
): Promise<GraphData> {
  const key = cacheKey(root, connId);
  if (!force && cache && cache.key === key) return Promise.resolve(cache.data);
  if (!force && inflight && inflight.key === key) return inflight.promise;
  const promise = buildContextGraph(root, connId ?? undefined)
    .then((data) => {
      cache = { key, data };
      return data;
    })
    .finally(() => {
      if (inflight?.key === key) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

/** Drops the cached graph (e.g. on a manual refresh) so the next load re-scans. */
export function invalidateGraph(): void {
  cache = null;
  inflight = null;
}
