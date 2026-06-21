/**
 * Monaco registration for the `cshtml` language id (issue #32).
 *
 * `.cshtml` (Razor MVC views) is registered under its own language id so it
 * can evolve independently from `.razor` (Razor components, `aspnetcorerazor`).
 * The tokenizer/config is a copy of the Razor Monarch grammar — same syntax,
 * distinct id — so the CSHTML engine can later replace it without touching the
 * Razor path.
 */
import type { Monaco } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";

/** Monaco language id for `.cshtml` MVC views. */
export const CSHTML_LANGUAGE_ID = "cshtml";

/** Owner string for Monaco markers produced by the CSHTML engine. */
export const CSHTML_MARKER_OWNER = "fluent-cshtml";

let cshtmlRegistered = false;

/** Registers the `cshtml` language with its Monarch tokenizer. Idempotent. */
export function registerCshtmlLanguage(monaco: Monaco): void {
  if (cshtmlRegistered) return;

  const known = monaco.languages
    .getLanguages()
    .some((l) => l.id === CSHTML_LANGUAGE_ID);

  if (!known) {
    monaco.languages.register({
      id: CSHTML_LANGUAGE_ID,
      extensions: [".cshtml"],
      aliases: ["CSHTML", "Razor MVC"],
      mimetypes: ["text/x-cshtml"],
    });
  }

  monaco.languages.setLanguageConfiguration(CSHTML_LANGUAGE_ID, {
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
  });

  monaco.languages.setMonarchTokensProvider(
    CSHTML_LANGUAGE_ID,
    cshtmlMonarch()
  );

  cshtmlRegistered = true;
}

function cshtmlMonarch(): MonacoNS.languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix: ".cshtml",

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
