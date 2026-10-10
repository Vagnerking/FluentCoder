import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeTokens,
  encodeTokens,
  remapSemanticTokens,
  type TokenRange,
  type RemappedRange,
} from "./cshtmlSemanticTokens.ts";

const LEGEND = { tokenTypes: ["class", "method", "variable"] };

test("decode/encode round-trips a relative stream", () => {
  // 2 tokens: line0 char0 len5 type0; line2 char4 len3 type1.
  const data = [0, 0, 5, 0, 0, 2, 4, 3, 1, 0];
  const abs = decodeTokens(data);
  assert.deepEqual(abs[0], { line: 0, char: 0, length: 5, tokenType: 0, tokenModifiers: 0 });
  assert.deepEqual(abs[1], { line: 2, char: 4, length: 3, tokenType: 1, tokenModifiers: 0 });
  assert.deepEqual(encodeTokens(abs), data);
});

test("decode handles same-line delta (deltaChar accumulates)", () => {
  // token A at (0,0); token B at (0,10) → deltaLine 0, deltaChar 10.
  const abs = decodeTokens([0, 0, 3, 0, 0, 0, 10, 4, 2, 0]);
  assert.equal(abs[1].line, 0);
  assert.equal(abs[1].char, 10);
});

test("remap drops synthetic tokens and re-sorts by source position", async () => {
  // gen tokens at lines 10 and 5; remap swaps them to cshtml lines 3 and 1 → must
  // be re-sorted ascending. One extra token maps to null (synthetic) → dropped.
  const data = encodeTokens([
    { line: 10, char: 2, length: 4, tokenType: 0, tokenModifiers: 0 },
    { line: 5, char: 0, length: 3, tokenType: 1, tokenModifiers: 0 },
    { line: 99, char: 0, length: 2, tokenType: 2, tokenModifiers: 0 },
  ]);
  const remap = async (ranges: TokenRange[]): Promise<RemappedRange[]> =>
    ranges.map((r) => {
      if (r.start.line === 10) return { start: { line: 3, character: 2 }, end: { line: 3, character: 6 } };
      if (r.start.line === 5) return { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
      return null; // line 99 = synthetic
    });
  const out = await remapSemanticTokens(data, LEGEND, remap);
  const abs = decodeTokens(out);
  assert.equal(abs.length, 2);
  // Sorted: line 1 first, then line 3.
  assert.equal(abs[0].line, 1);
  assert.equal(abs[1].line, 3);
});

test("remap drops multi-line and zero-width remapped ranges", async () => {
  const data = encodeTokens([
    { line: 0, char: 0, length: 4, tokenType: 0, tokenModifiers: 0 },
    { line: 1, char: 0, length: 4, tokenType: 0, tokenModifiers: 0 },
  ]);
  const remap = async (ranges: TokenRange[]): Promise<RemappedRange[]> =>
    ranges.map((r) =>
      r.start.line === 0
        ? { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } // multi-line → drop
        : { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } } // zero-width → drop
    );
  const out = await remapSemanticTokens(data, LEGEND, remap);
  assert.deepEqual(out, []);
});

test("remap drops tokens whose type has no legend name", async () => {
  const data = encodeTokens([{ line: 0, char: 0, length: 4, tokenType: 99, tokenModifiers: 0 }]);
  const remap = async (ranges: TokenRange[]): Promise<RemappedRange[]> =>
    ranges.map(() => ({ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }));
  assert.deepEqual(await remapSemanticTokens(data, LEGEND, remap), []);
});

test("empty stream yields empty", async () => {
  assert.deepEqual(await remapSemanticTokens([], LEGEND, async () => []), []);
});
