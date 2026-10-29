import { samePath } from "../paths.ts";
import type { OpenFile, OpenMode } from "../types.ts";
import type { EditorLayout } from "../editorGroups.ts";
import { openTabInList } from "../components/editor/tabLogic.ts";

export interface FileIdentityMatch {
  identity: string | null;
  index: number | null;
}

export async function resolveFileOpen<T extends { path: string; localIdentity?: string }>(
  files: readonly T[], path: string,
  resolve?: (path: string, candidates: string[]) => Promise<FileIdentityMatch>,
): Promise<{ file?: T; identity?: string; observedPaths: string[] }> {
  const observedPaths = files.map((file) => file.path);
  const direct = files.find((file) => file.path === path);
  if (direct) return { file: direct, identity: direct.localIdentity, observedPaths };
  if (!resolve) return { file: files.find((file) => samePath(file.path, path)), observedPaths };
  try {
    const match = await resolve(path, files.map((file) => file.path));
    const file = match.index !== null && Number.isInteger(match.index) && match.index >= 0 ? files[match.index] : undefined;
    return { file, identity: match.identity ?? undefined, observedPaths };
  } catch {
    return { observedPaths }; // The normal read path reports missing/unreadable files.
  }
}

/** Atomically deduplicate the current group and focus the stored spelling. */
export function commitFileOpen(
  layout: EditorLayout, incoming: OpenFile,
  options: { mode?: OpenMode; permanent?: boolean; observedPaths?: readonly string[] } = {},
): EditorLayout {
  const group = layout.groups[layout.activeGroup];
  if (!group) return layout;
  // A cached ID may reconcile a tab added during this read. It must never
  // override a fresh negative match for a tab present in the lookup snapshot.
  const existing = group.files.find((file) =>
    file.workspaceRemote?.connId === incoming.workspaceRemote?.connId && (
      file.path === incoming.path ||
      (!incoming.workspaceRemote && !file.workspaceRemote && !!incoming.localIdentity && file.localIdentity === incoming.localIdentity &&
        !!options.observedPaths && !options.observedPaths.includes(file.path)) ||
      (!incoming.localIdentity && !file.localIdentity && samePath(file.path, incoming.path))
    ));
  const files = existing
    ? group.files.map((file) => file === existing ? {
      ...file,
      localIdentity: incoming.localIdentity ?? file.localIdentity,
      mode: options.mode ?? file.mode,
      preview: options.permanent ? undefined : file.preview,
    } : file)
    : openTabInList(group.files, incoming);
  return {
    ...layout,
    groups: { ...layout.groups, [group.id]: { ...group, files, activePath: existing?.path ?? incoming.path } },
  };
}

export type ResolveSameFile = (path: string, candidates: string[]) => Promise<number | null>;

/** Keep the stored spelling and buffer when another path identifies an open file. */
export async function findExistingFile<T extends { path: string }>(
  files: readonly T[],
  path: string,
  resolve?: ResolveSameFile,
): Promise<T | undefined> {
  const direct = files.find((file) => file.path === path);
  if (direct || !files.length) return direct;
  if (!resolve) return files.find((file) => samePath(file.path, path));
  try {
    const index = await resolve(path, files.map((file) => file.path));
    return index !== null && Number.isInteger(index) && index >= 0 ? files[index] : undefined;
  } catch {
    // Missing/unreadable paths follow the normal open error path. Never guess
    // identity by folding every POSIX path or by consulting the host for SSH.
    return undefined;
  }
}
