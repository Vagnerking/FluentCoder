import assert from "node:assert/strict";
import test from "node:test";
import { reorderFiles } from "./tabOrder.ts";
import type { OpenFile } from "./types.ts";

const file = (path: string): OpenFile => ({
  path,
  name: path,
  content: "",
  dirty: false,
  mode: "text",
});

const paths = (list: OpenFile[]) => list.map((f) => f.path);

test("drops a tab before the target", () => {
  const list = [file("a"), file("b"), file("c")];
  assert.deepEqual(paths(reorderFiles(list, "c", "a", true)), ["c", "a", "b"]);
});

test("drops a tab after the target", () => {
  const list = [file("a"), file("b"), file("c")];
  assert.deepEqual(paths(reorderFiles(list, "a", "c", false)), ["b", "c", "a"]);
});

test("moving left-to-right before the target lands just ahead of it", () => {
  const list = [file("a"), file("b"), file("c")];
  assert.deepEqual(paths(reorderFiles(list, "a", "c", true)), ["b", "a", "c"]);
});

test("a no-op move keeps the same array reference", () => {
  const list = [file("a"), file("b"), file("c")];
  // Dropping 'b' before 'c' leaves it exactly where it already sits.
  assert.equal(reorderFiles(list, "b", "c", true), list);
  // Dropping a tab onto itself is a no-op too.
  assert.equal(reorderFiles(list, "b", "b", true), list);
});

test("unknown paths are ignored", () => {
  const list = [file("a"), file("b")];
  assert.equal(reorderFiles(list, "x", "a", true), list);
  assert.equal(reorderFiles(list, "a", "x", true), list);
});
