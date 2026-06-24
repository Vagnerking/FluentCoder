/**
 * Pure TextMate-scope → Monaco-token-type mapping for the Razor (`.cshtml`/
 * `.razor`) Shiki tokenizer (see `shikiRazor.ts`). Kept dependency-free (no
 * `monaco`/`shiki` imports) so the mapping is unit-testable under `node:test`.
 *
 * Each token's scope stack is checked DEEPEST-first; the first prefix that matches
 * wins, so order matters (more-specific rules must precede the generic ones).
 */

/**
 * TextMate scope prefix → Monaco token type. The mapped types match rules the
 * `fluent-acrylic-dark` theme (or its vs-dark base) already colors.
 */
export const SCOPE_TO_TYPE: ReadonlyArray<readonly [string, string]> = [
  ["comment", "comment"],
  ["constant.numeric", "number"],
  ["constant.character", "string"],
  ["constant.language", "keyword"],
  ["constant", "constant"],
  ["string", "string"],
  // C# "expression keywords" (`nameof`, `typeof`, `sizeof`, `default`, `is`, `as`,
  // `await`, `new`, `checked`, `stackalloc`, …) are scoped
  // `keyword.operator.expression.<x>.cs` but VS Code dark+ colors them as KEYWORDS
  // (purple), not operators. Must come BEFORE the generic `keyword.operator` rule.
  ["keyword.operator.expression", "keyword"],
  ["keyword.operator", "operator"],
  // ALL control keywords are purple in VS Code dark+: C# flow (if/return/…) AND
  // the Razor transitions/directives (`@`, `@{`, `@model`, the `}` codeblock
  // close) — all scoped `keyword.control.*`. Mapped to `controlKeyword` (C586C0).
  ["keyword.control", "controlKeyword"],
  ["keyword", "keyword"],
  ["storage.modifier", "modifier"],
  ["storage.type", "keyword"],
  ["entity.name.tag", "tag"],
  ["entity.other.attribute-name", "attribute.name"],
  ["entity.name.type", "type"],
  ["entity.name.function", "function"],
  ["entity.name.namespace", "namespace"],
  // Local/field/range variables (`entity.name.variable.local.cs`, etc.) are the
  // light-blue variable color in VS Code dark+, not the default foreground.
  ["entity.name.variable", "variable"],
  ["support.type", "type"],
  ["support.class", "type"],
  ["support.function", "function"],
  ["variable.parameter", "parameter"],
  ["variable.language", "keyword"],
  ["variable", "variable"],
  ["meta.tag", "tag"],
  ["punctuation.definition.tag", "delimiter.html"],
  ["punctuation.definition.string", "string"],
  ["punctuation", "delimiter"],
];

/** Map a TextMate scope stack to a Monaco token type (deepest scope wins). */
export function mapScopes(scopes: readonly string[]): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    for (const [prefix, type] of SCOPE_TO_TYPE) {
      if (s === prefix || s.startsWith(`${prefix}.`)) return type;
    }
  }
  return "";
}

/**
 * A `.`-chain member (`variable.other...property`) — every segment AFTER the
 * first object in `A.B.C`. The C# grammar scopes the first segment `…object` and
 * each following segment `…object.property`, so this matches the intermediate and
 * tail members but never the leading object or a standalone variable.
 */
export function isMemberProperty(scopes: readonly string[]): boolean {
  const deepest = scopes[scopes.length - 1] ?? "";
  return /^variable\.other\..*property/.test(deepest);
}
