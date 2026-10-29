import assert from "node:assert/strict";
import test from "node:test";
import { consumePendingReveal, type PendingEditorReveal } from "./pendingReveal.ts";

test("a racing alias jump selects the requested range once in the stored model", () => {
  const selection = { startColumn: 3, endColumn: 9 };
  const pending: { current: PendingEditorReveal | null } = { current: {
    path: "/work/main.cs", localIdentity: "unix:1:42", observedPaths: [], line: 17, selection,
  } };
  const file = { path: "/work/Main.cs", localIdentity: "unix:1:42" };
  const calls: unknown[] = [];
  const reveal = (line: number, selected: unknown) => { assert.equal(pending.current, null); calls.push([line, selected]); };
  assert.equal(consumePendingReveal(pending, file, "file:///work/Main.cs", reveal), true);
  assert.deepEqual(calls, [[17, selection]]);
  assert.equal(consumePendingReveal(pending, file, "file:///work/Main.cs", reveal), false);
});

test("a jump waits for its model instead of moving the previous file's cursor", () => {
  const pending: { current: PendingEditorReveal | null } = { current: { path: "/work/Main.cs", line: 23 } };
  const calls: number[] = [];
  assert.equal(consumePendingReveal(pending, { path: "/work/Main.cs" }, "file:///work/Other.cs", (line) => calls.push(line)), false);
  assert.equal(consumePendingReveal(pending, { path: "/work/Main.cs" }, null, (line) => calls.push(line)), false);
  assert.deepEqual(calls, []);
  assert.ok(pending.current);
  assert.equal(consumePendingReveal(pending, { path: "/work/Main.cs" }, "file:///work/Main.cs", (line) => calls.push(line)), true);
  assert.deepEqual(calls, [23]);
});

test("an old cached identity cannot redirect a jump after a fresh negative match", () => {
  const pending: { current: PendingEditorReveal | null } = { current: {
    path: "/work/new.cs", localIdentity: "unix:1:42", observedPaths: ["/work/deleted.cs"], line: 5,
  } };
  assert.equal(consumePendingReveal(pending, { path: "/work/deleted.cs", localIdentity: "unix:1:42" }, "file:///work/deleted.cs", () => assert.fail("wrong buffer")), false);
  assert.ok(pending.current);
});

test("Windows Monaco drive spelling still identifies the requested native model", () => {
  const pending: { current: PendingEditorReveal | null } = { current: { path: "C:\\work\\Main.cs", line: 5 } };
  assert.equal(consumePendingReveal(pending, { path: "C:\\work\\Main.cs" }, "file:///c%3A/work/Main.cs", () => {}), true);
});
