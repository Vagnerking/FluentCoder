import { test } from "node:test";
import assert from "node:assert/strict";
import { repoSyncLabel, repoSyncPlan, runWithConcurrency } from "./repositoryOps.ts";

test("lote respeita o limite e um erro não aborta os outros", async () => {
  let running = 0;
  let peak = 0;
  const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (n === 4) throw new Error("falhou 4");
    return n * 10;
  });
  assert.equal(peak, 3);
  assert.equal(results.length, 7);
  assert.deepEqual(results[0], { ok: true, value: 10 });
  assert.equal(results[3].ok, false);
  assert.equal(results[6].value, 70);
  assert.deepEqual(await runWithConcurrency([], 4, async () => 1), []);
});

const st = (extra: Partial<Parameters<typeof repoSyncPlan>[0] & object> = {}) => ({
  isRepo: true,
  branch: "main",
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  conflicted: 0,
  files: [],
  ...extra,
});

test("plano de sincronização", () => {
  assert.deepEqual(repoSyncPlan(st({ ahead: 2, behind: 1 })), { pull: true, push: true });
  assert.deepEqual(repoSyncPlan(st({ behind: 3 })), { pull: true, push: false });
  assert.equal(repoSyncPlan(st()).skip, "em dia");
  assert.equal(repoSyncPlan(st({ hasUpstream: false, ahead: 1 })).skip, "branch sem upstream");
  assert.equal(repoSyncPlan(st({ ahead: 1, conflicted: 2 })).skip, "há conflitos");
  assert.equal(repoSyncPlan(st({ ahead: 1, branch: "(abc1234…)" })).skip, "HEAD destacado");
  assert.equal(repoSyncPlan(null).pull, false);
  assert.equal(repoSyncLabel(st({ ahead: 1, behind: 2 })), "↓2 ↑1");
  assert.equal(repoSyncLabel(st({ hasUpstream: false })), "");
});
