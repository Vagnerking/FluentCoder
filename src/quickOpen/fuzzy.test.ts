/**
 * Unit tests for the Quick Open fuzzy matcher. Uses the Node built-in test
 * runner (`node:test` + `node:assert`) so there are no new dependencies.
 *
 * Run with:  npm run test:unit
 * (which invokes `node --test` over the compiled output; see package.json)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectFile } from "../types";
import { fuzzyMatch, rankFiles, scoreFile } from "./fuzzy.ts";

function pf(rel: string): ProjectFile {
  const name = rel.split("/").pop() ?? rel;
  return { path: `/root/${rel}`, name, rel };
}

test("fuzzyMatch matches a subsequence", () => {
  const r = fuzzyMatch("aptsx", "App.tsx");
  assert.ok(r, "expected a match");
  assert.deepEqual(r!.positions, [0, 1, 4, 5, 6]); // a p . t s x → A p t s x
});

test("fuzzyMatch is case-insensitive", () => {
  assert.ok(fuzzyMatch("APP", "App.tsx"));
  assert.ok(fuzzyMatch("app", "App.tsx"));
});

test("fuzzyMatch returns null when not a subsequence", () => {
  assert.equal(fuzzyMatch("xyz", "App.tsx"), null);
  assert.equal(fuzzyMatch("ppa", "App.tsx"), null); // wrong order
});

test("empty query matches everything with score 0", () => {
  const r = fuzzyMatch("", "anything");
  assert.deepEqual(r, { score: 0, positions: [] });
});

test("start-of-name beats mid-word match in score", () => {
  const atStart = fuzzyMatch("app", "App.tsx")!;
  const midWord = fuzzyMatch("app", "mapper.ts")!; // m-App-er
  assert.ok(
    atStart.score > midWord.score,
    `start ${atStart.score} should beat mid ${midWord.score}`
  );
});

test("rankFiles puts the obvious match on top", () => {
  const files = [pf("src/mapper.ts"), pf("src/App.tsx"), pf("docs/apple.md")];
  const ranked = rankFiles("app", files);
  assert.equal(ranked[0].file.name, "App.tsx");
});

test("rankFiles ranks the whole list and drops non-matches", () => {
  const files = [pf("a/App.tsx"), pf("b/zzz.ts")];
  const ranked = rankFiles("app", files);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].file.name, "App.tsx");
});

test("empty query keeps natural order and returns all files", () => {
  const files = [pf("z.ts"), pf("a.ts"), pf("m.ts")];
  const ranked = rankFiles("   ", files);
  assert.deepEqual(
    ranked.map((r) => r.file.name),
    ["z.ts", "a.ts", "m.ts"]
  );
});

test("scoreFile can match on the relative path, not just the name", () => {
  const file = pf("src/components/Button.tsx");
  const r = scoreFile("compbtn", file);
  assert.ok(r, "expected a path match");
  // Matched in the path, so there's nothing to highlight in the bare name.
  assert.deepEqual(r!.positions, []);
});

test("ranking is stable: shorter name wins on a score tie", () => {
  const files = [pf("a/index.ts"), pf("b/idx.ts")];
  // "idx" is a subsequence of both; idx.ts is shorter and should win.
  const ranked = rankFiles("idx", files);
  assert.equal(ranked[0].file.name, "idx.ts");
});
