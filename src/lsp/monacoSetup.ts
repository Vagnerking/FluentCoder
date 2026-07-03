/**
 * One-time Monaco setup for LSP-driven TS/JS IntelliSense.
 *
 * ISSUE-33: disable Monaco's BUILT-IN TypeScript/JavaScript worker so the real
 * `typescript-language-server` is the single source of IntelliSense. Without
 * this, the user would see duplicated/conflicting diagnostics and completions.
 *
 * ISSUE-36: register the `typescriptreact` / `javascriptreact` language ids so
 * `.tsx`/`.jsx` files get proper JSX IntelliSense from tsserver.
 *
 * IMPORTANT: must run in `beforeMount` (before any editor/model is created).
 */
import type { Monaco } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";
import { installRazorHtmlLint } from "../lint/razorHtmlLint";
import { installFileTextModelResolver } from "./textModelResolver";
// `monaco-editor`'s ESM API does not automatically bundle every basic-language
// contribution. Register C#'s lazy Monarch loader explicitly; otherwise Roslyn
// semantic tokens color symbols, but lexical-only tokens such as `if` and
// `return` remain plain foreground text.
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";

let didSetup = false;

/** Idempotently configures Monaco for the LSP pipeline. */
export function setupMonacoForLsp(monaco: Monaco): void {
  if (didSetup) return;
  didSetup = true;

  // Must run BEFORE the first editor instantiates the standalone services:
  // resolves file:// models on demand so Ctrl+hover underlines definitions in
  // files that were never opened (see textModelResolver.ts).
  installFileTextModelResolver();

  disableBuiltinTsWorker(monaco);
  registerReactLanguages(monaco);
  registerRazorLanguage(monaco);
  registerCshtmlProjectionLanguage(monaco);
  installRazorHtmlLint(monaco);
  ensureCsharpLanguage(monaco);
  installShikiRazorColorsLazily(monaco);
}

/**
 * Upgrades `.cshtml`/`.razor` coloring from the Monarch grammar to Shiki's real
 * TextMate grammar, loaded lazily on the first Razor model (Shiki pulls a WASM
 * engine; no point loading it for a TS-only session). Idempotent + best-effort —
 * `installShikiRazorColors` keeps the Monarch grammar if Shiki can't load.
 */
function installShikiRazorColorsLazily(monaco: Monaco): void {
  const RAZOR_IDS = new Set([RAZOR_LANGUAGE_ID, CSHTML_LANGUAGE_ID]);
  const isRazor = (m: MonacoNS.editor.ITextModel) => RAZOR_IDS.has(m.getLanguageId());
  const trigger = () => {
    void import("./shikiRazor").then((mod) => mod.installShikiRazorColors());
  };
  if (monaco.editor.getModels().some(isRazor)) {
    trigger();
    return;
  }
  const sub = monaco.editor.onDidCreateModel((model) => {
    if (isRazor(model)) {
      sub.dispose();
      trigger();
    }
  });
}

/**
 * Registers the `cshtml` language id used by the projection broker (ADR 0002).
 * Reuses the Razor Monarch grammar/config so `.cshtml` keeps its syntax colors
 * when the projection flag routes it to id `cshtml` instead of `aspnetcorerazor`.
 *
 * No file-extension claim: the model language is chosen explicitly by
 * `languageForFile`, so we must not let Monaco auto-detection fight over
 * `.cshtml` between this id and `aspnetcorerazor`. Harmless (unused) when the
 * projection flag is OFF. Idempotent.
 */
function registerCshtmlProjectionLanguage(monaco: Monaco): void {
  if (cshtmlRegistered) return;
  const known = monaco.languages.getLanguages().some((l) => l.id === CSHTML_LANGUAGE_ID);
  if (!known) {
    monaco.languages.register({ id: CSHTML_LANGUAGE_ID, aliases: ["CSHTML", "Razor"] });
  }
  monaco.languages.setLanguageConfiguration(CSHTML_LANGUAGE_ID, razorLanguageConfiguration());
  monaco.languages.setMonarchTokensProvider(CSHTML_LANGUAGE_ID, razorMonarch());
  cshtmlRegistered = true;
}

/**
 * Makes sure Monaco knows the `csharp` language id is bound to `.cs`. The
 * C#'s basic-language contribution is imported above so its Monarch tokenizer
 * can be loaded lazily. This fallback registration still protects against a
 * contribution-loading failure: the model remains `csharp`, allowing the LSP
 * document selector to match even if syntax highlighting is unavailable.
 */
function ensureCsharpLanguage(monaco: Monaco): void {
  const has = monaco.languages.getLanguages().some((l) => l.id === "csharp");
  if (!has) {
    monaco.languages.register({
      id: "csharp",
      extensions: [".cs", ".csx", ".cake"],
      aliases: ["C#", "csharp"],
      mimetypes: ["text/x-csharp"],
    });
  }
}

/**
 * Turns OFF the embedded TS/JS worker's diagnostics, suggestions, and
 * completion provider. Syntax highlighting (Monarch tokenizer) stays intact.
 */
function disableBuiltinTsWorker(monaco: Monaco): void {
  const ts = monaco.languages.typescript;
  if (!ts) return; // defensive: TS contribution might be tree-shaken out

  const off = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  };
  ts.typescriptDefaults.setDiagnosticsOptions(off);
  ts.javascriptDefaults.setDiagnosticsOptions(off);

  // Stop the worker from eagerly type-acquiring and from offering completions.
  // `onlyVisible: true` keeps the worker idle for non-visible models.
  ts.typescriptDefaults.setEagerModelSync(false);
  ts.javascriptDefaults.setEagerModelSync(false);

  // Disable the built-in completion/hover/etc. providers: setting the compiler
  // option `noLib` + clearing extra libs is not enough, but Monaco honors the
  // diagnostics flags above for markers. For completions we rely on the LSP
  // provider winning by registration order; additionally we wipe extra libs so
  // the built-in worker has no project knowledge to suggest from.
  ts.typescriptDefaults.setExtraLibs([]);
  ts.javascriptDefaults.setExtraLibs([]);
}

/**
 * Ensures `typescriptreact` and `javascriptreact` exist as Monaco languages,
 * reusing the TS/JS tokenizer/config so highlighting is unchanged. tsserver
 * distinguishes these ids from plain `typescript`/`javascript` for JSX.
 */
function registerReactLanguages(monaco: Monaco): void {
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));

  // The standalone Monaco bundle registers basic languages with a lazy
  // `loader()` that returns the Monarch tokenizer + language config. The public
  // type omits `loader`, so we read it through a narrow cast.
  type LazyLang = {
    id: string;
    loader?: () => Promise<{ language?: unknown; conf?: unknown }>;
  };

  const ensure = (id: string, baseId: string, extensions: string[]) => {
    if (known.has(id)) return;
    monaco.languages.register({ id, extensions, aliases: [id] });
    // Reuse the base language's tokenizer + config so highlighting matches.
    const base = (monaco.languages.getLanguages() as unknown as LazyLang[]).find(
      (l) => l.id === baseId
    );
    void base?.loader?.()
      .then((mod) => {
        if (mod?.language) {
          monaco.languages.setMonarchTokensProvider(
            id,
            mod.language as Parameters<
              typeof monaco.languages.setMonarchTokensProvider
            >[1]
          );
        }
        if (mod?.conf) {
          monaco.languages.setLanguageConfiguration(
            id,
            mod.conf as Parameters<
              typeof monaco.languages.setLanguageConfiguration
            >[1]
          );
        }
      })
      .catch(() => {
        /* highlighting fallback: base tokenizer not loadable — non-fatal */
      });
  };

  ensure("typescriptreact", "typescript", [".tsx"]);
  ensure("javascriptreact", "javascript", [".jsx"]);
}

/** Monaco language id for `.razor` components. Matches `language.ts`.
 * Uses the VS Code id `aspnetcorerazor` so the Roslyn Razor cohost recognizes
 * the documents we open — it keys Razor handling off this exact language id.
 * `.cshtml` uses a separate `cshtml` id (see monacoSetupCshtml.ts). */
export const RAZOR_LANGUAGE_ID = "aspnetcorerazor";

/** Monaco language id for `.cshtml` under the projection broker (ADR 0002). */
export const CSHTML_LANGUAGE_ID = "cshtml";

let razorRegistered = false;
let cshtmlRegistered = false;

/**
 * Registers the `razor` language + Monarch tokenizer (ISSUE-29). Monaco ships no
 * Razor grammar, so `.cshtml`/`.razor` would otherwise fall back to plaintext.
 *
 * Scope: syntax highlight only — Razor transitions/directives, C# code blocks,
 * Razor comments, and basic HTML markup. NOT a full TextMate grammar with
 * embedded-language projection (out of scope per the epic). Idempotent.
 */
export function registerRazorLanguage(monaco: Monaco): void {
  if (razorRegistered) return;

  const known = monaco.languages
    .getLanguages()
    .some((l) => l.id === RAZOR_LANGUAGE_ID);
  if (!known) {
    monaco.languages.register({
      id: RAZOR_LANGUAGE_ID,
      extensions: [".razor"],
      aliases: ["Razor"],
      mimetypes: ["text/x-razor"],
    });
  }

  monaco.languages.setLanguageConfiguration(RAZOR_LANGUAGE_ID, razorLanguageConfiguration());

  monaco.languages.setMonarchTokensProvider(RAZOR_LANGUAGE_ID, razorMonarch());
  razorRegistered = true;
}

/** Bracket/comment/auto-close configuration shared by `aspnetcorerazor` and `cshtml`. */
function razorLanguageConfiguration(): MonacoNS.languages.LanguageConfiguration {
  return {
    comments: { blockComment: ["@*", "*@"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "@*", close: "*@" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "<", close: ">" },
    ],
  };
}

/** Minimal Monarch grammar for Razor (`@`-transitions, C# blocks, HTML). */
function razorMonarch(): MonacoNS.languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix: ".razor",

    razorDirectives: [
      "model", "using", "inject", "page", "namespace", "inherits",
      "implements", "layout", "addTagHelper", "removeTagHelper",
      "tagHelperPrefix", "attribute", "functions", "code", "section",
      "if", "else", "switch", "for", "foreach", "while", "do", "lock",
      "try", "catch", "finally", "await",
    ],

    csharpKeywords: [
      "abstract", "as", "base", "bool", "break", "byte", "case", "catch",
      "char", "checked", "class", "const", "continue", "decimal", "default",
      "delegate", "do", "double", "else", "enum", "event", "explicit",
      "extern", "false", "finally", "fixed", "float", "for", "foreach",
      "goto", "if", "implicit", "in", "int", "interface", "internal", "is",
      "lock", "long", "namespace", "new", "null", "object", "operator",
      "out", "override", "params", "private", "protected", "public",
      "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof",
      "stackalloc", "static", "string", "struct", "switch", "this", "throw",
      "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe",
      "ushort", "using", "var", "virtual", "void", "volatile", "while",
      "async", "await", "dynamic", "nameof", "when", "yield",
    ],

    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4})/,

    tokenizer: {
      root: [
        [/@\*/, { token: "comment.razor", next: "@razorComment" }],
        [/@@/, "string.escape"],
        [/@(?=[a-zA-Z(_{])/, { token: "keyword.razor.transition", next: "@razorAt" }],
        [/<!--/, { token: "comment.html", next: "@htmlComment" }],
        [/<!DOCTYPE/i, { token: "metatag.html", next: "@doctype" }],
        [/<\/?[a-zA-Z][\w:-]*/, { token: "tag.html", next: "@tag" }],
        [/[^<@]+/, ""],
        [/[<@]/, ""],
      ],

      razorAt: [
        [/\{/, { token: "delimiter.curly.razor", next: "@csharpBlock", bracket: "@open" }],
        [/\(/, { token: "delimiter.parenthesis.razor", next: "@csharpParen", bracket: "@open" }],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@razorDirectives": { token: "keyword.razor", next: "@razorDirectiveTail" },
              "@default": { token: "variable.razor", next: "@razorExpression" },
            },
          },
        ],
        [/./, { token: "", next: "@pop" }],
      ],

      razorDirectiveTail: [
        [/@\*/, { token: "comment.razor", next: "@razorComment" }],
        [/\{/, { token: "delimiter.curly.razor", next: "@csharpBlock", bracket: "@open" }],
        [/\(/, { token: "delimiter.parenthesis.razor", next: "@csharpParen", bracket: "@open" }],
        [/[ \t]+/, ""],
        [/[a-zA-Z_]\w*/, { cases: { "@csharpKeywords": "keyword", "@default": "type.identifier" } }],
        [/"([^"\\]|\\.)*"/, "string"],
        [/[;.,]/, "delimiter"],
        [/$/, { token: "", next: "@pop" }],
        [/./, ""],
      ],

      razorExpression: [
        [/[a-zA-Z_]\w*/, "variable.razor"],
        [/\./, "delimiter"],
        [/\(/, { token: "delimiter.parenthesis.razor", next: "@csharpParen", bracket: "@open" }],
        [/\[/, { token: "delimiter.square.razor", next: "@csharpBracket", bracket: "@open" }],
        [/./, { token: "", next: "@pop" }],
        [/$/, { token: "", next: "@pop" }],
      ],

      csharpBlock: [
        [/@\*/, { token: "comment.razor", next: "@razorComment" }],
        [/\}/, { token: "delimiter.curly.razor", next: "@pop", bracket: "@close" }],
        [/\{/, { token: "delimiter.curly", next: "@csharpBlock", bracket: "@open" }],
        { include: "@csharpCommon" },
        [/<\/?[a-zA-Z][\w:-]*/, { token: "tag.html", next: "@tag" }],
      ],

      csharpParen: [
        [/\)/, { token: "delimiter.parenthesis.razor", next: "@pop", bracket: "@close" }],
        [/\(/, { token: "delimiter.parenthesis", next: "@csharpParen", bracket: "@open" }],
        { include: "@csharpCommon" },
      ],

      csharpBracket: [
        [/\]/, { token: "delimiter.square.razor", next: "@pop", bracket: "@close" }],
        [/\[/, { token: "delimiter.square", next: "@csharpBracket", bracket: "@open" }],
        { include: "@csharpCommon" },
      ],

      csharpCommon: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, { token: "comment", next: "@csharpBlockComment" }],
        [/@?"/, { token: "string.quote", next: "@csharpString" }],
        [/'[^'\\]'/, "string"],
        [/'\\.'/, "string"],
        [/\d+(\.\d+)?([eE][-+]?\d+)?[fFdDmM]?/, "number"],
        [/[a-zA-Z_]\w*/, { cases: { "@csharpKeywords": "keyword", "@default": "identifier" } }],
        [/[{}()\[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
        [/[+\-*/%=&|<>!~^?:]+/, "operator"],
        [/[ \t\r\n]+/, ""],
      ],

      csharpString: [
        [/[^"\\]+/, "string"],
        [/@escapes/, "string.escape"],
        [/""/, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],

      csharpBlockComment: [
        [/[^*/]+/, "comment"],
        [/\*\//, { token: "comment", next: "@pop" }],
        [/[*/]/, "comment"],
      ],

      razorComment: [
        [/[^*]+/, "comment.razor"],
        [/\*@/, { token: "comment.razor", next: "@pop" }],
        [/\*/, "comment.razor"],
      ],

      htmlComment: [
        [/[^-]+/, "comment.html"],
        [/--!?>/, { token: "comment.html", next: "@pop" }],
        [/-/, "comment.html"],
      ],

      doctype: [
        [/[^>]+/, "metatag.content.html"],
        [/>/, { token: "metatag.html", next: "@pop" }],
      ],

      tag: [
        [/@\*/, { token: "comment.razor", next: "@razorComment" }],
        [/@(?=[a-zA-Z(_{])/, { token: "keyword.razor.transition", next: "@razorAt" }],
        [/[ \t\r\n]+/, ""],
        [/[a-zA-Z_][\w:-]*/, "attribute.name.html"],
        [/=/, "delimiter"],
        [/"/, { token: "attribute.value.html", next: "@attrDouble" }],
        [/'/, { token: "attribute.value.html", next: "@attrSingle" }],
        [/\/?>/, { token: "tag.html", next: "@pop" }],
        [/./, ""],
      ],

      attrDouble: [
        [/@(?=[a-zA-Z(_{])/, { token: "keyword.razor.transition", next: "@razorAt" }],
        [/[^"@]+/, "attribute.value.html"],
        [/"/, { token: "attribute.value.html", next: "@pop" }],
      ],

      attrSingle: [
        [/@(?=[a-zA-Z(_{])/, { token: "keyword.razor.transition", next: "@razorAt" }],
        [/[^'@]+/, "attribute.value.html"],
        [/'/, { token: "attribute.value.html", next: "@pop" }],
      ],
    },
  };
}
