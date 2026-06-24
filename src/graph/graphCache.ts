/**
 * Shared, in-memory cache of the workspace context graph, so every consumer (the
 * graph view AND the backlinks panel) reuses ONE backend scan per workspace
 * instead of each re-walking the disk. Keyed by root; `invalidateGraph()` (the
 * "Atualizar" button / a future file-watch) forces a fresh scan.
 */
import { buildContextGraph } from "../api";
import type { GraphData } from "../types";

let cache: { root: string; data: GraphData } | null = null;
let inflight: { root: string; promise: Promise<GraphData> } | null = null;

/** The cached graph for `root`, or null if not yet loaded. */
export function getCachedGraph(root: string): GraphData | null {
  return cache && cache.root === root ? cache.data : null;
}

/** Loads (and caches) the graph for `root`, deduping concurrent calls. */
export function loadGraph(root: string, force = false): Promise<GraphData> {
  if (!force && cache && cache.root === root) return Promise.resolve(cache.data);
  if (!force && inflight && inflight.root === root) return inflight.promise;
  const promise = buildContextGraph(root)
    .then((data) => {
      cache = { root, data };
      return data;
    })
    .finally(() => {
      if (inflight?.root === root) inflight = null;
    });
  inflight = { root, promise };
  return promise;
}

/** Drops the cached graph (e.g. on a manual refresh) so the next load re-scans. */
export function invalidateGraph(): void {
  cache = null;
  inflight = null;
}
