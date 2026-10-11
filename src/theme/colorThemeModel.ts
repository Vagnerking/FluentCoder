/**
 * Modelo de um tema de cor do VS Code (`contributes.themes[].path`) e o
 * carregamento SEM executar nada: JSONC + `include` recursivo (≤ 8, sempre
 * dentro da pasta da extensão), `tokenColors` como array ou caminho de
 * `.tmTheme` (plist) / JSON, `semanticTokenColors`. Puro: a leitura de
 * arquivos é injetada (`readFile`), então roda no `node:test`.
 */
import { parseJsonc, ContributionParseError } from "../extensions/contributions/jsonc.ts";
import { parsePlist } from "../extensions/contributions/plist.ts";
import { resolveFrom } from "../extensions/contributions/paths.ts";
import { normalizeColor } from "./colors.ts";
import type { TokenColorRule } from "./tmScopes.ts";

export type UiTheme = "vs" | "vs-dark" | "hc-black" | "hc-light";
export type ThemeKindName = "light" | "dark" | "high-contrast" | "high-contrast-light";

export interface SemanticStyle {
  foreground?: string;
  fontStyle?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Tema já resolvido (includes aplicados, cores validadas). */
export interface ResolvedColorTheme {
  name: string;
  uiTheme: UiTheme;
  /** `colors` do workbench/editor (só cores hex válidas). */
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
  semanticHighlighting: boolean;
  semanticTokenColors: Record<string, SemanticStyle>;
}

export const MAX_INCLUDE_DEPTH = 8;

export function uiThemeKind(ui: UiTheme): ThemeKindName {
  return ui === "vs" ? "light" : ui === "hc-black" ? "high-contrast" : ui === "hc-light" ? "high-contrast-light" : "dark";
}

export function normalizeUiTheme(v: unknown, fallback: UiTheme = "vs-dark"): UiTheme {
  return v === "vs" || v === "vs-dark" || v === "hc-black" || v === "hc-light" ? v : fallback;
}

/** `type` do JSON do tema (`dark`/`light`/`hc`/`hcLight`) → uiTheme. */
function typeToUi(t: unknown): UiTheme | undefined {
  if (t === "dark") return "vs-dark";
  if (t === "light") return "vs";
  if (t === "hc" || t === "hcDark" || t === "hc-black") return "hc-black";
  if (t === "hcLight" || t === "hc-light") return "hc-light";
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function sanitizeColors(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[\w.-]{1,96}$/.test(k)) continue;
    const c = normalizeColor(v);
    if (c) out[k] = c;
  }
  return out;
}

function sanitizeSemantic(raw: unknown): Record<string, SemanticStyle> {
  const out: Record<string, SemanticStyle> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^[\w.*:-]{1,96}$/.test(k)) continue;
    if (typeof v === "string") {
      const c = normalizeColor(v);
      if (c) out[k] = { foreground: c };
    } else if (isObj(v)) {
      const s: SemanticStyle = {};
      const c = normalizeColor(v.foreground);
      if (c) s.foreground = c;
      if (typeof v.fontStyle === "string") s.fontStyle = v.fontStyle;
      for (const f of ["bold", "italic", "underline"] as const) if (typeof v[f] === "boolean") s[f] = v[f] as boolean;
      if (Object.keys(s).length) out[k] = s;
    }
  }
  return out;
}

function sanitizeTokenColors(raw: unknown): TokenColorRule[] {
  if (!Array.isArray(raw)) return [];
  const out: TokenColorRule[] = [];
  for (const r of raw.slice(0, 5000)) {
    if (!isObj(r) || !isObj(r.settings)) continue;
    const scope = typeof r.scope === "string" || Array.isArray(r.scope) ? (r.scope as string | string[]) : undefined;
    const st = r.settings as Record<string, unknown>;
    out.push({
      scope: Array.isArray(scope) ? scope.filter((s) => typeof s === "string") : scope,
      settings: {
        foreground: typeof st.foreground === "string" ? st.foreground : undefined,
        background: typeof st.background === "string" ? st.background : undefined,
        fontStyle: typeof st.fontStyle === "string" ? st.fontStyle : undefined,
      },
    });
  }
  return out;
}

/** `.tmTheme` (plist) → `tokenColors` + cores globais (`settings` sem escopo). */
export function tmThemeToTokenColors(plist: unknown): { tokenColors: TokenColorRule[]; colors: Record<string, string> } {
  const settings = isObj(plist) && Array.isArray(plist.settings) ? plist.settings : [];
  const tokenColors: TokenColorRule[] = [];
  const colors: Record<string, string> = {};
  for (const s of settings) {
    if (!isObj(s) || !isObj(s.settings)) continue;
    const st = s.settings as Record<string, unknown>;
    if (s.scope === undefined) {
      // Globais do TextMate → cores do editor (o VS Code faz o mesmo).
      const map: Record<string, string> = {
        background: "editor.background",
        foreground: "editor.foreground",
        caret: "editorCursor.foreground",
        selection: "editor.selectionBackground",
        lineHighlight: "editor.lineHighlightBackground",
        invisibles: "editorWhitespace.foreground",
      };
      for (const [k, target] of Object.entries(map)) {
        const c = normalizeColor(st[k]);
        if (c) colors[target] = c;
      }
    }
    tokenColors.push(...sanitizeTokenColors([s]));
  }
  return { tokenColors, colors };
}

export interface LoadContext {
  /** Lê um arquivo (caminho relativo à raiz da extensão, já normalizado). */
  readFile(rel: string): Promise<string>;
}

interface ThemePart {
  name?: string;
  uiTheme?: UiTheme;
  colors: Record<string, string>;
  tokenColors: TokenColorRule[];
  semanticHighlighting?: boolean;
  semanticTokenColors: Record<string, SemanticStyle>;
}

async function loadTokenColorsFile(ctx: LoadContext, rel: string): Promise<{ tokenColors: TokenColorRule[]; colors: Record<string, string> }> {
  const text = await ctx.readFile(rel);
  if (/\.(tmTheme|plist|xml)$/i.test(rel) || text.trimStart().startsWith("<")) return tmThemeToTokenColors(parsePlist(text));
  const json = parseJsonc<unknown>(text);
  if (Array.isArray(json)) return { tokenColors: sanitizeTokenColors(json), colors: {} };
  if (isObj(json) && Array.isArray(json.tokenColors)) return { tokenColors: sanitizeTokenColors(json.tokenColors), colors: {} };
  return { tokenColors: [], colors: {} };
}

async function loadPartial(ctx: LoadContext, rel: string, depth: number, seen: Set<string>): Promise<ThemePart> {
  if (depth > MAX_INCLUDE_DEPTH) throw new ContributionParseError(`\`include\` aninhado demais (> ${MAX_INCLUDE_DEPTH})`);
  if (seen.has(rel)) throw new ContributionParseError(`\`include\` circular: ${rel}`);
  seen.add(rel);
  const text = await ctx.readFile(rel);
  // Tema inteiro em .tmTheme (temas antigos apontam `path` direto para ele).
  if (/\.(tmTheme|plist)$/i.test(rel) || text.trimStart().startsWith("<")) {
    const plist = parsePlist(text);
    const { tokenColors, colors } = tmThemeToTokenColors(plist);
    return { name: isObj(plist) && typeof plist.name === "string" ? plist.name : undefined, colors, tokenColors, semanticTokenColors: {} };
  }
  const json = parseJsonc<Record<string, unknown>>(text);
  if (!isObj(json)) throw new ContributionParseError("tema não é um objeto JSON");
  let base: ThemePart = { colors: {}, tokenColors: [], semanticTokenColors: {} };
  if (typeof json.include === "string") {
    const inc = resolveFrom(rel, json.include);
    if (!inc) throw new ContributionParseError(`\`include\` fora da pasta da extensão: ${json.include}`);
    base = await loadPartial(ctx, inc, depth + 1, seen);
  }
  let tokenColors: TokenColorRule[] = [];
  const extraColors: Record<string, string> = {};
  if (typeof json.tokenColors === "string") {
    const tc = resolveFrom(rel, json.tokenColors);
    if (!tc) throw new ContributionParseError(`\`tokenColors\` fora da pasta da extensão: ${json.tokenColors}`);
    const loaded = await loadTokenColorsFile(ctx, tc);
    tokenColors = loaded.tokenColors;
    Object.assign(extraColors, loaded.colors);
  } else tokenColors = sanitizeTokenColors(json.tokenColors);
  return {
    name: typeof json.name === "string" ? json.name : base.name,
    uiTheme: typeToUi(json.type) ?? base.uiTheme,
    colors: { ...base.colors, ...extraColors, ...sanitizeColors(json.colors) },
    // Incluído primeiro: as regras do arquivo que inclui vencem os empates.
    tokenColors: [...base.tokenColors, ...tokenColors],
    semanticHighlighting: typeof json.semanticHighlighting === "boolean" ? json.semanticHighlighting : base.semanticHighlighting,
    semanticTokenColors: { ...base.semanticTokenColors, ...sanitizeSemantic(json.semanticTokenColors) },
  };
}

/** Carrega e resolve um tema de extensão (`rel` = `themes[].path` normalizado). */
export async function loadColorTheme(ctx: LoadContext, rel: string, opts: { label: string; uiTheme: UiTheme }): Promise<ResolvedColorTheme> {
  const p = await loadPartial(ctx, rel, 0, new Set());
  return {
    name: opts.label || p.name || rel,
    // O `uiTheme` do manifesto é a fonte da verdade (o VS Code faz o mesmo).
    uiTheme: opts.uiTheme ?? p.uiTheme ?? "vs-dark",
    colors: p.colors,
    tokenColors: p.tokenColors,
    semanticHighlighting: p.semanticHighlighting ?? false,
    semanticTokenColors: p.semanticTokenColors,
  };
}
