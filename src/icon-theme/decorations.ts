/**
 * Builds explorer/tab file decorations (label color + git badge) from the data
 * the app already has: `git status` and Monaco diagnostics. Keeping this derivation
 * in one place means the explorer, tabs, and breadcrumbs all decorate identically.
 *
 * Precedence per file: an error/warning diagnostic outranks the git state, since
 * a broken file matters more visually than a merely-changed one — same as VSCode.
 */
import type {
  FileDecoration,
  GitStatus,
  GitFileStatus,
  Problem,
} from "../types";

/** Maps a git porcelain entry to a decoration (color kind + one-letter badge). */
function gitDecoration(file: GitFileStatus): FileDecoration {
  if (file.untracked) return { kind: "untracked", badge: "U" };
  const idx = file.code.charAt(0);
  const wt = file.code.charAt(1);
  // Conflict markers (UU, AA, DD…) have the same letter in both columns.
  if (idx === "U" || wt === "U" || (idx === wt && (idx === "A" || idx === "D"))) {
    return { kind: "conflict", badge: "!" };
  }
  const c = file.staged ? idx : wt;
  switch (c) {
    case "A":
      return { kind: "added", badge: "A" };
    case "D":
      return { kind: "deleted", badge: "D" };
    case "R":
      return { kind: "modified", badge: "R" };
    case "M":
    default:
      return { kind: "modified", badge: "M" };
  }
}

/**
 * Returns a `path → FileDecoration` lookup. `rootPath` joins git's repo-relative
 * paths to the absolute paths the explorer uses; diagnostics already carry an
 * absolute path. Worst diagnostic severity per file wins (error over warning).
 */
export function buildDecorations(
  rootPath: string | null,
  git: GitStatus | null,
  problems: Problem[],
): Map<string, FileDecoration> {
  const map = new Map<string, FileDecoration>();

  // Git state first; diagnostics override it below. Keys go through `decoKey`
  // (slash + drive-letter normalization) so they match the lookup in
  // `decorationFor` — otherwise a `C:/…` marker path vs a `c:/…` tree path would
  // never line up on Windows and the decoration would silently not render.
  if (git?.isRepo && rootPath) {
    for (const f of git.files) {
      map.set(decoKey(`${rootPath}/${f.path}`), gitDecoration(f));
    }
  }

  // Diagnostics outrank git: a file with errors shows the error color/badge.
  for (const p of problems) {
    if (p.severity === "info") continue;
    const key = decoKey(p.path);
    const existing = map.get(key);
    if (p.severity === "error") {
      map.set(key, { kind: "error", badge: existing?.badge });
    } else if (existing?.kind !== "error") {
      map.set(key, { kind: "warning", badge: existing?.badge });
    }
    // Propagate the diagnostic color UP to every ancestor folder (like VSCode):
    // a folder containing a broken file is tinted red/yellow. Folders carry the
    // color only — never a git badge — so they're decorated separately here, and
    // error still outranks warning at each level.
    propagateToAncestors(map, key, decoKey(rootPath ?? ""), p.severity);
  }

  return map;
}

/**
 * Tints every ancestor directory of `fileKey` (up to and including `rootKey`)
 * with `severity`, error outranking a previously-set warning. Ancestor entries
 * are color-only (no badge) and flagged `dir: true` so the tree knows a folder
 * decoration is a propagated diagnostic, not a git state.
 */
function propagateToAncestors(
  map: Map<string, FileDecoration>,
  fileKey: string,
  rootKey: string,
  severity: "error" | "warning",
): void {
  let dir = parentDir(fileKey);
  // Walk up while still inside the workspace root. The strict boundary check
  // (not a bare `startsWith`) keeps a file OUTSIDE the root — markers can come
  // from any open Monaco model — from creating out-of-root ancestor entries, and
  // prevents a sibling root like `…/proj-other` from matching `…/proj`. With no
  // folder open (rootKey === "") we stop at whatever boundary parentDir reaches.
  while (dir && isInsideOrSame(dir, rootKey)) {
    const existing = map.get(dir);
    if (existing?.kind === "error") break; // a stronger sibling already tinted up
    if (severity === "error" || existing?.kind !== "warning") {
      map.set(dir, { kind: severity, dir: true });
    }
    if (dir === rootKey) break;
    const next = parentDir(dir);
    if (next === dir) break; // reached the top (drive root)
    dir = next;
  }
}

/** Parent directory of a normalized key, or "" at the root. */
function parentDir(key: string): string {
  const i = key.lastIndexOf("/");
  return i <= 0 ? "" : key.slice(0, i);
}

/**
 * Whether `key` is `rootKey` itself or a path nested under it. Boundary-aware so
 * `c:/proj-other` is NOT considered inside `c:/proj`. `rootKey === ""` (no folder
 * open) matches everything — we just propagate up to the drive boundary then.
 */
function isInsideOrSame(key: string, rootKey: string): boolean {
  return rootKey === "" || key === rootKey || key.startsWith(`${rootKey}/`);
}

/** Normalizes a path for decoration lookup (separators + Windows drive case agnostic). */
export function decoKey(path: string): string {
  let p = path.replace(/\\/g, "/");
  // Lowercase the drive letter so `C:/foo` and `c:/foo` map to the same key.
  if (/^[a-zA-Z]:\//.test(p)) p = p.charAt(0).toLowerCase() + p.slice(1);
  return p;
}
