/**
 * Tema de cor resolvido → tema standalone do Monaco (`defineTheme`).
 *
 * O editor usa o caminho STANDALONE de temas (ver `src/lsp/vscodeServices.ts`
 * e ADR 0003: o theme-service-override do @codingame derrubaria o
 * `fluent-acrylic-dark`). Então as cores TextMate viram regras de token:
 *
 * 1. Tokens Monarch (`keyword`, `string`, `type`…) → escopo TextMate
 *    representativo, resolvido com o algoritmo de seleção (`tmScopes.ts`).
 * 2. Categorias semânticas (Roslyn: `class`, `struct`, `controlKeyword`…) →
 *    `semanticTokenColors` do tema ou o escopo TextMate padrão do VS Code.
 *    As categorias OBRIGATÓRIAS de docs/context/editor.md sempre têm regra.
 * 3. Gramáticas TextMate de extensões emitem `tm.<cor>[.<estilo>]`
 *    (`grammarTokens.ts`); aqui nasce uma regra por cor × estilo.
 *
 * Puro (testado em themes.test.ts).
 */
import type { ResolvedColorTheme, SemanticStyle, UiTheme } from "./colorThemeModel.ts";
import { compileTokenColors, fontStyleFromKey, fontStyleKey, matchScopes, normalizeFontStyle, type CompiledRule, type ScopeStyle } from "./tmScopes.ts";

export interface MonacoThemeRule {
  token: string;
  foreground?: string;
  background?: string;
  fontStyle?: string;
}

export interface MonacoThemeData {
  base: "vs" | "vs-dark" | "hc-black" | "hc-light";
  inherit: boolean;
  rules: MonacoThemeRule[];
  colors: Record<string, string>;
}

/** Token Monarch → escopo TextMate que o representa. */
export const MONARCH_SCOPES: Record<string, string> = {
  comment: "comment",
  "comment.doc": "comment.block.documentation",
  string: "string.quoted",
  "string.escape": "constant.character.escape",
  "string.invalid": "invalid",
  "string.quote": "string.quoted",
  "string.regexp": "string.regexp",
  "string.key.json": "support.type.property-name.json",
  "string.value.json": "string.quoted.double.json",
  "string.yaml": "string.unquoted.plain.out.yaml",
  regexp: "string.regexp",
  "regexp.escape": "constant.character.escape",
  number: "constant.numeric",
  "number.float": "constant.numeric",
  "number.hex": "constant.numeric",
  keyword: "keyword",
  "keyword.flow": "keyword.control",
  "keyword.control": "keyword.control",
  "keyword.json": "constant.language.json",
  "keyword.operator": "keyword.operator",
  type: "entity.name.type",
  "type.identifier": "entity.name.type",
  "type.yaml": "entity.name.tag.yaml",
  delimiter: "punctuation",
  "delimiter.html": "punctuation.definition.tag",
  "delimiter.xml": "punctuation.definition.tag",
  operator: "keyword.operator",
  operators: "keyword.operator",
  tag: "entity.name.tag",
  "tag.id": "entity.other.attribute-name.id",
  "tag.class": "entity.other.attribute-name.class",
  "attribute.name": "entity.other.attribute-name",
  "attribute.value": "string.quoted",
  "attribute.value.number": "constant.numeric",
  "attribute.value.unit": "keyword.other.unit",
  metatag: "meta.tag",
  "metatag.content": "meta.tag",
  annotation: "meta.decorator",
  predefined: "support.function",
  constant: "constant.language",
  variable: "variable",
  "variable.predefined": "variable.language",
  "variable.parameter": "variable.parameter",
  namespace: "entity.name.namespace",
  key: "support.type.property-name",
  invalid: "invalid",
  emphasis: "markup.italic",
  strong: "markup.bold",
  header: "markup.heading",
  "keyword.md": "markup.heading",
};

/**
 * Categorias semânticas (LSP/Roslyn e as do Shiki do Razor) → escopo TextMate
 * padrão (tabela do VS Code + `semanticTokenScopes` da extensão C#).
 */
export const SEMANTIC_SCOPES: Record<string, string> = {
  controlKeyword: "keyword.control",
  keyword: "keyword",
  modifier: "storage.modifier",
  namespace: "entity.name.namespace",
  type: "entity.name.type",
  class: "entity.name.type.class",
  recordClass: "entity.name.type.class",
  struct: "entity.name.type.struct",
  recordStruct: "entity.name.type.struct",
  interface: "entity.name.type.interface",
  enum: "entity.name.type.enum",
  delegate: "entity.name.type.delegate",
  typeParameter: "entity.name.type.parameter",
  enumMember: "variable.other.enummember",
  constant: "variable.other.constant",
  parameter: "variable.parameter",
  variable: "variable.other.readwrite",
  property: "variable.other.property",
  field: "variable.other.field",
  event: "variable.other.event",
  method: "entity.name.function.member",
  member: "entity.name.function.member",
  extensionMethod: "entity.name.function.member",
  function: "entity.name.function",
  stringEscapeCharacter: "constant.character.escape",
  stringVerbatim: "string.quoted",
  "class name": "entity.name.type.class",
  "struct name": "entity.name.type.struct",
  "interface name": "entity.name.type.interface",
  "enum name": "entity.name.type.enum",
  "type parameter name": "entity.name.type.parameter",
};

/** Categorias que docs/context/editor.md exige com regra própria. */
export const REQUIRED_SEMANTIC = ["class", "struct", "enum", "interface", "controlKeyword", "keyword", "modifier", "method", "extensionMethod"] as const;

/** Escopos de reserva quando o tema não colore o escopo exato (VS Code faz o mesmo). */
const FALLBACK_SCOPES: Record<string, string[]> = {
  "entity.name.type.struct": ["entity.name.type", "support.type", "storage.type"],
  "entity.name.type.class": ["entity.name.type", "support.class"],
  "entity.name.type.interface": ["entity.name.type", "support.type"],
  "entity.name.type.enum": ["entity.name.type", "support.type"],
  "entity.name.type.delegate": ["entity.name.type"],
  "entity.name.type.parameter": ["entity.name.type"],
  "entity.name.function.member": ["entity.name.function", "support.function"],
  "storage.modifier": ["storage", "keyword"],
  "keyword.control": ["keyword"],
  "variable.other.enummember": ["variable.other.constant", "constant"],
  "variable.other.field": ["variable.other.property", "variable"],
  "variable.other.event": ["variable.other.property", "variable"],
};

export function monacoBase(ui: UiTheme): MonacoThemeData["base"] {
  return ui === "vs" ? "vs" : ui === "hc-black" ? "hc-black" : ui === "hc-light" ? "hc-light" : "vs-dark";
}

const bare = (hex: string) => hex.replace("#", "");

function styleFor(rules: CompiledRule[], scope: string): ScopeStyle {
  let s = matchScopes(rules, ["source", scope]);
  if (s.foreground === undefined) {
    for (const fb of FALLBACK_SCOPES[scope] ?? []) {
      const f = matchScopes(rules, ["source", fb]);
      if (f.foreground !== undefined) {
        s = { foreground: f.foreground, fontStyle: s.fontStyle ?? f.fontStyle };
        break;
      }
    }
  }
  return s;
}

function semanticOverride(sem: Record<string, SemanticStyle>, category: string): ScopeStyle | null {
  const v = sem[category];
  if (!v) return null;
  let fontStyle = v.fontStyle !== undefined ? normalizeFontStyle(v.fontStyle) : undefined;
  if (fontStyle === undefined && (v.bold !== undefined || v.italic !== undefined || v.underline !== undefined))
    fontStyle = [v.bold ? "bold" : "", v.italic ? "italic" : "", v.underline ? "underline" : ""].filter(Boolean).join(" ");
  return { foreground: v.foreground, fontStyle };
}

function toRule(token: string, s: ScopeStyle): MonacoThemeRule | null {
  if (s.foreground === undefined && s.fontStyle === undefined) return null;
  const r: MonacoThemeRule = { token };
  if (s.foreground) r.foreground = bare(s.foreground);
  if (s.fontStyle !== undefined) r.fontStyle = s.fontStyle;
  return r;
}

/** Cor padrão do texto (editor.foreground ou o "default" do tokenColors). */
export function defaultForeground(theme: ResolvedColorTheme, rules = compileTokenColors(theme.tokenColors)): string {
  return theme.colors["editor.foreground"] ?? matchScopes(rules, []).foreground ?? (theme.uiTheme === "vs" || theme.uiTheme === "hc-light" ? "#000000" : "#d4d4d4");
}

/** Todas as cores × estilos que o tema pode produzir (para os tokens `tm.*`). */
export function grammarStyleRules(theme: ResolvedColorTheme, rules = compileTokenColors(theme.tokenColors)): MonacoThemeRule[] {
  const fgs = new Set<string>([defaultForeground(theme, rules).toLowerCase()]);
  const styles = new Set<string>([""]);
  for (const r of rules) {
    if (r.foreground) fgs.add(r.foreground.toLowerCase());
    if (r.fontStyle !== undefined) styles.add(fontStyleKey(r.fontStyle));
  }
  const out: MonacoThemeRule[] = [];
  for (const fg of fgs) {
    for (const key of styles) {
      out.push(key ? { token: `tm.${bare(fg)}.${key}`, foreground: bare(fg), fontStyle: fontStyleFromKey(key) } : { token: `tm.${bare(fg)}`, foreground: bare(fg), fontStyle: "" });
    }
  }
  return out;
}

export interface BuildOptions {
  /** Regras fixas que substituem as derivadas (o Fluent Dark usa as suas). */
  overrideRules?: MonacoThemeRule[];
  /** Cores do Monaco que completam as do tema (as do tema vencem). */
  colorDefaults?: Record<string, string>;
  /**
   * `false` = não derivar regras Monarch/semânticas do `tokenColors` (temas
   * embutidos, que já trazem as suas em `overrideRules` sobre a base do Monaco).
   */
  deriveTokenRules?: boolean;
}

export function buildMonacoTheme(theme: ResolvedColorTheme, opts: BuildOptions = {}): MonacoThemeData {
  const compiled = compileTokenColors(theme.tokenColors);
  const fg = defaultForeground(theme, compiled);
  const rules: MonacoThemeRule[] = [{ token: "", foreground: bare(fg), ...(theme.colors["editor.background"] ? { background: bare(theme.colors["editor.background"]) } : {}) }];
  if (opts.deriveTokenRules !== false) {
    for (const [token, scope] of Object.entries(MONARCH_SCOPES)) {
      const r = toRule(token, styleFor(compiled, scope));
      if (r) rules.push(r);
    }
    for (const [category, scope] of Object.entries(SEMANTIC_SCOPES)) {
      const style = semanticOverride(theme.semanticTokenColors, category.split(" ")[0]) ?? styleFor(compiled, scope);
      const r = toRule(category, style) ?? (REQUIRED_SEMANTIC.includes(category as (typeof REQUIRED_SEMANTIC)[number]) ? { token: category, foreground: bare(fg) } : null);
      if (r) rules.push(r);
    }
  }
  rules.push(...grammarStyleRules(theme, compiled));
  if (opts.overrideRules) {
    const fixed = new Set(opts.overrideRules.map((r) => r.token));
    const kept = rules.filter((r) => !fixed.has(r.token));
    rules.length = 0;
    rules.push(...kept, ...opts.overrideRules);
  }
  return { base: monacoBase(theme.uiTheme), inherit: true, rules, colors: { ...(opts.colorDefaults ?? {}), ...theme.colors } };
}
