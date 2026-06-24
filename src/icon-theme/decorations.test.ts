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

test("buildDecorations: an error propagates as a color-only decoration up every ancestor folder", () => {
  const map = buildDecorations(ROOT, null, [problem(`${ROOT}/Views/Home/Index.cshtml`, "error")]);
  // The file itself:
  assert.equal(map.get(decoKey(`${ROOT}/Views/Home/Index.cshtml`))?.kind, "error");
  // Ancestor folders, color-only (dir flag, no badge):
  for (const dir of [`${ROOT}/Views/Home`, `${ROOT}/Views`, ROOT]) {
    const d = map.get(decoKey(dir));
    assert.equal(d?.kind, "error", `${dir} should be error`);
    assert.equal(d?.dir, true, `${dir} should be flagged dir`);
    assert.equal(d?.badge, undefined, `${dir} must not carry a git badge`);
  }
});

test("buildDecorations: error from one descendant outranks warning from another on shared ancestors", () => {
  const map = buildDecorations(ROOT, null, [
    problem(`${ROOT}/Views/Home/A.cshtml`, "warning"),
    problem(`${ROOT}/Views/Shared/B.cshtml`, "error"),
  ]);
  // Shared ancestor Views (and root) must be error, not warning.
  assert.equal(map.get(decoKey(`${ROOT}/Views`))?.kind, "error");
  assert.equal(map.get(decoKey(ROOT))?.kind, "error");
  // The warning-only branch stays warning.
  assert.equal(map.get(decoKey(`${ROOT}/Views/Home`))?.kind, "warning");
});

test("buildDecorations: a file OUTSIDE the workspace root never tints the root or a sibling root", () => {
  // Marker from a Monaco model outside the open folder (e.g. a sibling project).
  const map = buildDecorations(ROOT, null, [problem("C:/proj-other/X.cshtml", "error")]);
  assert.equal(map.get(decoKey(ROOT)), undefined, "the open root must not be tinted");
  assert.equal(map.get(decoKey("C:/proj-other")), undefined, "no out-of-root ancestor entry");
  // The external file itself still gets its own decoration (it just doesn't climb into our tree).
  assert.equal(map.get(decoKey("C:/proj-other/X.cshtml"))?.kind, "error");
});

test("buildDecorations: a folder with a propagated diagnostic never overrides its descendant file's git badge", () => {
  const map = buildDecorations(ROOT, git([modified("Views/Home/Index.cshtml")]), [
    problem(`${ROOT}/Views/Home/Index.cshtml`, "error"),
  ]);
  // File keeps the M badge under the error color.
  assert.deepEqual(map.get(decoKey(`${ROOT}/Views/Home/Index.cshtml`)), { kind: "error", badge: "M" });
  // Folder is error, no badge.
  assert.equal(map.get(decoKey(`${ROOT}/Views`))?.badge, undefined);
});
