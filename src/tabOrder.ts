import type { OpenFile } from "./types";

/**
 * Reorders an open-files list by drag: moves the tab `fromPath` to sit just
 * before (`before=true`) or after (`before=false`) `toPath`. Returns the same
 * array reference when nothing changes (no-op move) so React can bail out.
 */
export function reorderFiles(
  list: OpenFile[],
  fromPath: string,
  toPath: string,
  before: boolean
): OpenFile[] {
  if (fromPath === toPath) return list;
  const next = [...list];
  const fromIdx = next.findIndex((f) => f.path === fromPath);
  if (fromIdx < 0) return list;
  const [moved] = next.splice(fromIdx, 1);
  // Find the target AFTER removing `moved`, so the insert index is correct.
  const toIdx = next.findIndex((f) => f.path === toPath);
  if (toIdx < 0) return list;
  const insertAt = before ? toIdx : toIdx + 1;
  // Same effective position → no change; keep the original reference.
  if (insertAt === fromIdx) return list;
  next.splice(insertAt, 0, moved);
  return next;
}
