import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csharpInlayHintConfiguration,
  CSHARP_INLAY_HINT_ENABLE_SECTIONS,
  CSHARP_INLAY_HINT_SUPPRESS_SECTIONS,
} from "./csharpInlayHints.ts";

test("csharpInlayHintConfiguration(false): all enable-sections off, suppress on", () => {
  const cfg = csharpInlayHintConfiguration(false);
  for (const s of CSHARP_INLAY_HINT_ENABLE_SECTIONS) {
    assert.equal(cfg[s], false, `${s} should be false when disabled`);
  }
  for (const s of CSHARP_INLAY_HINT_SUPPRESS_SECTIONS) {
    assert.equal(cfg[s], true, `${s} (suppression) stays true`);
  }
});

test("csharpInlayHintConfiguration(true): all enable-sections on, suppress still on", () => {
  const cfg = csharpInlayHintConfiguration(true);
  for (const s of CSHARP_INLAY_HINT_ENABLE_SECTIONS) {
    assert.equal(cfg[s], true, `${s} should be true when enabled`);
  }
  for (const s of CSHARP_INLAY_HINT_SUPPRESS_SECTIONS) {
    assert.equal(cfg[s], true);
  }
});

test("covers exactly the 12 csharp|inlay_hints.* sections (9 enable + 3 suppress)", () => {
  assert.equal(CSHARP_INLAY_HINT_ENABLE_SECTIONS.length, 9);
  assert.equal(CSHARP_INLAY_HINT_SUPPRESS_SECTIONS.length, 3);
  const all = [
    ...CSHARP_INLAY_HINT_ENABLE_SECTIONS,
    ...CSHARP_INLAY_HINT_SUPPRESS_SECTIONS,
  ];
  // No duplicates, all under the inlay_hints group.
  assert.equal(new Set(all).size, all.length);
  for (const s of all) {
    assert.ok(s.startsWith("csharp|inlay_hints."), s);
  }
});
