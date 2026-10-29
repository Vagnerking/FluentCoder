import assert from "node:assert/strict";
import test from "node:test";
import { mergeActivityOrder } from "./activityOrder.ts";

const defaults = ["explorer", "search", "git", "debug", "extensions", "packages", "graph"];

test("ordem da activity bar: view nova entra no lugar padrão sem zerar a personalizada", () => {
  const saved = ["git", "explorer", "search", "debug", "packages", "graph"];
  assert.deepEqual(mergeActivityOrder(saved, defaults), ["git", "explorer", "search", "debug", "extensions", "packages", "graph"]);
  assert.deepEqual(mergeActivityOrder(["graph", "bogus", "graph"], defaults), ["explorer", "search", "git", "debug", "extensions", "packages", "graph"]);
  assert.deepEqual(mergeActivityOrder(null, defaults), defaults);
  assert.deepEqual(mergeActivityOrder([], defaults), defaults);
});
