import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTests } from "./testTree.ts";

test("groups flat FQNs by class, splitting namespace and method", () => {
  const groups = groupTests([
    "App.Tests.CalcTests.Soma",
    "App.Tests.CalcTests.Subtrai",
    "App.Tests.StringTests.Concat",
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].container, "App.Tests.CalcTests");
  assert.equal(groups[0].className, "CalcTests");
  assert.equal(groups[0].namespace, "App.Tests");
  assert.deepEqual(groups[0].leaves.map((l) => l.method), ["Soma", "Subtrai"]);
  assert.equal(groups[1].className, "StringTests");
});

test("sorts groups by container and leaves by method, stable", () => {
  const groups = groupTests([
    "Z.ZTests.B",
    "A.ATests.Z",
    "A.ATests.A",
  ]);
  assert.deepEqual(groups.map((g) => g.container), ["A.ATests", "Z.ZTests"]);
  assert.deepEqual(groups[0].leaves.map((l) => l.method), ["A", "Z"]);
});

test("strips Theory args so cases fold under one method", () => {
  const groups = groupTests([
    "App.T.C.Theory(x: 1)",
    "App.T.C.Theory(x: 2)",
  ]);
  assert.equal(groups.length, 1);
  // Both cases keep their distinct fqn but share the method grouping.
  assert.equal(groups[0].leaves.length, 2);
  assert.equal(groups[0].leaves[0].method, "Theory");
});

test("dotless name becomes its own container", () => {
  const groups = groupTests(["LoneName"]);
  assert.equal(groups[0].container, "");
  assert.equal(groups[0].className, "");
  assert.equal(groups[0].leaves[0].method, "LoneName");
});

test("dedups identical FQNs", () => {
  const groups = groupTests(["A.B.C", "A.B.C"]);
  assert.equal(groups[0].leaves.length, 1);
});
