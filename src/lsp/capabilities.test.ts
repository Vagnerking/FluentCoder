import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeCapabilities, TRACKED_CAPABILITIES } from "./capabilities.ts";

test("summarizeCapabilities: boolean and options-object both count as present", () => {
  const { present, absent } = summarizeCapabilities({
    // boolean form
    hoverProvider: true,
    definitionProvider: true,
    // options-object form (what Roslyn actually sends for these)
    inlayHintProvider: { resolveProvider: true },
    documentOnTypeFormattingProvider: { firstTriggerCharacter: "}" },
    semanticTokensProvider: { legend: { tokenTypes: [], tokenModifiers: [] } },
  });
  assert.ok(present.includes("hover"));
  assert.ok(present.includes("definition"));
  assert.ok(present.includes("inlayHint"));
  assert.ok(present.includes("onTypeFormat"));
  assert.ok(present.includes("semanticTokens"));
  // Everything not supplied is absent.
  assert.ok(absent.includes("callHierarchy"));
  assert.ok(absent.includes("typeHierarchy"));
});

test("summarizeCapabilities: false/null/undefined all count as absent", () => {
  const { present, absent } = summarizeCapabilities({
    hoverProvider: false,
    definitionProvider: null,
    // referencesProvider simply absent (undefined)
  });
  assert.ok(absent.includes("hover"));
  assert.ok(absent.includes("definition"));
  assert.ok(absent.includes("references"));
  assert.deepEqual(present, []);
});

test("summarizeCapabilities: undefined capabilities → everything absent, nothing throws", () => {
  const { present, absent } = summarizeCapabilities(undefined);
  assert.deepEqual(present, []);
  assert.equal(absent.length, Object.keys(TRACKED_CAPABILITIES).length);
});

test("TRACKED_CAPABILITIES covers the milestone-#5 features", () => {
  const labels = Object.values(TRACKED_CAPABILITIES);
  for (const needed of [
    "inlayHint",
    "implementation",
    "typeDefinition",
    "workspaceSymbol",
    "rangeFormat",
    "onTypeFormat",
  ]) {
    assert.ok(labels.includes(needed), `missing tracked capability: ${needed}`);
  }
});
