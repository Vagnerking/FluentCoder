import assert from "node:assert/strict";
import test from "node:test";
import { diffSideLabel, diffTabName, scmOpenTarget } from "./openRouting.ts";

const st = (code: string, extra: Partial<{ untracked: boolean; conflicted: boolean }> = {}) => ({
  code,
  untracked: false,
  conflicted: false,
  ...extra,
});

test("alteração só no working tree abre HEAD ↔ Working tree", () => {
  assert.deepEqual(scmOpenTarget(st(" M"), "changes"), {
    kind: "diff",
    view: "working",
    diff: { original: "HEAD", modified: "workingTree" },
  });
});

test("arquivo com stage + alteração não preparada: Changes compara Index ↔ Working tree", () => {
  assert.deepEqual(scmOpenTarget(st("MM"), "changes"), {
    kind: "diff",
    view: "working",
    diff: { original: "index", modified: "workingTree" },
  });
});

test("item preparado compara HEAD ↔ Index", () => {
  assert.deepEqual(scmOpenTarget(st("M "), "staged"), {
    kind: "diff",
    view: "staged",
    diff: { original: "HEAD", modified: "index" },
  });
});

test("adicionado no index: vazio ↔ Index; removido no index: HEAD ↔ vazio", () => {
  const added = scmOpenTarget(st("A "), "staged");
  assert.equal(added.kind, "diff");
  if (added.kind === "diff") assert.deepEqual(added.diff, { original: "empty", modified: "index" });
  const removed = scmOpenTarget(st("D "), "staged");
  if (removed.kind === "diff") assert.deepEqual(removed.diff, { original: "HEAD", modified: "empty" });
});

test("removido no working tree compara com vazio", () => {
  const t = scmOpenTarget(st(" D"), "changes");
  assert.equal(t.kind, "diff");
  if (t.kind === "diff") assert.deepEqual(t.diff, { original: "HEAD", modified: "empty" });
});

test("adicionado no index e editado depois: Changes compara Index ↔ Working tree", () => {
  const t = scmOpenTarget(st("AM"), "changes");
  if (t.kind === "diff") assert.deepEqual(t.diff, { original: "index", modified: "workingTree" });
});

test("conflitos e não rastreados abrem o arquivo (texto), não um diff", () => {
  assert.deepEqual(scmOpenTarget(st("UU", { conflicted: true }), "conflict"), { kind: "text" });
  assert.deepEqual(scmOpenTarget(st("UU", { conflicted: true }), "changes"), { kind: "text" });
  assert.deepEqual(scmOpenTarget(st("??", { untracked: true }), "changes"), { kind: "text" });
});

test("rótulos e nome da aba deixam os lados explícitos", () => {
  assert.equal(diffSideLabel("workingTree"), "Working tree");
  assert.equal(diffSideLabel("index"), "Index");
  assert.equal(
    diffTabName("App.tsx", { original: "index", modified: "workingTree" }),
    "App.tsx (Index ↔ Working tree)"
  );
});
