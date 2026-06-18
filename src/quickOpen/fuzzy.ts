/**
 * Fuzzy subsequence matching and scoring for Quick Open (Ctrl+P).
 *
 * Pure, dependency-free TypeScript so it's trivial to unit-test and cheap to
 * call on every keystroke. The model mirrors VSCode's quick-open feel: a query
 * matches if its characters appear in order (a subsequence) in the target, and
 * matches that land at word boundaries / camelCase humps / the start of the
 * name score higher than ones buried mid-word.
 */

import type { ProjectFile } from "../types";

export interface FuzzyResult {
  /** Higher is better. Only meaningful for comparing matches of the same query. */
  score: number;
  /** Indices in the target string that the query matched, for highlighting. */
  positions: number[];
}

/** A ProjectFile plus the match metadata, ready to render in the list. */
export interface RankedFile {
  file: ProjectFile;
  /** Match positions within `file.name` (for bolding the matched letters). */
  positions: number[];
  score: number;
}

// Scoring weights — tuned so the "obvious" match wins. Kept as named consts so
// the ranking behavior is easy to read and adjust.
const SCORE_MATCH = 16; // base reward per matched character
const BONUS_START = 12; // match is the very first character of the target
const BONUS_WORD_BOUNDARY = 10; // match follows a separator (/ \ _ - . space)
const BONUS_CAMEL = 8; // match is an uppercase letter after a lowercase one
const BONUS_CONSECUTIVE = 8; // match immediately follows the previous match
const PENALTY_GAP = 2; // per skipped character between matches

const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}
function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/**
 * Greedy left-to-right subsequence match of `query` against `target`,
 * case-insensitive. Returns null when `query` isn't a subsequence of `target`.
 *
 * Greedy is intentional: it's O(n), matches VSCode's everyday behavior, and the
 * word-boundary/camel bonuses already pull the ranking toward the "natural"
 * interpretation without the cost of a full optimal-alignment search.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (target.length === 0) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -2; // so the first match is never "consecutive"

  for (let ti = 0; ti < target.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    positions.push(ti);
    let charScore = SCORE_MATCH;

    if (ti === 0) {
      charScore += BONUS_START;
    } else {
      const prevChar = target[ti - 1];
      if (SEPARATORS.has(prevChar)) {
        charScore += BONUS_WORD_BOUNDARY;
      } else if (isUpper(target[ti]) && isLower(prevChar)) {
        charScore += BONUS_CAMEL;
      }
    }

    if (ti === prevMatch + 1) {
      charScore += BONUS_CONSECUTIVE;
    } else if (prevMatch >= 0) {
      // Penalize the run of skipped characters since the last match.
      charScore -= PENALTY_GAP * (ti - prevMatch - 1);
    }

    score += charScore;
    prevMatch = ti;
    qi++;
  }

  // Ran out of target before consuming the whole query → not a subsequence.
  if (qi < q.length) return null;
  return { score, positions };
}

/**
 * Scores one file against the query. We try the file name first (matches there
 * matter most and get a flat bonus) and fall back to the relative path so a
 * query like "comp/btn" can still find "src/components/Button.tsx".
 *
 * Returns the match with `positions` relative to `name` when the name matched,
 * or an empty `positions` array when only the path matched (nothing to bold in
 * the name). Null when neither matched.
 */
const NAME_MATCH_BONUS = 24;

export function scoreFile(query: string, file: ProjectFile): RankedFile | null {
  const byName = fuzzyMatch(query, file.name);
  if (byName) {
    // Shorter names with the same matches read as "more exact" — nudge them up.
    const lengthPenalty = file.name.length * 0.5;
    return {
      file,
      positions: byName.positions,
      score: byName.score + NAME_MATCH_BONUS - lengthPenalty,
    };
  }

  const byPath = fuzzyMatch(query, file.rel);
  if (byPath) {
    return { file, positions: [], score: byPath.score - file.rel.length * 0.25 };
  }

  return null;
}

/**
 * Ranks `files` against `query`, best first. An empty query returns the files
 * in their natural (index) order so the palette shows something sensible before
 * the user types.
 */
export function rankFiles(query: string, files: ProjectFile[]): RankedFile[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return files.map((file) => ({ file, positions: [], score: 0 }));
  }

  const ranked: RankedFile[] = [];
  for (const file of files) {
    const r = scoreFile(trimmed, file);
    if (r) ranked.push(r);
  }

  // Sort by score desc; tie-break on shorter name, then name alphabetically so
  // the order is stable and deterministic across runs.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.file.name.length !== b.file.name.length) {
      return a.file.name.length - b.file.name.length;
    }
    return a.file.name.localeCompare(b.file.name);
  });

  return ranked;
}
