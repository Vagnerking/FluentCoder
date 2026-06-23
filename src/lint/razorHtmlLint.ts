import type * as MonacoNs from "monaco-editor";

/**
 * Live HTML/Razor linter for `.cshtml`/`.razor` (issue #11).
 *
 * `dotnet build` reports C#/Razor *compile* errors, but Razor passes raw HTML
 * through — so a typo'd tag like `</dabbr>` is never a build error. This is the
 * piece that marks markup mistakes **on the sheet, as you type**: it scans the
 * markup (skipping Razor `@…` regions) and flags closing tags with no matching
 * open tag. Deliberately conservative (only clearly-stray closes) to avoid the
 * false positives a strict tag-balance check would hit on HTML's optional-close
 * elements (`<li>`, `<p>`, `<td>`, …).
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

/** Scans `text` and returns stray-close-tag findings as char-offset ranges. */
export function scanRazorMarkup(text: string): RawMarker[] {
  const markers: RawMarker[] = [];
  const stack: string[] = [];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const c = text[i];

    // --- Razor regions: skip so `@expr`/`@{ }` aren't parsed as markup ---
    if (c === "@") {
      const next = text[i + 1];
      if (next === "*") {
        const end = text.indexOf("*@", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (next === "{" || next === "(") {
        const open = next;
        const close = open === "{" ? "}" : ")";
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (text[i] === open) depth++;
          else if (text[i] === close) depth--;
          i++;
        }
        continue;
      }
      // `@Model.Foo`, `@ViewData["x"]`, `@: …` — skip the expression run.
      i++;
      while (i < n && !/[\s<]/.test(text[i])) i++;
      continue;
    }

    if (c === "<") {
      // Comments / doctype / declarations.
      if (text[i + 1] === "!") {
        if (text.startsWith("<!--", i)) {
          const end = text.indexOf("-->", i + 4);
          i = end < 0 ? n : end + 3;
        } else {
          const end = text.indexOf(">", i);
          i = end < 0 ? n : end + 1;
        }
        continue;
      }

      const closing = text[i + 1] === "/";
      let j = i + (closing ? 2 : 1);
      const nameStart = j;
      while (j < n && isNameChar(text[j])) j++;
      const name = text.slice(nameStart, j).toLowerCase();
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
        const ch = text[k];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ">") {
          break;
        } else if (ch === "/" && text[k + 1] === ">") {
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

/**
 * Installs the live linter: lints every `aspnetcorerazor` model on open and on
 * (debounced) edit, applying the findings as Monaco markers owned by `OWNER`.
 * Idempotent at the call site (guarded by setupMonacoForLsp).
 */
export function installRazorHtmlLint(monaco: typeof MonacoNs): void {
  // Both Razor (`.razor` / cohost `.cshtml`) and the projection broker's `cshtml`
  // id (ADR 0002) pass raw HTML through unchecked, so the markup linter must
  // cover both. Which id a given `.cshtml` gets is decided by `languageForFile`.
  const RAZOR_LANGS = new Set(["aspnetcorerazor", "cshtml"]);
  const isRazor = (model: MonacoNs.editor.ITextModel) => RAZOR_LANGS.has(model.getLanguageId());
  const timers = new Map<string, number>();

  const lint = (model: MonacoNs.editor.ITextModel) => {
    if (model.isDisposed() || !isRazor(model)) return;
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      toMarkers(monaco, model, scanRazorMarkup(model.getValue()))
    );
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
    if (!isRazor(model)) return;
    lint(model);
    model.onDidChangeContent(() => schedule(model));
  };

  for (const model of monaco.editor.getModels()) attach(model);
  monaco.editor.onDidCreateModel(attach);
  // A file can switch into the Razor language after creation.
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString();
    const t = timers.get(key);
    if (t) window.clearTimeout(t);
    timers.delete(key);
  });
}
