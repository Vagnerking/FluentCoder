import type * as MonacoNs from "monaco-editor";
// `.ts` extension required: this file is loaded by `node --experimental-strip-types`
// (the unit-test harness), which resolves relative imports literally.
import { buildVirtualHtml } from "../lsp/servers/cshtmlHtmlProjection.ts";

/**
 * Live HTML/Razor linter for `.cshtml`/`.razor` (issue #11).
 *
 * `dotnet build` reports C#/Razor *compile* errors, but Razor passes raw HTML
 * through — so a typo'd tag like `</dabbr>` is never a build error. This is the
 * piece that marks markup mistakes **on the sheet, as you type**: it scans the
 * markup and flags closing tags with no matching open tag. Deliberately
 * conservative (only clearly-stray closes) to avoid the false positives a strict
 * tag-balance check would hit on HTML's optional-close elements (`<li>`, `<p>`,
 * `<td>`, …).
 *
 * Razor-region handling is DELEGATED to `buildVirtualHtml` (the virtual-HTML
 * projection): the scan runs over the blanked text, where every `@…` construct,
 * directive line and `@if/@foreach` C# body is already whitespace — offsets are
 * identical by construction. The previous local scanner had drifted from the
 * projection (no keyword blocks, no quote-awareness: a `}` inside a C# string
 * desynced it; `List<string>` in an `@if` body read as an open `<string>` tag).
 */

const OWNER = "razor-html";
const DEBOUNCE_MS = 300;

/** HTML void elements — never pushed onto the open-tag stack. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function isNameChar(ch: string): boolean {
  return /[a-zA-Z0-9-]/.test(ch);
}

export interface RawMarker {
  start: number;
  end: number;
  message: string;
}

/**
 * Finds INCOMPLETE Razor implicit expressions — an `@expr` (e.g. `@Model.`) that
 * ends in a trailing `.` with no member after it. The real Razor compiler drops
 * the dangling dot when it projects to C# (`@Model.` → bare `Model`), so Roslyn
 * never sees an error; this gives the same "Identifier expected" signal VS Code
 * shows. Char-offset range covers the trailing `.`.
 *
 * Scope (conservative, to avoid noise): only implicit `@ident(.ident)*\.` runs.
 * `@( )`/`@{ }` C# blocks are NOT checked here (incomplete C# inside them is the
 * Roslyn projection's job); `@@`, `@*…*@`, and `@:` are skipped.
 */
export function scanIncompleteRazorExpressions(text: string): RawMarker[] {
  const markers: RawMarker[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] !== "@") {
      i++;
      continue;
    }
    const next = text[i + 1];
    // `@@` escape is ALWAYS a literal `@` (checked BEFORE the email/literal
    // heuristic below): in `a@@b.` the text is literally `a@b.`, so the trailing
    // `.` is not a dangling Razor member. Skipping both `@` here also prevents the
    // second `@` from being read as a transition into `b.`.
    if (next === "@") { i += 2; continue; }
    // Razor's email/literal exception: `@` is a transition only when it ISN'T
    // preceded by a non-whitespace text char. `suporte@example.com.` is literal
    // text (the `@` follows `e`), not an expression — don't flag its trailing dot.
    const prev = text[i - 1];
    if (prev !== undefined && /[A-Za-z0-9_]/.test(prev)) {
      i++;
      continue;
    }
    // Skip the constructs that aren't implicit expressions.
    if (next === "*") { const e = text.indexOf("*@", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (next === ":") {
      // `@:` turns the REST OF THE LINE into literal markup — a later `@expr.`
      // on the same line (e.g. `@: @Model.`) is text, not an implicit expression,
      // so consume to end-of-line instead of just the `@:`.
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    } // `@:` line-markup transition
    if (next === "{" || next === "(") {
      // Skip the balanced C# block — Roslyn owns its errors.
      const open = next, close = open === "{" ? "}" : ")";
      let j = i + 2, depth = 1;
      while (j < n && depth > 0) {
        if (text[j] === open) depth++;
        else if (text[j] === close) depth--;
        j++;
      }
      i = j;
      continue;
    }
    // Implicit expression: `@` then an identifier run with `.`/`(`/`[` members.
    // Walk it, remembering the last char, until a char that ends the expression.
    let j = i + 1;
    if (!/[A-Za-z_]/.test(text[j] ?? "")) { i++; continue; } // `@` not starting an ident
    // Consume `ident` then repeated `.ident` / call/index. Stop at the first char
    // that can't continue an implicit expression.
    while (j < n) {
      const ch = text[j];
      if (/[A-Za-z0-9_.]/.test(ch)) { j++; continue; }
      // Razor implicit expressions also allow `(...)` and `[...]` segments; treat a
      // `(`/`[` as continuing only if balanced — but for the trailing-dot check we
      // only care about a run ending in `.`, so stop here.
      break;
    }
    // `j` is just past the implicit run. If the run ends with `.`, it's incomplete.
    if (j > i + 1 && text[j - 1] === ".") {
      markers.push({
        start: j - 1,
        end: j,
        message: "Expressão Razor incompleta: esperado um membro após '.'.",
      });
    }
    i = j;
  }
  return markers;
}

/** Scans `text` and returns stray-close-tag findings as char-offset ranges. */
export function scanRazorMarkup(text: string): RawMarker[] {
  // Single Razor-region oracle: every `@…`/C#-body char is already a space in
  // the virtual HTML, at IDENTICAL offsets — so ranges computed here line up
  // with the original text with no remapping.
  const html = buildVirtualHtml(text).html;
  const markers: RawMarker[] = [];
  const stack: string[] = [];
  const n = html.length;
  let i = 0;

  while (i < n) {
    const c = html[i];

    if (c === "<") {
      // Comments / doctype / declarations.
      if (html[i + 1] === "!") {
        if (html.startsWith("<!--", i)) {
          const end = html.indexOf("-->", i + 4);
          i = end < 0 ? n : end + 3;
        } else {
          const end = html.indexOf(">", i);
          i = end < 0 ? n : end + 1;
        }
        continue;
      }

      const closing = html[i + 1] === "/";
      let j = i + (closing ? 2 : 1);
      const nameStart = j;
      while (j < n && isNameChar(html[j])) j++;
      const name = html.slice(nameStart, j).toLowerCase();
      if (!name) {
        // A literal `<` in text/expression — not a tag.
        i++;
        continue;
      }

      // Find the tag's `>` (tolerating attribute values, but not `>` inside them).
      let k = j;
      let selfClose = false;
      let quote = "";
      while (k < n) {
        const ch = html[k];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ">") {
          break;
        } else if (ch === "/" && html[k + 1] === ">") {
          selfClose = true;
        }
        k++;
      }
      const tagEnd = k; // index of '>' (or n if unterminated)

      if (closing) {
        if (stack.length && stack[stack.length - 1] === name) {
          stack.pop();
        } else {
          const idx = stack.lastIndexOf(name);
          if (idx >= 0) {
            // Lenient: treat intermediate unclosed (optional-close) tags as closed.
            stack.length = idx;
          } else {
            markers.push({
              start: i,
              end: Math.min(tagEnd + 1, n),
              message: `Tag de fechamento </${name}> sem tag de abertura correspondente.`,
            });
          }
        }
      } else if (!selfClose && !VOID.has(name)) {
        stack.push(name);
      }

      i = tagEnd < n ? tagEnd + 1 : n;
      continue;
    }

    i++;
  }

  return markers;
}

function toMarkers(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
  raws: RawMarker[]
): MonacoNs.editor.IMarkerData[] {
  return raws.map((r) => {
    const s = model.getPositionAt(r.start);
    const e = model.getPositionAt(r.end);
    return {
      severity: monaco.MarkerSeverity.Error,
      message: r.message,
      startLineNumber: s.lineNumber,
      startColumn: s.column,
      endLineNumber: e.lineNumber,
      endColumn: e.column,
      source: "razor",
    };
  });
}

const LINTED_LANGUAGES = new Set(["aspnetcorerazor", "cshtml"]);

/**
 * Installs the live linter for `.razor` (`aspnetcorerazor`) and `.cshtml`
 * (`cshtml`) models. Both share the same Razor syntax so the same scan logic
 * applies. Idempotent at the call site (guarded by setupMonacoForLsp).
 */
export function installRazorHtmlLint(monaco: typeof MonacoNs): void {
  const timers = new Map<string, number>();

  const lint = (model: MonacoNs.editor.ITextModel) => {
    if (model.isDisposed() || !LINTED_LANGUAGES.has(model.getLanguageId())) return;
    const text = model.getValue();
    // Markup stray-tag scan + incomplete Razor expression (`@Model.`) scan.
    const raws = [...scanRazorMarkup(text), ...scanIncompleteRazorExpressions(text)];
    monaco.editor.setModelMarkers(model, OWNER, toMarkers(monaco, model, raws));
  };

  const schedule = (model: MonacoNs.editor.ITextModel) => {
    const key = model.uri.toString();
    const prev = timers.get(key);
    if (prev) window.clearTimeout(prev);
    timers.set(
      key,
      window.setTimeout(() => {
        timers.delete(key);
        lint(model);
      }, DEBOUNCE_MS)
    );
  };

  const attach = (model: MonacoNs.editor.ITextModel) => {
    if (!LINTED_LANGUAGES.has(model.getLanguageId())) return;
    lint(model);
    model.onDidChangeContent(() => schedule(model));
  };

  for (const model of monaco.editor.getModels()) attach(model);
  monaco.editor.onDidCreateModel(attach);
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString();
    const t = timers.get(key);
    if (t) window.clearTimeout(t);
    timers.delete(key);
  });
}
