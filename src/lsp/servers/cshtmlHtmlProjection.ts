/**
 * Virtual HTML projection of a `.cshtml` (Fase C — HTML IntelliSense in Razor).
 *
 * The trick that makes HTML support cheap: produce an HTML-only view of the
 * `.cshtml` where every Razor/C# construct (`@expr`, `@{ }`, `@( )`, `@* *@`,
 * `@:` lines, `<text>` markers, `@model`-style directives, `@if/@foreach/...`
 * statement blocks) is replaced by **same-length whitespace**, with newlines
 * preserved. Because we only blank characters (never insert or delete), a
 * position in the `.cshtml` is the IDENTICAL `(line, character)` in the virtual
 * HTML — no source map, no remap. We hand the blanked text to
 * `vscode-html-languageservice` and its ranges already line up with the `.cshtml`.
 *
 * Two mutually-recursive modes mirror the real Razor lexer:
 *   - MARKUP mode (`processMarkup`): HTML passes through; `@…` constructs are
 *     blanked; `@if/@foreach/…` hand their `{ }` bodies to code mode.
 *   - CODE mode (`processCodeBlock`): C# is blanked; a tag at statement start
 *     (or an `@:` line) re-enters markup mode for that element — so the HTML
 *     inside `@if (x) { <p>@y</p> }` stays real HTML instead of vanishing.
 *
 * This module is intentionally dependency-free (no monaco, no html service) so it
 * runs under the `node:test` harness exactly like `razorProjectionRouting.ts`.
 * It is ALSO the single Razor-region oracle: `lint/razorHtmlLint.ts` scans the
 * blanked `html` text (no duplicated scanner to drift out of sync).
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
 * Razor single-line directives: `@word` + the REST OF THE LINE is C#/metadata
 * (type names, namespaces, service registrations) — never HTML. The old scanner
 * blanked only the word, leaking `Foo.Bar` from `@model Foo.Bar` into the HTML
 * view (phantom text/tags for the linter + wrong region for completion).
 */
const LINE_DIRECTIVES = new Set([
  "model",
  "using", // import form — the statement form `@using (…) { }` is detected by its `(`
  "inject",
  "inherits",
  "implements",
  "namespace",
  "page",
  "layout",
  "addTagHelper",
  "removeTagHelper",
  "tagHelperPrefix",
  "attribute",
  "typeparam",
  "preservewhitespace",
]);

/** Razor C# statement keywords that open a `{ }` code block after `@`. */
const BLOCK_KEYWORDS = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "lock",
  "using", // statement form (with parens)
  "try",
  "do",
]);

/** HTML void elements — never pushed onto a tag stack (no close tag). */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Find the end of a balanced `@{...}` / `@(...)` C# block, QUOTE-AWARE. Given the
 * index `open` of the opening `{`/`(`, returns the index just past its matching
 * close. Delimiters inside C# string/char literals and comments are IGNORED, so
 * `@(")")` and `@{ var s = "}"; }` don't terminate early (the bug a naive depth
 * counter hits). Handles `"..."`, `'...'`, verbatim `@"..."`/`@$"..."`/`$@"..."`
 * (where `""` escapes a quote), C# line comments (slash-slash), and C# block
 * comments (slash-star).
 */
function scanBalancedEnd(chars: string[], open: number, n: number): number {
  const openCh = chars[open];
  const closeCh = openCh === "{" ? "}" : openCh === "[" ? "]" : ")";
  let j = open + 1;
  let depth = 1;
  while (j < n && depth > 0) {
    const ch = chars[j];
    // String/char literals — skip their contents so braces/parens inside don't count.
    if (ch === '"' || ch === "'") {
      // Verbatim string: `@"..."`, `@$"..."` or `$@"..."` — `""` escapes a quote,
      // `\` does NOT escape. (`$"...{…}"` interpolation holes are approximated:
      // the skip ends at the first unescaped quote.)
      const verbatim =
        ch === '"' &&
        (chars[j - 1] === "@" ||
          (chars[j - 1] === "$" && chars[j - 2] === "@") ||
          (chars[j - 1] === "@" && chars[j - 2] === "$"));
      const quote = ch;
      j++;
      while (j < n) {
        if (verbatim) {
          if (chars[j] === '"') {
            if (chars[j + 1] === '"') { j += 2; continue; } // escaped `""`
            j++;
            break;
          }
          j++;
        } else {
          if (chars[j] === "\\") { j += 2; continue; } // escaped char
          if (chars[j] === quote) { j++; break; }
          j++;
        }
      }
      continue;
    }
    // Comments — `//` to EOL, `/* */` to its close.
    if (ch === "/" && chars[j + 1] === "/") {
      while (j < n && chars[j] !== "\n") j++;
      continue;
    }
    if (ch === "/" && chars[j + 1] === "*") {
      j += 2;
      while (j < n && !(chars[j] === "*" && chars[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) depth--;
    j++;
  }
  return j;
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

/** Index just past the current line (position of `\n` — exclusive bound). */
function lineEndFrom(chars: string[], at: number, n: number): number {
  let e = at;
  while (e < n && chars[e] !== "\n") e++;
  return e;
}

/** Read an identifier `[A-Za-z_][A-Za-z0-9_]*` at `at`; empty if none. */
function readWord(chars: string[], at: number, n: number): string {
  if (at >= n || !/[A-Za-z_]/.test(chars[at])) return "";
  let j = at + 1;
  while (j < n && /[A-Za-z0-9_]/.test(chars[j])) j++;
  return chars.slice(at, j).join("");
}

/** First non-space/tab index at/after `at` ON THE SAME LINE (stops at `\n`). */
function skipInlineWs(chars: string[], at: number, n: number): number {
  let j = at;
  while (j < n && (chars[j] === " " || chars[j] === "\t")) j++;
  return j;
}

/** First non-whitespace index at/after `at` (crosses newlines). */
function skipWs(chars: string[], at: number, n: number): number {
  let j = at;
  while (j < n && /\s/.test(chars[j])) j++;
  return j;
}

/**
 * Consume a Razor IMPLICIT expression starting at the `@` (index `at`):
 * `@` + identifier, then repeated `.member`, `(...)`, `[...]`. The `(...)`/`[...]`
 * segments are BALANCED (quote/comment-aware) and may contain spaces and lambdas.
 * An UNCLOSED bracket (still being typed) clamps to the line end so it never
 * swallows the rest of the file. Returns the index just past the run.
 */
function implicitRunEnd(chars: string[], at: number, n: number): number {
  const lineEnd = lineEndFrom(chars, at + 1, n);
  let j = at + 1;
  while (j < n) {
    const ch = chars[j];
    if (/[A-Za-z0-9_.]/.test(ch)) { j++; continue; }
    if (ch === "(" || ch === "[") {
      const end = scanBalancedEnd(chars, j, n);
      // Closed on this line → continue the run past it; unclosed (ran past the
      // line) → clamp to line end (incomplete expr being typed).
      j = end <= lineEnd ? end : lineEnd;
      if (j >= lineEnd) break;
      continue;
    }
    break; // whitespace / `<` / operator outside a bracket → end of implicit expr
  }
  return j;
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
  processMarkup(cshtml, chars, mask, 0, chars.length);
  return { html: chars.join(""), mask };
}

/**
 * MARKUP mode over `[from, to)`: HTML passes through, `@…` constructs are
 * blanked, statement keywords hand their bodies to CODE mode.
 */
function processMarkup(
  src: string,
  chars: string[],
  mask: Uint8Array,
  from: number,
  to: number
): void {
  let i = from;

  while (i < to) {
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
        const end = src.indexOf("*@", i + 2);
        const stop = end < 0 || end + 2 > to ? to : end + 2;
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }
      // `@{ code }` — CODE mode (markup inside the block re-enters recursively).
      if (next === "{") {
        i = processCodeBlock(src, chars, mask, i + 1, to, /* blankLead */ i);
        continue;
      }
      // `@( expr )` — depth-aware AND quote-aware so braces/parens inside C#
      // strings/comments (e.g. `@(")")`) don't close the block early.
      if (next === "(") {
        const j = scanBalancedEnd(chars, i + 1, to);
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

      // Razor's email/literal exception: `@` preceded by an identifier char is
      // LITERAL text (`contato@empresa.com`), not a transition — leave it as
      // HTML instead of fabricating an expression region out of the domain.
      const prevRaw = i > 0 ? src[i - 1] : undefined;
      if (prevRaw !== undefined && /[A-Za-z0-9_]/.test(prevRaw)) {
        i++;
        continue;
      }

      const word = readWord(chars, i + 1, to);

      // `@using` disambiguation: statement (`@using (var x = …) { }`) iff the
      // next non-space char is `(`; otherwise it's the import directive line.
      const isUsingStatement =
        word === "using" && chars[skipInlineWs(chars, i + 1 + word.length, to)] === "(";

      // Single-line directives: the WHOLE line is C#/metadata, not HTML.
      if (LINE_DIRECTIVES.has(word) && !isUsingStatement) {
        const stop = lineEndFrom(chars, i, to);
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }

      // `@functions { … }` — pure C# members: blank the whole block.
      if (word === "functions") {
        const brace = skipWs(chars, i + 1 + word.length, to);
        if (chars[brace] === "{") {
          const end = scanBalancedEnd(chars, brace, to);
          blank(chars, mask, i, end);
          i = end;
          continue;
        }
        const stop = lineEndFrom(chars, i, to);
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }

      // `@section Name { …markup… }` — blank the header + braces; the body is
      // markup (CODE mode re-enters markup for element/`@:` content, which is
      // exactly what section bodies hold).
      if (word === "section") {
        let j = skipInlineWs(chars, i + 1 + word.length, to);
        while (j < to && /[A-Za-z0-9_]/.test(chars[j])) j++; // section name
        j = skipWs(chars, j, to);
        if (chars[j] === "{") {
          blank(chars, mask, i, j); // header (`@section Name`)
          i = processCodeBlock(src, chars, mask, j, to, j);
          continue;
        }
        const stop = lineEndFrom(chars, i, to);
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }

      // `@if/@foreach/@for/@while/@switch/@lock/@using(…)/@try/@do` — statement
      // blocks. The old scanner blanked only the keyword, leaking the condition
      // and the whole C# body into the HTML view (phantom tags from generics like
      // `List<string>`, bogus regions, linter noise).
      if (BLOCK_KEYWORDS.has(word)) {
        i = processStatementChain(src, chars, mask, i, to, word);
        continue;
      }

      // `@Model.Foo`, `@ViewData["x"]`, `@Model.Where(x => x.Y)`… — implicit
      // expression run (balanced call/index segments, clamped to the line when
      // an unclosed `(`/`[` is still being typed).
      const j = implicitRunEnd(chars, i, to);
      blank(chars, mask, i, j);
      i = j;
      continue;
    }

    if (c === "<") {
      // `<text>` / `</text>` — Razor's "emit literal" marker, not real HTML. Blank
      // the marker tag so the HTML parser doesn't try to balance a bogus element.
      const isText = src.startsWith("<text>", i) || src.startsWith("</text>", i);
      if (isText) {
        const end = src.indexOf(">", i);
        const stop = end < 0 || end + 1 > to ? to : end + 1;
        blank(chars, mask, i, stop);
        i = stop;
        continue;
      }

      // HTML comments / doctype / declarations — leave as-is (valid HTML); just
      // skip past them so an `@` inside a comment isn't treated as Razor.
      if (chars[i + 1] === "!") {
        if (src.startsWith("<!--", i)) {
          const end = src.indexOf("-->", i + 4);
          i = end < 0 || end + 3 > to ? to : end + 3;
        } else {
          const end = src.indexOf(">", i);
          i = end < 0 || end + 1 > to ? to : end + 1;
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
      while (j < to && isNameChar(chars[j])) j++;
      if (j === nameStart) {
        // `<` not followed by a name — a literal `<` in text. Leave it; advance 1.
        i++;
        continue;
      }
      // Walk attributes to the closing `>`, blanking `@`-expressions inside
      // attribute values (e.g. class="@x") while preserving quotes/structure.
      let quote = "";
      while (j < to) {
        const ch = chars[j];
        if (quote) {
          if (ch === "@") {
            // `@expr` / `@(...)` inside an attribute value → blank it.
            j = blankInlineRazor(src, chars, mask, j, to);
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
          j = blankInlineRazor(src, chars, mask, j, to);
        } else {
          j++;
        }
      }
      i = j;
      continue;
    }

    i++;
  }
}

/**
 * A `@keyword …` statement chain starting at the `@` (index `at`): the keyword,
 * its optional `(…)` condition, its `{ }` body (CODE mode), and any TAIL clauses
 * (`else`/`else if` for `if`, `catch`/`finally` for `try`, `while (…)` for `do`).
 * Returns the index just past the chain. Anything malformed/incomplete degrades
 * to blanking the current line only (never swallows the rest of the file).
 */
function processStatementChain(
  src: string,
  chars: string[],
  mask: Uint8Array,
  at: number,
  to: number,
  word: string
): number {
  // `@keyword` itself.
  let i = at + 1 + word.length;
  blank(chars, mask, at, i);

  const blankLineFrom = (p: number): number => {
    const stop = lineEndFrom(chars, p, to);
    blank(chars, mask, p, stop);
    return stop;
  };

  /**
   * One `cond? { body }` unit: optional balanced `(…)`, then the `{ }` body in
   * CODE mode. Returns the index past the body, or -1 when the shape doesn't
   * match (caller falls back to line-blanking).
   */
  const consumeUnit = (p: number, needsParens: boolean): number => {
    let q = skipWs(chars, p, to);
    blank(chars, mask, p, q);
    if (needsParens) {
      if (chars[q] !== "(") return -1;
      const lineEnd = lineEndFrom(chars, q, to);
      const end = scanBalancedEnd(chars, q, to);
      if (end > lineEnd && end >= to) {
        // Unclosed condition (still typing) — clamp to the line.
        return -1;
      }
      blank(chars, mask, q, end);
      const w = skipWs(chars, end, to);
      blank(chars, mask, end, w);
      q = w;
    }
    if (chars[q] !== "{") return -1;
    return processCodeBlock(src, chars, mask, q, to, q);
  };

  const needsParens = word !== "try" && word !== "do";
  let end = consumeUnit(i, needsParens);
  if (end < 0) return blankLineFrom(i);
  i = end;

  // TAIL clauses. Peek (without blanking) so trailing markup stays HTML when no
  // tail follows.
  for (;;) {
    const w = skipWs(chars, i, to);
    const tail = readWord(chars, w, to);
    if ((word === "if" || word === "else") && tail === "else") {
      blank(chars, mask, i, w + 4); // whitespace + `else`
      let p = skipWs(chars, w + 4, to);
      blank(chars, mask, w + 4, p);
      const isElseIf = readWord(chars, p, to) === "if";
      if (isElseIf) {
        blank(chars, mask, p, p + 2);
        p += 2;
      }
      end = consumeUnit(p, isElseIf);
      if (end < 0) return blankLineFrom(p);
      i = end;
      continue;
    }
    if (word === "try" && (tail === "catch" || tail === "finally")) {
      blank(chars, mask, i, w + tail.length);
      let p = w + tail.length;
      if (tail === "catch") {
        // Optional `(Exception e)` and optional `when (…)`.
        let q = skipWs(chars, p, to);
        blank(chars, mask, p, q);
        if (chars[q] === "(") {
          const e2 = scanBalancedEnd(chars, q, to);
          blank(chars, mask, q, e2);
          q = e2;
        }
        const q2 = skipWs(chars, q, to);
        if (readWord(chars, q2, to) === "when") {
          blank(chars, mask, q, q2 + 4);
          let q3 = skipWs(chars, q2 + 4, to);
          blank(chars, mask, q2 + 4, q3);
          if (chars[q3] === "(") {
            const e3 = scanBalancedEnd(chars, q3, to);
            blank(chars, mask, q3, e3);
            q3 = e3;
          }
          q = q3;
        }
        p = q;
      }
      end = consumeUnit(p, false);
      if (end < 0) return blankLineFrom(p);
      i = end;
      continue;
    }
    if (word === "do" && tail === "while") {
      blank(chars, mask, i, w + 5);
      let p = skipWs(chars, w + 5, to);
      blank(chars, mask, w + 5, p);
      if (chars[p] === "(") {
        const e2 = scanBalancedEnd(chars, p, to);
        blank(chars, mask, p, e2);
        p = e2;
      }
      const semi = skipInlineWs(chars, p, to);
      if (chars[semi] === ";") {
        blank(chars, mask, p, semi + 1);
        p = semi + 1;
      }
      return p;
    }
    return i;
  }
}

/**
 * CODE mode: process a balanced `{ … }` C# block whose opening brace sits at
 * `open`. Blanks the C# (quote/comment-aware) but RE-ENTERS MARKUP mode for:
 *   - an element at statement start (`<p>…</p>`, `<partial />`, …) — its whole
 *     extent (nested tags included) is processed as markup recursively;
 *   - an `@:` line (rest of the line is markup).
 * `blankLead` is where blanking starts (the `@` of `@{`, or the `{` itself for
 * statement bodies). Returns the index just past the matching `}`.
 */
function processCodeBlock(
  src: string,
  chars: string[],
  mask: Uint8Array,
  open: number,
  to: number,
  blankLead: number
): number {
  blank(chars, mask, blankLead, open + 1); // `@{` / `{`
  let i = open + 1;
  let atStmtStart = true;

  while (i < to) {
    const c = chars[i];

    if (c === "}") {
      blank(chars, mask, i, i + 1);
      return i + 1;
    }

    // Markup re-entry: an element or `@:` at statement start is Razor's switch
    // back to markup. (The old behavior blanked the whole block, so the HTML
    // inside `@if (x) { <p>…</p> }` disappeared from the HTML view entirely.)
    if (atStmtStart && c === "<" && /[A-Za-z!/]/.test(chars[i + 1] ?? "")) {
      const end = markupExtentEnd(src, chars, i, to);
      processMarkup(src, chars, mask, i, end);
      i = end;
      atStmtStart = true;
      continue;
    }
    if (c === "@" && chars[i + 1] === ":") {
      blank(chars, mask, i, i + 2);
      const stop = lineEndFrom(chars, i + 2, to);
      processMarkup(src, chars, mask, i + 2, stop);
      i = stop;
      atStmtStart = true;
      continue;
    }
    // Nested keyword statements inside code (`if`, `foreach`, …) come WITHOUT an
    // `@` prefix here; their braces are handled by the depth logic below and
    // markup inside them still re-enters via statement-start detection.

    // Strings / comments: skip + blank wholesale so their braces don't count.
    if (c === '"' || c === "'" || (c === "/" && (chars[i + 1] === "/" || chars[i + 1] === "*"))) {
      // Reuse the balanced scanner's skipping by delegating to a tiny scan: treat
      // the construct as if it opened a zero-depth region.
      const end = skipCsLexeme(chars, i, to);
      blank(chars, mask, i, end);
      atStmtStart = false;
      i = end;
      continue;
    }

    if (c === "{") {
      // Nested block — recurse (markup re-entry keeps working inside).
      i = processCodeBlock(src, chars, mask, i, to, i);
      atStmtStart = true;
      continue;
    }

    // Plain C# char: blank it. Track statement starts (`;`, newline, block ends
    // handled above) so `<` mid-expression (e.g. `a < b`, generics) is NOT
    // mistaken for markup.
    blank(chars, mask, i, i + 1);
    if (c === ";" || c === "\n") atStmtStart = true;
    else if (!/\s/.test(c)) atStmtStart = false;
    i++;
    continue;
  }
  return to; // unclosed block (still typing) — everything consumed
}

/** Skip one C# string/char literal or comment starting at `at`; returns its end. */
function skipCsLexeme(chars: string[], at: number, to: number): number {
  const c = chars[at];
  if (c === "/" && chars[at + 1] === "/") {
    let j = at;
    while (j < to && chars[j] !== "\n") j++;
    return j;
  }
  if (c === "/" && chars[at + 1] === "*") {
    let j = at + 2;
    while (j < to && !(chars[j] === "*" && chars[j + 1] === "/")) j++;
    return Math.min(j + 2, to);
  }
  const verbatim =
    c === '"' &&
    (chars[at - 1] === "@" ||
      (chars[at - 1] === "$" && chars[at - 2] === "@") ||
      (chars[at - 1] === "@" && chars[at - 2] === "$"));
  const quote = c;
  let j = at + 1;
  while (j < to) {
    if (verbatim) {
      if (chars[j] === '"') {
        if (chars[j + 1] === '"') { j += 2; continue; }
        return j + 1;
      }
      j++;
    } else {
      if (chars[j] === "\\") { j += 2; continue; }
      if (chars[j] === quote) return j + 1;
      j++;
    }
  }
  return to;
}

/**
 * The extent of a markup ELEMENT run beginning at `<` inside a code block: from
 * the opening tag through the close of its top-level element (nested tags,
 * quoted attributes and `@`-constructs accounted for). A self-closing/void
 * top-level tag ends its own extent. Unclosed markup (still typing) runs to `to`.
 */
function markupExtentEnd(src: string, chars: string[], from: number, to: number): number {
  const stack: string[] = [];
  let i = from;

  while (i < to) {
    const c = chars[i];

    if (c === "@") {
      const next = chars[i + 1];
      if (next === "{" || next === "(") {
        i = scanBalancedEnd(chars, i + 1, to);
        continue;
      }
      if (next === "*") {
        const end = src.indexOf("*@", i + 2);
        i = end < 0 || end + 2 > to ? to : end + 2;
        continue;
      }
      i = next === "@" ? i + 2 : implicitRunEnd(chars, i, to);
      continue;
    }

    if (c !== "<") {
      i++;
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 || end + 3 > to ? to : end + 3;
      continue;
    }
    if (chars[i + 1] === "!") {
      const end = src.indexOf(">", i);
      i = end < 0 || end + 1 > to ? to : end + 1;
      continue;
    }

    const closing = chars[i + 1] === "/";
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < to && isNameChar(chars[j])) j++;
    const name = chars.slice(nameStart, j).join("").toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    // To the tag's `>` — quote-aware; `@(...)` inside attribute values is skipped
    // balanced so its inner quotes don't derail the attribute walk.
    let selfClose = false;
    let quote = "";
    while (j < to) {
      const ch = chars[j];
      if (quote) {
        if (ch === "@" && (chars[j + 1] === "(" || chars[j + 1] === "{")) {
          j = scanBalancedEnd(chars, j + 1, to);
          continue;
        }
        if (ch === quote) quote = "";
        j++;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        j++;
      } else if (ch === "/" && chars[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      } else if (ch === ">") {
        j++;
        break;
      } else {
        j++;
      }
    }

    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.length = idx; // pop through optional-close tags
      if (stack.length === 0) return j; // top-level element closed → extent ends
    } else if (!selfClose && !VOID_ELEMENTS.has(name)) {
      stack.push(name);
    } else if (stack.length === 0) {
      return j; // a lone void/self-closing tag IS the whole extent
    }
    i = j;
  }
  return to;
}

/**
 * Blanks one inline Razor construct starting at `@` (offset `at`) and returns the
 * offset just past it. Handles `@(...)` / `@{...}` (depth-aware) and `@expr` runs
 * with BALANCED `(...)`/`[...]` segments (same as the main implicit-expression
 * scan — a lambda inside an attribute, `class="@x.First(y => y.Z)"`, must not
 * leak its tail). Used inside attribute scanning. The email/literal exception
 * applies here too (`href="mailto:a@b.com"` keeps the domain as HTML).
 */
function blankInlineRazor(
  src: string,
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
  const prevRaw = at > 0 ? src[at - 1] : undefined;
  if (prevRaw !== undefined && /[A-Za-z0-9_]/.test(prevRaw)) {
    return at + 1; // literal `@` (email form) — real HTML text
  }
  if (next === "(" || next === "{") {
    // Quote-aware (shared with the main loop) so `@(")")` inside an attribute value
    // doesn't terminate at the `)` embedded in the C# string.
    const j = scanBalancedEnd(chars, at + 1, n);
    blank(chars, mask, at, j);
    return j;
  }
  // `@expr` — identifier run with balanced call/index segments; stops at quotes,
  // `>`/`<`, or whitespace outside a bracket segment.
  let j = at + 1;
  while (j < n) {
    const ch = chars[j];
    if (/[A-Za-z0-9_.]/.test(ch)) { j++; continue; }
    if (ch === "(" || ch === "[") {
      const lineEnd = lineEndFrom(chars, j, n);
      const end = scanBalancedEnd(chars, j, n);
      j = end <= lineEnd ? end : lineEnd;
      if (j >= lineEnd) break;
      continue;
    }
    break;
  }
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
