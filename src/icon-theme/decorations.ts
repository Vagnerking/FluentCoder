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
  }

  return map;
}

/** Normalizes a path for decoration lookup (separators + Windows drive case agnostic). */
export function decoKey(path: string): string {
  let p = path.replace(/\\/g, "/");
  // Lowercase the drive letter so `C:/foo` and `c:/foo` map to the same key.
  if (/^[a-zA-Z]:\//.test(p)) p = p.charAt(0).toLowerCase() + p.slice(1);
  return p;
}
