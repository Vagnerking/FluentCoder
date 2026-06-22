import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLayout,
  createLayout,
  groupOrder,
  insertFileInGroup,
  isDropMeaningful,
  maxGroupSeq,
  openInGroup,
  closeFile,
  moveFileToGroup,
  patchFileEverywhere,
  removeGroup,
  serializeLayout,
  splitGroupWith,
  splitWithFile,
  type EditorGroup,
  type EditorLayout,
  type LayoutNode,
} from "./editorGroups.ts";
import type { OpenFile } from "./types.ts";

const file = (path: string): OpenFile => ({
  path,
  name: path,
  content: "",
  dirty: false,
  mode: "text",
});

const group = (id: string, paths: string[]): EditorGroup => ({
  id,
  files: paths.map(file),
  activePath: paths[paths.length - 1] ?? null,
});

const base = (): EditorLayout => createLayout(group("g1", ["a", "b", "c"]));

const paths = (layout: EditorLayout, id: string) =>
  (layout.groups[id]?.files ?? []).map((f) => f.path);

test("a fresh layout has one leaf group, active", () => {
  const l = base();
  assert.equal(l.root.type, "leaf");
  assert.equal(l.activeGroup, "g1");
  assert.deepEqual(groupOrder(l.root), ["g1"]);
});

test("splitting right wraps the source in a row branch and moves the tab", () => {
  const l = splitWithFile(base(), "g1", "g1", "c", "right", "g2");
  assert.equal(l.root.type, "branch");
  const root = l.root as Extract<LayoutNode, { type: "branch" }>;
  assert.equal(root.orientation, "row");
  assert.deepEqual(groupOrder(l.root), ["g1", "g2"]);
  assert.deepEqual(paths(l, "g1"), ["a", "b"]); // c moved out
  assert.deepEqual(paths(l, "g2"), ["c"]);
  assert.equal(l.activeGroup, "g2");
});

test("splitting left places the new group before the source", () => {
  const l = splitWithFile(base(), "g1", "g1", "a", "left", "g2");
  assert.deepEqual(groupOrder(l.root), ["g2", "g1"]);
});

test("splitting bottom uses a column branch", () => {
  const l = splitWithFile(base(), "g1", "g1", "c", "bottom", "g2");
  assert.equal((l.root as Extract<LayoutNode, { type: "branch" }>).orientation, "column");
});

test("a second same-axis split merges into the parent (no extra nesting)", () => {
  let l = splitWithFile(base(), "g1", "g1", "c", "right", "g2");
  l = splitWithFile(l, "g2", "g2", "c", "right", "g3"); // g2 only had 'c' though
  // g2 had a single tab → second split is a no-op (keeps things sane).
  assert.deepEqual(groupOrder(l.root), ["g1", "g2"]);
});

test("same-axis split with a multi-tab neighbour merges as a sibling", () => {
  // Start: [g1(a,b) | g2(c,d)] then split g1 to its right with 'b'.
  let l = createLayout(group("g1", ["a", "b", "c", "d"]));
  l = splitWithFile(l, "g1", "g1", "d", "right", "g2"); // g1(a,b,c) | g2(d)
  l = splitWithFile(l, "g1", "g1", "c", "right", "g3"); // g1(a,b) | g3(c) | g2(d)
  const root = l.root as Extract<LayoutNode, { type: "branch" }>;
  assert.equal(root.orientation, "row");
  assert.equal(root.children.length, 3); // merged, not nested
  assert.deepEqual(groupOrder(l.root), ["g1", "g3", "g2"]);
});

test("moving a tab to another group updates both and focuses the destination", () => {
  let l = splitWithFile(base(), "g1", "g1", "c", "right", "g2"); // g1(a,b) | g2(c)
  l = moveFileToGroup(l, "g1", "g2", "b"); // g1(a) | g2(c,b)
  assert.deepEqual(paths(l, "g1"), ["a"]);
  assert.deepEqual(paths(l, "g2"), ["c", "b"]);
  assert.equal(l.activeGroup, "g2");
  assert.equal(l.groups["g2"].activePath, "b");
});

test("emptying a group by moving its last tab removes and collapses it", () => {
  let l = splitWithFile(base(), "g1", "g1", "c", "right", "g2"); // g1(a,b) | g2(c)
  l = moveFileToGroup(l, "g2", "g1", "c"); // g2 emptied → removed
  assert.deepEqual(groupOrder(l.root), ["g1"]);
  assert.equal(l.root.type, "leaf"); // collapsed back to a single leaf
  assert.deepEqual(paths(l, "g1"), ["a", "b", "c"]);
});

test("closing the last tab of a non-final group removes the group", () => {
  let l = splitWithFile(base(), "g1", "g1", "c", "right", "g2"); // g1(a,b) | g2(c)
  l = closeFile(l, "g2", "c");
  assert.deepEqual(groupOrder(l.root), ["g1"]);
  assert.equal(l.activeGroup, "g1");
});

test("closing the last tab of the only group keeps the empty group", () => {
  let l = createLayout(group("g1", ["a"]));
  l = closeFile(l, "g1", "a");
  assert.deepEqual(groupOrder(l.root), ["g1"]);
  assert.equal(l.groups["g1"].files.length, 0);
});

test("dropping a tab on center moves it without splitting", () => {
  let l = splitWithFile(base(), "g1", "g1", "c", "right", "g2"); // g1(a,b) | g2(c)
  l = splitWithFile(l, "g1", "g2", "c", "center", "ignored"); // move c into g1
  assert.deepEqual(groupOrder(l.root), ["g1"]); // g2 emptied + collapsed
  assert.deepEqual(paths(l, "g1"), ["a", "b", "c"]);
});

test("serializeLayout captures the tree + per-group tabs without content", () => {
  const l = splitWithFile(base(), "g1", "g1", "c", "right", "g2"); // g1(a,b)|g2(c)
  const s = serializeLayout(l);
  assert.equal(s.activeGroup, "g2");
  assert.deepEqual(groupOrder(s.root), ["g1", "g2"]);
  const g1 = s.groups.find((g) => g.id === "g1")!;
  assert.deepEqual(g1.tabs.map((t) => t.path), ["a", "b"]);
  // No `content` field on serialized tabs.
  assert.equal("content" in g1.tabs[0], false);
});

test("buildLayout rebuilds the grid and prunes groups left empty", () => {
  const l = splitWithFile(base(), "g1", "g1", "c", "right", "g2"); // g1(a,b)|g2(c)
  const s = serializeLayout(l);
  // Rebuild but pretend g2's file is gone (empty group) → it collapses away.
  const rebuilt = buildLayout(s.root, s.activeGroup, {
    g1: group("g1", ["a", "b"]),
    g2: group("g2", []),
  });
  assert.ok(rebuilt);
  assert.deepEqual(groupOrder(rebuilt!.root), ["g1"]);
  assert.equal(rebuilt!.root.type, "leaf");
  // activeGroup was g2 (pruned) → repointed to a surviving group.
  assert.ok(rebuilt!.groups[rebuilt!.activeGroup]);
});

test("buildLayout returns null when every group is empty", () => {
  const l = splitWithFile(base(), "g1", "g1", "c", "right", "g2");
  const s = serializeLayout(l);
  const rebuilt = buildLayout(s.root, s.activeGroup, {
    g1: group("g1", []),
    g2: group("g2", []),
  });
  assert.equal(rebuilt, null);
});

test("maxGroupSeq finds the highest gN suffix", () => {
  assert.equal(maxGroupSeq(["g0", "g3", "g1"]), 3);
  assert.equal(maxGroupSeq(["g0"]), 0);
  assert.equal(maxGroupSeq([]), 0);
});

test("removeGroup never drops the final group", () => {
  const l = base();
  assert.equal(removeGroup(l, "g1"), l);
});

test("splitGroupWith copies the file into a new side group (origin keeps it)", () => {
  const l = splitGroupWith(base(), "g1", file("b"), "right", "g2");
  assert.deepEqual(groupOrder(l.root), ["g1", "g2"]);
  assert.deepEqual(paths(l, "g1"), ["a", "b", "c"]); // unchanged
  assert.deepEqual(paths(l, "g2"), ["b"]);
  assert.equal(l.activeGroup, "g2");
});

test("patchFileEverywhere clears dirty across every group holding the file", () => {
  let l = splitGroupWith(base(), "g1", file("b"), "right", "g2"); // b in g1 and g2
  l = patchFileEverywhere(l, "b", { dirty: false, content: "saved" });
  assert.equal(l.groups["g1"].files.find((f) => f.path === "b")?.content, "saved");
  assert.equal(l.groups["g2"].files.find((f) => f.path === "b")?.content, "saved");
});

test("patchFileEverywhere follows a rename and repoints activePath", () => {
  let l = createLayout(group("g1", ["a", "untitled-1"]));
  l = patchFileEverywhere(l, "untitled-1", { path: "/x/new.ts", name: "new.ts" });
  assert.deepEqual(paths(l, "g1"), ["a", "/x/new.ts"]);
  assert.equal(l.groups["g1"].activePath, "/x/new.ts");
});

test("insertFileInGroup places an adopted file before/after a tab", () => {
  let l = createLayout(group("g1", ["a", "b", "c"]));
  l = insertFileInGroup(l, "g1", file("x"), "b", true); // before b
  assert.deepEqual(paths(l, "g1"), ["a", "x", "b", "c"]);
  assert.equal(l.groups["g1"].activePath, "x");
  l = insertFileInGroup(l, "g1", file("y"), "c", false); // after c
  assert.deepEqual(paths(l, "g1"), ["a", "x", "b", "c", "y"]);
});

test("insertFileInGroup appends when no target, and dedupes by path", () => {
  let l = createLayout(group("g1", ["a", "b"]));
  l = insertFileInGroup(l, "g1", file("c")); // append
  assert.deepEqual(paths(l, "g1"), ["a", "b", "c"]);
  // Re-inserting an existing path repositions it (no duplicate).
  l = insertFileInGroup(l, "g1", file("c"), "a", true); // 'c' before 'a'
  assert.deepEqual(paths(l, "g1"), ["c", "a", "b"]);
});

test("openInGroup dedupes and focuses", () => {
  let l = base();
  l = openInGroup(l, "g1", file("a")); // already open
  assert.deepEqual(paths(l, "g1"), ["a", "b", "c"]);
  assert.equal(l.groups["g1"].activePath, "a");
  l = openInGroup(l, "g1", file("d"));
  assert.deepEqual(paths(l, "g1"), ["a", "b", "c", "d"]);
});

test("isDropMeaningful: splitting a group's sole tab onto itself is a no-op", () => {
  // The screenshot bug: a lone tab dragged over its own group must NOT light up.
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    assert.equal(isDropMeaningful(edge, "g1", 1, "g1"), false);
  }
  // center onto its own group is likewise a no-op (it's already there).
  assert.equal(isDropMeaningful("center", "g1", 1, "g1"), false);
});

test("isDropMeaningful: splitting a tab off a MULTI-tab group onto itself is valid", () => {
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    assert.equal(isDropMeaningful(edge, "g1", 3, "g1"), true);
  }
  // …but moving it into the same group it already lives in still does nothing.
  assert.equal(isDropMeaningful("center", "g1", 3, "g1"), false);
});

test("isDropMeaningful: any drop onto a DIFFERENT group is meaningful", () => {
  for (const edge of ["left", "right", "top", "bottom", "center"] as const) {
    assert.equal(isDropMeaningful(edge, "g1", 1, "g2"), true);
    assert.equal(isDropMeaningful(edge, "g1", 5, "g2"), true);
  }
});

test("isDropMeaningful matches splitWithFile's actual no-op behaviour", () => {
  // The predicate must agree with the reducer: a rejected drop leaves the layout
  // unchanged (reference-equal), an accepted one changes it.
  const lone = createLayout(group("g1", ["a"]));
  assert.equal(isDropMeaningful("right", "g1", 1, "g1"), false);
  assert.equal(splitWithFile(lone, "g1", "g1", "a", "right", "g2"), lone);

  const many = createLayout(group("g1", ["a", "b"]));
  assert.equal(isDropMeaningful("right", "g1", 2, "g1"), true);
  assert.notEqual(splitWithFile(many, "g1", "g1", "a", "right", "g2"), many);
});
