import type { MatchSelection, OpenFile } from "../types.ts";
import { canonicalFileUriKey, toFileUri } from "../lsp/uri.ts";

export interface PendingEditorReveal {
  path: string;
  localIdentity?: string;
  observedPaths?: readonly string[];
  line: number;
  selection?: MatchSelection;
}

/** A queued jump belongs to both the selected file and its mounted model. */
export function consumePendingReveal(
  pending: { current: PendingEditorReveal | null },
  file: Pick<OpenFile, "path" | "localIdentity"> | null,
  modelUri: string | null,
  reveal: (line: number, selection?: MatchSelection) => void,
): boolean {
  const request = pending.current;
  if (!request || !file || !modelUri) return false;
  const concurrentAlias = !!request.localIdentity && request.localIdentity === file.localIdentity &&
    !!request.observedPaths && !request.observedPaths.includes(file.path);
  if (request.path !== file.path && !concurrentAlias) return false;
  const expected = file.path.startsWith("untitled:") || file.path.startsWith("fluentcoder://")
    ? file.path : toFileUri(file.path);
  if (canonicalFileUriKey(modelUri) !== canonicalFileUriKey(expected)) return false;
  pending.current = null;
  reveal(request.line, request.selection);
  return true;
}
