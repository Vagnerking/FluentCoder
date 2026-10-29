import assert from "node:assert/strict";
import test from "node:test";
import { decideOpen, formatSize, HUGE_FILE_BYTES, largeFileLanguage, LARGE_FILE_BYTES, LARGE_FILE_EDITOR_OPTIONS } from "./fileOpenPolicy.ts";

test("arquivos pequenos abrem normalmente", () => {
  assert.deepEqual(decideOpen({ size: 10, binary: false }), { kind: "normal" });
  assert.deepEqual(decideOpen({ size: LARGE_FILE_BYTES, binary: false }), { kind: "normal" });
});

test("acima de 5 MB: modo de arquivo grande; acima de 50 MB: confirma", () => {
  assert.deepEqual(decideOpen({ size: LARGE_FILE_BYTES + 1, binary: false }), { kind: "large" });
  assert.deepEqual(decideOpen({ size: HUGE_FILE_BYTES + 1, binary: false }), { kind: "confirm-huge" });
});

test("binário sempre pergunta (e leva o modo grande junto quando passa de 5 MB)", () => {
  assert.deepEqual(decideOpen({ size: 100, binary: true }), { kind: "confirm-binary", large: false });
  assert.deepEqual(decideOpen({ size: HUGE_FILE_BYTES * 2, binary: true }), { kind: "confirm-binary", large: true });
});

test("modo grande desliga recursos pesados e o LSP (plaintext)", () => {
  assert.equal(LARGE_FILE_EDITOR_OPTIONS.largeFileOptimizations, true);
  assert.equal(LARGE_FILE_EDITOR_OPTIONS.folding, false);
  assert.equal(LARGE_FILE_EDITOR_OPTIONS.minimap.enabled, false);
  assert.equal(LARGE_FILE_EDITOR_OPTIONS.semanticHighlighting.enabled, false);
  assert.equal(largeFileLanguage("csharp", true), "plaintext");
  assert.equal(largeFileLanguage("csharp", false), "csharp");
});

test("tamanho legível", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(60 * 1024 * 1024), "60.0 MB");
});
