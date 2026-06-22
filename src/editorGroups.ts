/**
 * Editor groups + split layout (VS Code-style editor grid).
 *
 * The editor area is a tree: every leaf is a GROUP (a tab strip + its open
 * files), and every branch is a split (a `row` = side-by-side, or a `column` =
 * stacked) holding child nodes with relative `sizes` (flex weights). All
 * operations here are PURE and immutable — they take a layout and return a new
 * one — so they're trivially testable and the React state update is a one-liner.
 *
 * New group ids are passed in by the caller (the App keeps a counter) to keep
 * these functions deterministic.
 */
import type { OpenFile } from "./types";
import { reorderFiles } from "./tabOrder.ts";

export type GroupId = string;
/** Where a dragged tab is dropped relative to a group. */
export type Edge = "left" | "right" | "top" | "bottom" | "center";
/** `row` = split side-by-side (H); `column` = split stacked (V). */
export type Orientation = "row" | "column";

export interface EditorGroup {
  id: GroupId;
  files: OpenFile[];
  activePath: string | null;
}

export type LayoutNode =
  | { type: "leaf"; group: GroupId }
  | {
      type: "branch";
      orientation: Orientation;
      children: LayoutNode[];
      /** Flex weights, one per child (used as `flex-grow`, basis 0). */
      sizes: number[];
    };

export interface EditorLayout {
  root: LayoutNode;
  groups: Record<GroupId, EditorGroup>;
  activeGroup: GroupId;
}

// ---- Construction & queries ----

export function createLayout(group: EditorGroup): EditorLayout {
  return {
    root: { type: "leaf", group: group.id },
    groups: { [group.id]: group },
    activeGroup: group.id,
  };
}

/** All group ids in left-to-right / top-to-bottom visual order. */
export function groupOrder(node: LayoutNode): GroupId[] {
  if (node.type === "leaf") return [node.group];
  return node.children.flatMap(groupOrder);
}

export function getActiveGroup(layout: EditorLayout): EditorGroup | undefined {
  return layout.groups[layout.activeGroup];
}

function edgeAxis(edge: Edge): { orientation: Orientation; before: boolean } {
  switch (edge) {
    case "left":
      return { orientation: "row", before: true };
    case "right":
      return { orientation: "row", before: false };
    case "top":
      return { orientation: "column", before: true };
    case "bottom":
    default:
      return { orientation: "column", before: false };
  }
}

// ---- Tree edits (pure) ----

/**
 * Inserts a fresh leaf for `newId` next to the leaf for `targetId`, on the given
 * axis. Merges into the parent branch when it already runs along that axis
 * (avoids needless nesting), otherwise wraps the target in a new branch.
 */
function insertBeside(
  node: LayoutNode,
  targetId: GroupId,
  newId: GroupId,
  orientation: Orientation,
  before: boolean
): LayoutNode {
  if (node.type === "leaf") {
    if (node.group !== targetId) return node;
    const fresh: LayoutNode = { type: "leaf", group: newId };
    const children = before
      ? [fresh, node]
      : [node, fresh];
    return { type: "branch", orientation, children, sizes: [1, 1] };
  }

  // Same-axis branch holding the target as a direct child → insert a sibling.
  if (node.orientation === orientation) {
    const idx = node.children.findIndex(
      (c) => c.type === "leaf" && c.group === targetId
    );
    if (idx >= 0) {
      const at = before ? idx : idx + 1;
      const children = [...node.children];
      children.splice(at, 0, { type: "leaf", group: newId });
      const sizes = [...node.sizes];
      sizes.splice(at, 0, 1);
      return { ...node, children, sizes };
    }
  }

  return {
    ...node,
    children: node.children.map((c) =>
      insertBeside(c, targetId, newId, orientation, before)
    ),
  };
}

/** Drops the leaf for `groupId`, collapsing single-child branches. Null if the
 *  whole tree empties (caller guarantees ≥1 group remains). */
function dropLeaf(node: LayoutNode, groupId: GroupId): LayoutNode | null {
  if (node.type === "leaf") return node.group === groupId ? null : node;
  const kept: { child: LayoutNode; size: number }[] = [];
  node.children.forEach((c, i) => {
    const r = dropLeaf(c, groupId);
    if (r) kept.push({ child: r, size: node.sizes[i] });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child; // collapse
  return {
    ...node,
    children: kept.map((k) => k.child),
    sizes: kept.map((k) => k.size),
  };
}

// ---- Group/file operations (pure, immutable) ----

function withGroup(
  layout: EditorLayout,
  id: GroupId,
  fn: (g: EditorGroup) => EditorGroup
): EditorLayout {
  const g = layout.groups[id];
  if (!g) return layout;
  return { ...layout, groups: { ...layout.groups, [id]: fn(g) } };
}

/** Adds `file` to a group (deduped) and focuses it + the group. */
export function openInGroup(
  layout: EditorLayout,
  groupId: GroupId,
  file: OpenFile
): EditorLayout {
  const next = withGroup(layout, groupId, (g) =>
    g.files.some((f) => f.path === file.path)
      ? { ...g, activePath: file.path }
      : { ...g, files: [...g.files, file], activePath: file.path }
  );
  return { ...next, activeGroup: groupId };
}

/** Focuses a file within a group (and makes that group active). */
export function activateFile(
  layout: EditorLayout,
  groupId: GroupId,
  path: string
): EditorLayout {
  const next = withGroup(layout, groupId, (g) => ({ ...g, activePath: path }));
  return { ...next, activeGroup: groupId };
}

/** Reorders a tab within its group (drag-to-reorder). */
export function reorderInGroup(
  layout: EditorLayout,
  groupId: GroupId,
  from: string,
  to: string,
  before: boolean
): EditorLayout {
  return withGroup(layout, groupId, (g) => ({
    ...g,
    files: reorderFiles(g.files, from, to, before),
  }));
}

/** The path to focus after `closing` leaves a group — its right neighbour, else
 *  left, else null. */
function neighbourPath(files: OpenFile[], closing: string): string | null {
  const i = files.findIndex((f) => f.path === closing);
  if (i < 0) return null;
  const rest = files.filter((f) => f.path !== closing);
  if (rest.length === 0) return null;
  return rest[Math.min(i, rest.length - 1)].path;
}

/** Removes a group and collapses the tree; re-points `activeGroup` if needed. */
export function removeGroup(
  layout: EditorLayout,
  groupId: GroupId
): EditorLayout {
  const order = groupOrder(layout.root);
  if (order.length <= 1) return layout; // never drop the last group
  const root = dropLeaf(layout.root, groupId);
  if (!root) return layout;
  const groups = { ...layout.groups };
  delete groups[groupId];
  let activeGroup = layout.activeGroup;
  if (activeGroup === groupId) {
    // Focus the previous group in visual order (or the first that remains).
    const idx = order.indexOf(groupId);
    const remaining = order.filter((id) => id !== groupId);
    activeGroup =
      remaining[Math.max(0, Math.min(idx - 1, remaining.length - 1))] ??
      remaining[0];
  }
  return { root, groups, activeGroup };
}

/** Closes a tab; an emptied group is removed (unless it's the last one). */
export function closeFile(
  layout: EditorLayout,
  groupId: GroupId,
  path: string
): EditorLayout {
  const g = layout.groups[groupId];
  if (!g) return layout;
  const files = g.files.filter((f) => f.path !== path);
  const nextActive =
    g.activePath === path ? neighbourPath(g.files, path) : g.activePath;
  const withClosed = withGroup(layout, groupId, () => ({
    ...g,
    files,
    activePath: nextActive,
  }));
  if (files.length === 0) return removeGroup(withClosed, groupId);
  return withClosed;
}

/**
 * Moves `path` from one group to another. `targetPath`/`before` place it
 * relative to a tab in the destination (else it's appended). An emptied source
 * group is removed.
 */
export function moveFileToGroup(
  layout: EditorLayout,
  fromGroup: GroupId,
  toGroup: GroupId,
  path: string,
  targetPath?: string,
  before = false
): EditorLayout {
  if (fromGroup === toGroup) {
    // Same group → it's just a reorder against the target.
    if (targetPath) return reorderInGroup(layout, groupId(layout, fromGroup), path, targetPath, before);
    return layout;
  }
  const src = layout.groups[fromGroup];
  const dst = layout.groups[toGroup];
  if (!src || !dst) return layout;
  const file = src.files.find((f) => f.path === path);
  if (!file) return layout;

  // Remove from source.
  const srcFiles = src.files.filter((f) => f.path !== path);
  const srcActive =
    src.activePath === path ? neighbourPath(src.files, path) : src.activePath;

  // Insert into destination (deduped), at the target position if given.
  let dstFiles = dst.files.filter((f) => f.path !== path);
  if (targetPath) {
    const ti = dstFiles.findIndex((f) => f.path === targetPath);
    const at = ti < 0 ? dstFiles.length : before ? ti : ti + 1;
    dstFiles = [...dstFiles.slice(0, at), file, ...dstFiles.slice(at)];
  } else {
    dstFiles = [...dstFiles, file];
  }

  let next: EditorLayout = {
    ...layout,
    groups: {
      ...layout.groups,
      [fromGroup]: { ...src, files: srcFiles, activePath: srcActive },
      [toGroup]: { ...dst, files: dstFiles, activePath: path },
    },
    activeGroup: toGroup,
  };
  if (srcFiles.length === 0) next = removeGroup(next, fromGroup);
  return next;
}

/** Helper: a group id that exists, for the same-group reorder shortcut above. */
function groupId(layout: EditorLayout, id: GroupId): GroupId {
  return layout.groups[id] ? id : layout.activeGroup;
}

/**
 * Splits `sourceGroup` along `edge`, moving `path` into a brand-new group
 * (`newId`) placed on that side. Dropping on `center` just moves the tab into
 * the source group (no split). An emptied source is removed.
 */
export function splitWithFile(
  layout: EditorLayout,
  sourceGroup: GroupId,
  fromGroup: GroupId,
  path: string,
  edge: Edge,
  newId: GroupId
): EditorLayout {
  if (edge === "center") {
    return moveFileToGroup(layout, fromGroup, sourceGroup, path);
  }
  const src = layout.groups[fromGroup];
  if (!src) return layout;
  const file = src.files.find((f) => f.path === path);
  if (!file) return layout;

  // A split that empties the source AND targets that same source is a no-op
  // reposition — keep it simple and bail (nothing meaningful changes).
  if (fromGroup === sourceGroup && src.files.length <= 1) return layout;

  const { orientation, before } = edgeAxis(edge);
  const newGroup: EditorGroup = {
    id: newId,
    files: [file],
    activePath: path,
  };

  // Remove the file from its origin group.
  const srcFiles = src.files.filter((f) => f.path !== path);
  const srcActive =
    src.activePath === path ? neighbourPath(src.files, path) : src.activePath;

  let next: EditorLayout = {
    root: insertBeside(layout.root, sourceGroup, newId, orientation, before),
    groups: {
      ...layout.groups,
      [fromGroup]: { ...src, files: srcFiles, activePath: srcActive },
      [newId]: newGroup,
    },
    activeGroup: newId,
  };
  if (srcFiles.length === 0) next = removeGroup(next, fromGroup);
  return next;
}

/**
 * Whether dropping the dragged tab here would actually CHANGE the layout — the
 * single source of truth shared by every drop surface (the editor grid and the
 * detached windows) so they all show the same honest indicator. Mirrors the
 * no-op guards in `splitWithFile`/`moveFileToGroup`:
 *
 * - `center` (move into this group) is a no-op when the tab is already in this
 *   group (drop target === its origin).
 * - a split off an edge is a no-op only when the tab is its origin group's SOLE
 *   tab AND that origin is the split target (the emptied source would collapse
 *   straight back into the new split — nothing changes).
 *
 * Cross-group drops are always meaningful. A drop the rule rejects should show
 * NO highlight and refuse the drop (VS Code-style), rather than promising a
 * split that won't happen.
 */
export function isDropMeaningful(
  edge: Edge,
  fromGroup: GroupId,
  fromGroupFileCount: number,
  targetGroup: GroupId
): boolean {
  if (edge === "center") return fromGroup !== targetGroup;
  if (fromGroup === targetGroup && fromGroupFileCount <= 1) return false;
  return true;
}

/**
 * Splits `sourceGroup` along `edge`, placing a COPY of `file` in a new group on
 * that side (the file stays put in its origin too). This is the "Split Editor"
 * button's behaviour (vs `splitWithFile`, which MOVES a dragged tab).
 */
export function splitGroupWith(
  layout: EditorLayout,
  sourceGroup: GroupId,
  file: OpenFile,
  edge: Edge,
  newId: GroupId
): EditorLayout {
  if (edge === "center") return layout;
  const { orientation, before } = edgeAxis(edge);
  return {
    root: insertBeside(layout.root, sourceGroup, newId, orientation, before),
    groups: {
      ...layout.groups,
      [newId]: { id: newId, files: [file], activePath: file.path },
    },
    activeGroup: newId,
  };
}

/**
 * Applies `patch` to every open copy of `path` across all groups (e.g. clearing
 * the dirty flag on save, or following a rename via `patch.path`). Keeps each
 * group's `activePath` pointing at the (possibly renamed) file.
 */
export function patchFileEverywhere(
  layout: EditorLayout,
  path: string,
  patch: Partial<OpenFile>
): EditorLayout {
  const newPath = patch.path ?? path;
  let changed = false;
  const groups: Record<GroupId, EditorGroup> = {};
  for (const [id, g] of Object.entries(layout.groups)) {
    if (!g.files.some((f) => f.path === path)) {
      groups[id] = g;
      continue;
    }
    changed = true;
    groups[id] = {
      ...g,
      files: g.files.map((f) => (f.path === path ? { ...f, ...patch } : f)),
      activePath: g.activePath === path ? newPath : g.activePath,
    };
  }
  return changed ? { ...layout, groups } : layout;
}

/**
 * Inserts a file (adopted from ANOTHER window) into a group at a position:
 * before/after `targetPath`, or appended when it's null. Dedupes by path and
 * focuses the file + group.
 */
export function insertFileInGroup(
  layout: EditorLayout,
  groupId: GroupId,
  file: OpenFile,
  targetPath?: string,
  before = false
): EditorLayout {
  const g = layout.groups[groupId];
  if (!g) return layout;
  let files = g.files.filter((f) => f.path !== file.path);
  if (targetPath) {
    const ti = files.findIndex((f) => f.path === targetPath);
    const at = ti < 0 ? files.length : before ? ti : ti + 1;
    files = [...files.slice(0, at), file, ...files.slice(at)];
  } else {
    files = [...files, file];
  }
  return {
    ...layout,
    groups: { ...layout.groups, [groupId]: { ...g, files, activePath: file.path } },
    activeGroup: groupId,
  };
}

// ---- Session persistence (the split layout, content-free) ----

export interface SerializedGroup {
  id: GroupId;
  tabs: { path: string; mode?: OpenFile["mode"] }[];
  activePath: string | null;
}
export interface SerializedLayout {
  root: LayoutNode;
  groups: SerializedGroup[];
  activeGroup: GroupId;
}

/** Captures the split layout WITHOUT buffer content (paths + view mode only),
 *  so the session can restore the whole grid; content is re-read on launch. */
export function serializeLayout(layout: EditorLayout): SerializedLayout {
  return {
    root: layout.root,
    activeGroup: layout.activeGroup,
    groups: Object.values(layout.groups).map((g) => ({
      id: g.id,
      activePath: g.activePath,
      tabs: g.files.map((f) => ({ path: f.path, mode: f.mode })),
    })),
  };
}

/**
 * Rebuilds a layout from a serialized tree + groups whose files the caller has
 * already loaded from disk. Drops groups left empty (file missing) and collapses
 * the tree; returns null when nothing restorable remains (caller falls back to a
 * single empty group).
 */
export function buildLayout(
  root: LayoutNode,
  activeGroup: GroupId,
  groups: Record<GroupId, EditorGroup>
): EditorLayout | null {
  let layout: EditorLayout = { root, groups, activeGroup };
  for (const id of Object.keys(groups)) {
    if (groups[id].files.length === 0) layout = removeGroup(layout, id);
  }
  const order = groupOrder(layout.root);
  const anyFiles = order.some((id) => (layout.groups[id]?.files.length ?? 0) > 0);
  if (!anyFiles) return null;
  if (!layout.groups[layout.activeGroup]) {
    layout = { ...layout, activeGroup: order[0] };
  }
  return layout;
}

/** Highest numeric suffix among "gN" group ids (to seed the new-id counter). */
export function maxGroupSeq(ids: GroupId[]): number {
  return ids.reduce((max, id) => {
    const n = /^g(\d+)$/.exec(id);
    return n ? Math.max(max, Number(n[1])) : max;
  }, 0);
}

/** Adjusts the two adjacent flex weights at a resize handle inside a branch. */
export function resizeBranch(
  node: LayoutNode,
  branchPath: number[],
  index: number,
  leftSize: number,
  rightSize: number
): LayoutNode {
  if (branchPath.length === 0) {
    if (node.type !== "branch") return node;
    const sizes = [...node.sizes];
    sizes[index] = leftSize;
    sizes[index + 1] = rightSize;
    return { ...node, sizes };
  }
  if (node.type !== "branch") return node;
  const [head, ...rest] = branchPath;
  return {
    ...node,
    children: node.children.map((c, i) =>
      i === head ? resizeBranch(c, rest, index, leftSize, rightSize) : c
    ),
  };
}
