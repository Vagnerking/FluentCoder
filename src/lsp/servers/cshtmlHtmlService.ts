/**
 * HTML language-service glue for the `.cshtml` projection (Fase C).
 *
 * Runs Microsoft's `vscode-html-languageservice` IN-PROCESS (the same engine that
 * powers `.html` files and VS Code) against the VIRTUAL HTML view of a `.cshtml`
 * (Razor regions blanked — see `cshtmlHtmlProjection.ts`). Because the virtual
 * view has identity offsets, the service's ranges already line up with the
 * `.cshtml`; we only convert 0-based LSP → 1-based Monaco. No source map.
 *
 * The virtual `TextDocument` + parsed `HTMLDocument` are cached per
 * (model uri, version) so typing doesn't reparse on every keystroke.
 */
import type * as MonacoNs from "monaco-editor";
import {
  getLanguageService,
  newHTMLDataProvider,
  TextDocument,
  type LanguageService,
  type HTMLDocument,
  type CompletionItem as HtmlCompletionItem,
  type Hover as HtmlHover,
  type Range as LspRange,
} from "vscode-html-languageservice";
import { buildVirtualHtml, regionAt, type Region } from "./cshtmlHtmlProjection";
import { parseCshtmlOutline } from "./cshtmlOutline";
import { MVC_TAG_HELPER_DATA } from "./tagHelperData";

let service: LanguageService | null = null;
function svc(): LanguageService {
  if (!service) {
    service = getLanguageService();
    // Tag Helpers embutidos do MVC (asp-*, <partial>, <environment>, …) somados
    // aos dados HTML padrão — completion/hover/validação no caminho region-gated
    // (milestone #7). Custom/view-components ficam para o sidecar (follow-up).
    service.setDataProviders(true, [
      newHTMLDataProvider("aspnetcore-taghelpers", MVC_TAG_HELPER_DATA),
    ]);
  }
  return service;
}

interface Cached {
  version: number;
  doc: TextDocument;
  html: HTMLDocument;
  mask: Uint8Array;
}
const cache = new Map<string, Cached>();

/** The virtual HTML `TextDocument` + parsed tree + region mask, cached by version. */
function virtualFor(model: MonacoNs.editor.ITextModel): Cached {
  const uri = model.uri.toString();
  const version = model.getVersionId();
  const hit = cache.get(uri);
  if (hit && hit.version === version) return hit;
  const { html: text, mask } = buildVirtualHtml(model.getValue());
  const doc = TextDocument.create(uri, "html", version, text);
  const entry: Cached = { version, doc, html: svc().parseHTMLDocument(doc), mask };
  cache.set(uri, entry);
  return entry;
}

/** Drop a model's cached virtual doc (call when the `.cshtml` closes). */
export function forgetHtmlVirtual(uri: string): void {
  cache.delete(uri);
}

/** Drop every cached virtual doc (call on server stop/restart — no leaks). */
export function forgetAllHtmlVirtual(): void {
  cache.clear();
}

/** The region (html|razor) at a Monaco position, via the virtual HTML. */
export function htmlRegionAt(
  model: MonacoNs.editor.ITextModel,
  position: MonacoNs.IPosition
): Region {
  const { mask } = virtualFor(model);
  return regionAt(mask, model.getOffsetAt(position));
}

/** 0-based LSP range → 1-based Monaco range (identity offsets, so just +1). */
function toMonacoRange(r: LspRange): MonacoNs.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

/** Map LSP CompletionItemKind (1..25) → Monaco's enum. */
function completionKind(
  monaco: typeof MonacoNs,
  lsp?: number
): MonacoNs.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  const byLsp: Record<number, MonacoNs.languages.CompletionItemKind> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
    6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
    11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
    16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
    21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
  };
  return (lsp != null && byLsp[lsp]) || K.Property;
}

function docToMarkup(
  doc: HtmlCompletionItem["documentation"]
): string | MonacoNs.IMarkdownString | undefined {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc === "object" && typeof doc.value === "string") {
    return { value: doc.value };
  }
  return undefined;
}

/**
 * Convert one HTML-service completion item to Monaco. HTML items use a `textEdit`
 * with an explicit range and snippet `newText` (insertTextFormat === 2), e.g.
 * `class="$1"` — preserve both so the cursor lands inside the quotes.
 */
function toMonacoCompletion(
  monaco: typeof MonacoNs,
  it: HtmlCompletionItem,
  fallbackRange: MonacoNs.IRange
): MonacoNs.languages.CompletionItem {
  const isSnippet = it.insertTextFormat === 2;
  let range: MonacoNs.IRange = fallbackRange;
  let insertText = it.insertText ?? it.label;
  if (it.textEdit) {
    const te = it.textEdit as { range?: LspRange; newText: string };
    if (te.range) range = toMonacoRange(te.range);
    insertText = te.newText;
  }
  return {
    label: it.label,
    kind: completionKind(monaco, it.kind),
    insertText,
    insertTextRules: isSnippet
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    documentation: docToMarkup(it.documentation),
    detail: typeof it.detail === "string" ? it.detail : undefined,
    sortText: typeof it.sortText === "string" ? it.sortText : undefined,
    filterText: typeof it.filterText === "string" ? it.filterText : undefined,
    command: it.command as MonacoNs.languages.Command | undefined,
    range,
  };
}

/**
 * HTML completions for an HTML-region position in a `.cshtml`. Returns null when
 * the position is NOT in an HTML region (so the caller falls through to the C#
 * projection — they're mutually exclusive, no double suggestions).
 */
export function htmlComplete(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
  position: MonacoNs.IPosition
): MonacoNs.languages.CompletionList | null {
  const { doc, html, mask } = virtualFor(model);
  const offset = model.getOffsetAt(position);
  if (regionAt(mask, offset) !== "html") return null;
  const list = svc().doComplete(
    doc,
    { line: position.lineNumber - 1, character: position.column - 1 },
    html
  );
  const word = model.getWordUntilPosition(position);
  const fallbackRange: MonacoNs.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };
  return {
    suggestions: list.items.map((it) => toMonacoCompletion(monaco, it, fallbackRange)),
    incomplete: list.isIncomplete,
  };
}

/**
 * HTML hover for an HTML-region position. Returns null when the position isn't an
 * HTML region or the service has nothing.
 */
export function htmlHover(
  model: MonacoNs.editor.ITextModel,
  position: MonacoNs.IPosition
): MonacoNs.languages.Hover | null {
  const { doc, html, mask } = virtualFor(model);
  const offset = model.getOffsetAt(position);
  if (regionAt(mask, offset) !== "html") return null;
  const hv: HtmlHover | null = svc().doHover(
    doc,
    { line: position.lineNumber - 1, character: position.column - 1 },
    html
  );
  if (!hv || !hv.contents) return null;
  const contents = hv.contents;
  let value = "";
  if (typeof contents === "string") value = contents;
  else if (Array.isArray(contents))
    value = contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n");
  else if (typeof contents === "object" && "value" in contents) value = contents.value;
  if (!value) return null;
  return {
    contents: [{ value }],
    range: hv.range ? toMonacoRange(hv.range) : undefined,
  };
}

/**
 * Auto-close-tag text when the user just typed `>` or `/`. Returns the snippet to
 * insert (e.g. `$0</div>`) at the position, or null. The caller applies it as an
 * edit. Only fires in HTML regions.
 */
export function htmlTagComplete(
  model: MonacoNs.editor.ITextModel,
  position: MonacoNs.IPosition
): string | null {
  const { doc, html, mask } = virtualFor(model);
  const offset = model.getOffsetAt(position);
  if (regionAt(mask, offset) !== "html") return null;
  return (
    svc().doTagComplete(
      doc,
      { line: position.lineNumber - 1, character: position.column - 1 },
      html // reuse the cached parse (no reparse per keystroke)
    ) ?? null
  );
}

/**
 * Folding ranges for a `.cshtml` (milestone #7): HTML tag folding from the
 * html-service over the virtual view, PLUS Razor block folds (`@{ }`,
 * `@section/@functions/@code { }`, `@* *@`) from the pure outline parser. The
 * virtual view has identity offsets, so the HTML ranges already line up.
 * Returns Monaco `FoldingRange`s (1-based lines).
 */
export function cshtmlFolding(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel
): MonacoNs.languages.FoldingRange[] {
  const { doc } = virtualFor(model);
  const ranges: MonacoNs.languages.FoldingRange[] = [];
  // HTML tags (+ its own comment folding on the blanked view — harmless).
  for (const r of svc().getFoldingRanges(doc)) {
    ranges.push({
      start: r.startLine + 1,
      end: r.endLine + 1,
      kind:
        r.kind === "comment"
          ? monaco.languages.FoldingRangeKind.Comment
          : monaco.languages.FoldingRangeKind.Region,
    });
  }
  // Razor blocks (the html-service can't see through the blanked regions).
  const { folds } = parseCshtmlOutline(model.getValue());
  for (const f of folds) {
    ranges.push({
      start: f.startLine + 1,
      end: f.endLine + 1,
      kind:
        f.kind === "comment"
          ? monaco.languages.FoldingRangeKind.Comment
          : monaco.languages.FoldingRangeKind.Region,
    });
  }
  return ranges;
}

/** LSP `SymbolKind` values for the Razor symbols we surface. */
const SYMBOL_KIND_LSP: Record<string, number> = {
  model: 5 /* Class */,
  page: 8 /* Field */,
  using: 2 /* Module */,
  inject: 8 /* Field */,
  section: 6 /* Method */,
  functions: 6 /* Method */,
  code: 6 /* Method */,
  codeBlock: 12 /* Function */,
};

/**
 * Document symbols for a `.cshtml`: the Razor directives/blocks (`@model`,
 * `@page`, `@section Nome`, `@functions`, `@code`, `@{ }`) parsed from the
 * source. Returns Monaco `DocumentSymbol`s (1-based ranges).
 */
export function cshtmlDocumentSymbols(
  model: MonacoNs.editor.ITextModel
): MonacoNs.languages.DocumentSymbol[] {
  const { symbols } = parseCshtmlOutline(model.getValue());
  return symbols.map((s) => {
    const range: MonacoNs.IRange = {
      startLineNumber: s.line + 1,
      startColumn: s.character + 1,
      endLineNumber: s.endLine + 1,
      endColumn: s.endCharacter + 1,
    };
    return {
      name: s.name,
      detail: "",
      kind: (SYMBOL_KIND_LSP[s.kind] ?? 13) as MonacoNs.languages.SymbolKind,
      tags: [],
      range,
      selectionRange: {
        startLineNumber: s.line + 1,
        startColumn: s.character + 1,
        endLineNumber: s.line + 1,
        endColumn: s.character + 2,
      },
    };
  });
}
