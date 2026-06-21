import assert from "node:assert/strict";
import test from "node:test";
import { shouldUsePullDiagnostics } from "./diagnosticMode.ts";

test("explicit pull works even when the server omits diagnosticProvider", () => {
  assert.equal(shouldUsePullDiagnostics("pull", false), true);
});

test("auto follows the static diagnosticProvider capability", () => {
  assert.equal(shouldUsePullDiagnostics("auto", true), true);
  assert.equal(shouldUsePullDiagnostics("auto", false), false);
});

test("push never installs the pull bridge", () => {
  assert.equal(shouldUsePullDiagnostics("push", true), false);
});
