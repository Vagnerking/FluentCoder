import assert from "node:assert/strict";
import test from "node:test";
import type { BlameHunk } from "../../types.ts";
import { blameAgeBucket, buildFileAnnotationSpecs, toggleAnnotationMode } from "./gitAnnotations.ts";

const hunk = (line: number, date: string) => ({ line, date, author: "A", short: "abc1234", subject: "s" }) as unknown as BlameHunk;

test("faixas de recência", () => {
  // Formatos do backend (git.rs: "agora", "há N min|h|dias|meses|anos").
  assert.equal(blameAgeBucket("agora"), "hot");
  assert.equal(blameAgeBucket("há 5 min"), "hot");
  assert.equal(blameAgeBucket("há 3 h"), "hot");
  assert.equal(blameAgeBucket("há 3 dias"), "warm");
  assert.equal(blameAgeBucket("há 30 dias"), "cool");
  assert.equal(blameAgeBucket("há 3 meses"), "cool");
  assert.equal(blameAgeBucket("há 2 anos"), "cold");
});

test("modo off (padrão) não produz decorações", () => {
  const blame = new Map([[1, hunk(1, "há 1 h")]]);
  assert.deepEqual(buildFileAnnotationSpecs(blame, 10, "off"), []);
});

test("blame e heatmap decoram só linhas com hunk e dentro do modelo", () => {
  const blame = new Map([
    [1, hunk(1, "há 1 h")],
    [3, hunk(3, "há 2 anos")],
    [99, hunk(99, "há 2 anos")],
  ]);
  const b = buildFileAnnotationSpecs(blame, 5, "blame");
  assert.deepEqual(b.map((s) => [s.line, s.className]), [
    [1, "git-file-annotation-blame"],
    [3, "git-file-annotation-blame"],
  ]);
  const h = buildFileAnnotationSpecs(blame, 5, "heatmap");
  assert.deepEqual(h.map((s) => s.className), [
    "git-file-annotation-heatmap git-file-annotation-hot",
    "git-file-annotation-heatmap git-file-annotation-cold",
  ]);
});

test("toggle: ligar o mesmo modo de novo desliga; outro modo troca", () => {
  assert.equal(toggleAnnotationMode("off", "blame"), "blame");
  assert.equal(toggleAnnotationMode("blame", "blame"), "off");
  assert.equal(toggleAnnotationMode("blame", "heatmap"), "heatmap");
});
