/**
 * Virtual HTML projection of a `.cshtml` (Fase C — HTML IntelliSense in Razor).
 *
 * The trick that makes HTML support cheap: produce an HTML-only view of the
 * `.cshtml` where every Razor/C# construct (`@expr`, `@{ }`, `@( )`, `@* *@`,
 * `@:` lines, `<text>` markers) is replaced by **same-length whitespace**, with
 * newlines preserved. Because we only blank characters (never insert or delete),
 * a position in the `.cshtml` is the IDENTICAL `(line, character)` in the virtual
 * HTML — no source map, no remap. We hand the blanked text to
 * `vscode-html-languageservice` and its ranges already line up with the `.cshtml`.
 *
 * This module is intentionally dependency-free (no monaco, no html service) so it
 * runs under the `node:test` harness exactly like `razorProjectionRouting.ts`.
 *
 * The Razor-region scanning mirrors `scanRazorMarkup` in `lint/razorHtmlLint.ts`
 * (same `@*`, `@{ }`/`@( )` depth-aware, `@expr`-run handling) — the linter finds
 * stray tags, this blanks the same regions. Keep the two in sync.
 */

const SPACE = " ";

/** Whether `ch` continues an HTML/Razor identifier run. */
function isNameChar(ch: string): boolean {
  return /[a-zA-Z0-9-]/.test(ch);
}

/** The virtual HTML view of a `.cshtml`, plus a per-offset region mask. */
export interface VirtualHtml {
  /** Same-length HTML text with Razor regions blanked to spaces. */
  html: string;
  /**
   * Per UTF-16 offset: 1 = this char is real HTML, 0 = it was a Razor/C# region
   * (blanked). Needed because blanking uses spaces, which are INDISTINGUISHABLE
   * from real HTML whitespace in `html` alone — so `<div |` (caret after a real
   * space) would otherwise misclassify as Razor. The mask is the region oracle.
   */
  mask: Uint8Array;
}

/**
 * Blank `[from, to)` of `chars` to spaces (keeping newlines) AND mark those
 * offsets as Razor (mask 0) — they are not HTML.
 */
function blank(chars: string[], mask: Uint8Array, from: number, to: number): void {
  for (let i = from; i < to && i < chars.length; i++) {
    const c = chars[i];
    if (c !== "\n" && c !== "\r") chars[i] = SPACE;
    mask[i] = 0;
  }
}

/**
 * Builds the virtual HTML view: same length as `cshtml`, newlines preserved, all
 * Razor/C# regions blanked to spaces, plus a mask marking which offsets are real
 * HTML. HTML markup is left untouched at its original offsets (identity mapping).
 */
export function buildVirtualHtml(cshtml: string): VirtualHtml {
  // Operate on a UTF-16 code-UNIT array (NOT code points) so indices match
  // Monaco's `getOffsetAt` and `vscode-languageserver-textdocument`, which both
  // count UTF-16 units. `Array.from` would split by code point and desync offsets
  // for astral chars (emoji), breaking the identity-offset invariant. `split("")`
  // keeps each surrogate half as its own slot — same indexing as Monaco.
  const chars = cshtml.split("");
  // mask defaults to 1 (HTML); blanking flips Razor offsets to 0.
  const mask = new Uint8Array(chars.length).fill(1);
  const n = chars.length;
  let i = 0;

  while (i < n) {
    const c = chars[i];

    // --- Razor regions: blank so the HTML parser never sees `@`-syntax ---
    if (c === "@") {
      const next = chars[i + 1];

      // `@@` escapes a literal `@` — blank both; `@` isn't HTML-significant.
      if (next === "@") {
        blank(chars, mask, i, i + 2);
        i += 2;
        continue;
      }
      // `@* razor comment *@`
      if (next === "*") {
        const end = cshtml.indexOf("*@", i + 2);
        const stop = end < 0 ? n : end + 2;
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }
      // `@{ code }` / `@( expr )` — depth-aware so nested braces/parens are kept.
      if (next === "{" || next === "(") {
        const open = next;
        const close = open === "{" ? "}" : ")";
        let j = i + 2;
        let depth = 1;
        while (j < n && depth > 0) {
          if (chars[j] === open) depth++;
          else if (chars[j] === close) depth--;
          j++;
        }
        blank(chars, mask, i, j);
        i = j;
        continue;
      }
      // `@:` — single-line markup transition. Blank only the `@:` token; the rest
      // of the line is markup and stays as HTML.
      if (next === ":") {
        blank(chars, mask, i, i + 2);
        i += 2;
        continue;
      }
      // `@Model.Foo`, `@ViewData["x"]`, `@if`… — blank the expression run up to
      // the next whitespace or `<` (a tag re-enters markup).
      let j = i + 1;
      while (j < n && !/[\s<]/.test(chars[j])) j++;
      blank(chars, mask, i, j);
      i = j;
      continue;
    }

    if (c === "<") {
      // `<text>` / `</text>` — Razor's "emit literal" marker, not real HTML. Blank
      // the marker tag so the HTML parser doesn't try to balance a bogus element.
      const isText =
        cshtml.startsWith("<text>", i) || cshtml.startsWith("</text>", i);
      if (isText) {
        const end = cshtml.indexOf(">", i);
        const stop = end < 0 ? n : end + 1;
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }

      // HTML comments / doctype / declarations — leave as-is (valid HTML); just
      // skip past them so an `@` inside a comment isn't treated as Razor.
      if (chars[i + 1] === "!") {
        if (cshtml.startsWith("<!--", i)) {
          const end = cshtml.indexOf("-->", i + 4);
          i = end < 0 ? n : end + 3;
        } else {
          const end = cshtml.indexOf(">", i);
          i = end < 0 ? n : end + 1;
        }
        continue;
      }

      // A real tag: skip to its `>` so an `@` inside an attribute value (already
      // blanked above when we reach it) or a `>` outside quotes is handled. We
      // don't blank tags; we just advance past them, blanking any `@`-runs that
      // appear inside as we re-enter the loop.
      let j = i + 1;
      // Tag name (or `/` for a close tag).
      if (chars[j] === "/") j++;
      const nameStart = j;
      while (j < n && isNameChar(chars[j])) j++;
      if (j === nameStart) {
        // `<` not followed by a name — a literal `<` in text. Leave it; advance 1.
        i++;
        continue;
      }
      // Walk attributes to the closing `>`, blanking `@`-expressions inside
      // attribute values (e.g. class="@x") while preserving quotes/structure.
      let quote = "";
      while (j < n) {
        const ch = chars[j];
        if (quote) {
          if (ch === "@") {
            // `@expr` / `@(...)` inside an attribute value → blank it.
            j = blankInlineRazor(chars, mask, j, n);
            continue;
          }
          if (ch === quote) quote = "";
          j++;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
          j++;
        } else if (ch === ">") {
          j++;
          break;
        } else if (ch === "@") {
          j = blankInlineRazor(chars, mask, j, n);
        } else {
          j++;
        }
      }
      i = j;
      continue;
    }

    i++;
  }

  return { html: chars.join(""), mask };
}

/**
 * Blanks one inline Razor construct starting at `@` (offset `at`) and returns the
 * offset just past it. Handles `@(...)` / `@{...}` (depth-aware) and `@expr`
 * runs. Used inside attribute scanning, where the run ends at the quote, `>` or
 * whitespace as well.
 */
function blankInlineRazor(
  chars: string[],
  mask: Uint8Array,
  at: number,
  n: number
): number {
  const next = chars[at + 1];
  if (next === "@") {
    blank(chars, mask, at, at + 2);
    return at + 2;
  }
  if (next === "(" || next === "{") {
    const open = next;
    const close = open === "(" ? ")" : "}";
    let j = at + 2;
    let depth = 1;
    while (j < n && depth > 0) {
      if (chars[j] === open) depth++;
      else if (chars[j] === close) depth--;
      j++;
    }
    blank(chars, mask, at, j);
    return j;
  }
  // `@expr` — stop at whitespace, quote, `>` or `<` (still inside a tag here).
  let j = at + 1;
  while (j < n && !/[\s"'<>]/.test(chars[j])) j++;
  blank(chars, mask, at, j);
  return j;
}

/** A region classification at a given offset. */
export type Region = "html" | "razor";

/**
 * Classifies the offset in the `.cshtml` as HTML or Razor using the region MASK
 * (not the blanked text): `mask[i] === 1` means real HTML. The mask fixes the
 * "blank == space" ambiguity — real HTML whitespace (e.g. the space in `<div |`)
 * has `mask=1`, while a blanked Razor region has `mask=0`, though both render as a
 * space in `html`.
 *
 * LEFT-CHAR WINS: completion/hover act on the token immediately BEFORE the caret,
 * so the char to the left decides the region. This is what makes `@Model.|</p>`
 * resolve to Razor (C# member completion) even though the next char is the HTML
 * `<` of `</p>`: the left char `.` is the blanked Razor region. At the very start
 * of the document (no left char) we use the char at the offset instead.
 *   `<di|`        → left `i` HTML  → html
 *   `<div |>`     → left ` ` HTML  → html (attribute spot)
 *   `@Model.|</p>`→ left `.` Razor → razor  (the bug this fixes)
 *   `@Mod|`       → left `d` Razor → razor
 */
export function regionAt(mask: Uint8Array, offset: number): Region {
  const isHtml = (idx: number): boolean =>
    idx >= 0 && idx < mask.length && mask[idx] === 1;
  const probe = offset > 0 ? offset - 1 : 0;
  return isHtml(probe) ? "html" : "razor";
}
