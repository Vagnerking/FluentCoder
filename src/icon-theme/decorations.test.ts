import assert from "node:assert/strict";
import test from "node:test";
import { buildDecorations, decoKey } from "./decorations.ts";
import type { GitStatus, GitFileStatus, Problem } from "../types.ts";

const ROOT = "C:/proj";

function git(files: GitFileStatus[]): GitStatus {
  return {
    branch: "main",
    ahead: 0,
    behind: 0,
    isRepo: true,
    hasUpstream: false,
    files,
  };
}

function modified(path: string): GitFileStatus {
  return { path, code: " M", staged: false, untracked: false };
}

function problem(path: string, severity: Problem["severity"]): Problem {
  return { path, name: path.split("/").pop()!, severity, message: "x", line: 1, column: 1 };
}

test("buildDecorations: a modified git file -> modified kind + M badge", () => {
  const map = buildDecorations(ROOT, git([modified("a.cs")]), []);
  assert.deepEqual(map.get(decoKey(`${ROOT}/a.cs`)), { kind: "modified", badge: "M" });
});

test("buildDecorations: an error outranks git and keeps the git badge", () => {
  const map = buildDecorations(ROOT, git([modified("a.cs")]), [problem(`${ROOT}/a.cs`, "error")]);
  assert.deepEqual(map.get(decoKey(`${ROOT}/a.cs`)), { kind: "error", badge: "M" });
});

test("buildDecorations: a warning does not override an existing error", () => {
  const map = buildDecorations(ROOT, null, [
    problem(`${ROOT}/a.cs`, "warning"),
    problem(`${ROOT}/a.cs`, "error"),
  ]);
  assert.equal(map.get(decoKey(`${ROOT}/a.cs`))?.kind, "error");
});

test("buildDecorations: warning + git modified -> warning kind, git badge kept", () => {
  const map = buildDecorations(ROOT, git([modified("a.cs")]), [problem(`${ROOT}/a.cs`, "warning")]);
  assert.deepEqual(map.get(decoKey(`${ROOT}/a.cs`)), { kind: "warning", badge: "M" });
});

test("buildDecorations: info-severity diagnostics never decorate", () => {
  const map = buildDecorations(ROOT, null, [problem(`${ROOT}/a.cs`, "info")]);
  assert.equal(map.get(decoKey(`${ROOT}/a.cs`)), undefined);
});

// The Windows regression Codex flagged: a marker path with an uppercase drive +
// backslashes (as Monaco hands back) must still resolve against a lookup that
// uses forward slashes + a lowercase drive. Both the build key and the lookup go
// through decoKey, so they line up regardless of drive-letter case / separators.
test("buildDecorations: resolves a .cshtml error across drive-case / separator mismatch", () => {
  const markerPath = "C:\\proj\\Views\\Index.cshtml";
  const map = buildDecorations(ROOT, null, [problem(markerPath, "error")]);
  assert.equal(map.get(decoKey("c:/proj/Views/Index.cshtml"))?.kind, "error");
});
