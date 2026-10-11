/**
 * Seleção de estilo por escopos TextMate (`tokenColors` dos temas VS Code).
 *
 * Um seletor é um caminho separado por espaço (`meta.tag string`): o ÚLTIMO
 * segmento casa (por prefixo de pontos) um escopo da pilha e os anteriores
 * casam escopos ancestrais, em ordem. Entre as regras que casam vence a mais
 * específica — escopo casado mais profundo, depois segmento com mais partes,
 * depois mais ancestrais; empate → a regra declarada por último. Cor e estilo
 * de fonte são resolvidos à parte (uma regra só de `fontStyle` herda a cor da
 * regra menos específica), como no vscode-textmate. Exclusões (`a - b`) são
 * ignoradas (só o lado positivo conta). Puro e testado.
 */
import { normalizeColor } from "./colors.ts";

export interface TokenColorRule {
  name?: string;
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

export interface CompiledRule {
  /** Cada seletor = segmentos (do ancestral ao mais interno). */
  selectors: string[][];
  foreground?: string;
  fontStyle?: string;
  order: number;
}

export interface ScopeStyle {
  foreground?: string;
  /** "" (normal) | combinação de italic/bold/underline/strikethrough. */
  fontStyle?: string;
}

function splitScopes(scope: string | string[] | undefined): string[] {
  if (scope === undefined) return [""];
  const list = Array.isArray(scope) ? scope : scope.split(",");
  return list.map((s) => String(s).split(" - ")[0].trim()).filter((s, _i, a) => s !== "" || a.length === 1);
}

const FONT_STYLES = new Set(["italic", "bold", "underline", "strikethrough"]);

export function normalizeFontStyle(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const parts = v.trim().split(/\s+/).filter((p) => FONT_STYLES.has(p));
  return [...new Set(parts)].sort().join(" ");
}

/** Compila `tokenColors`. Regras sem escopo (o "default") ficam com seletor vazio. */
export function compileTokenColors(rules: readonly TokenColorRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  rules.forEach((r, order) => {
    if (!r || typeof r !== "object" || !r.settings || typeof r.settings !== "object") return;
    const foreground = normalizeColor(r.settings.foreground) ?? undefined;
    const fontStyle = r.settings.fontStyle !== undefined ? normalizeFontStyle(r.settings.fontStyle) : undefined;
    if (foreground === undefined && fontStyle === undefined) return;
    const selectors = splitScopes(r.scope).map((s) => (s ? s.split(/\s+/) : []));
    out.push({ selectors, foreground, fontStyle, order });
  });
  return out;
}

function prefixMatch(selector: string, scope: string): boolean {
  return scope === selector || scope.startsWith(`${selector}.`);
}

/** Pontuação de um seletor contra a pilha (maior = mais específico); -1 = não casa. */
export function selectorScore(segments: readonly string[], stack: readonly string[]): number {
  if (!segments.length) return 0; // regra padrão: casa tudo com a menor prioridade
  const last = segments[segments.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!prefixMatch(last, stack[i])) continue;
    // Ancestrais em ordem, acima de i.
    let j = i - 1;
    let ok = true;
    for (let k = segments.length - 2; k >= 0; k--) {
      while (j >= 0 && !prefixMatch(segments[k], stack[j])) j--;
      if (j < 0) {
        ok = false;
        break;
      }
      j--;
    }
    if (!ok) continue;
    return 1 + i * 10000 + last.split(".").length * 100 + (segments.length - 1);
  }
  return -1;
}

/** Estilo para uma pilha de escopos (do mais externo ao mais interno). */
export function matchScopes(rules: readonly CompiledRule[], stack: readonly string[]): ScopeStyle {
  let fg: { s: number; o: number; v: string } | undefined;
  let fs: { s: number; o: number; v: string } | undefined;
  for (const r of rules) {
    let best = -1;
    for (const sel of r.selectors) best = Math.max(best, selectorScore(sel, stack));
    if (best < 0) continue;
    if (r.foreground !== undefined && (!fg || best > fg.s || (best === fg.s && r.order > fg.o))) fg = { s: best, o: r.order, v: r.foreground };
    if (r.fontStyle !== undefined && (!fs || best > fs.s || (best === fs.s && r.order > fs.o))) fs = { s: best, o: r.order, v: r.fontStyle };
  }
  return { foreground: fg?.v, fontStyle: fs?.v };
}

/**
 * Nome de token Monaco que carrega um estilo resolvido: `tm.<rrggbb[aa]>` +
 * `.i`/`.b`/`.u`/`.s` (itálico/negrito/sublinhado/tachado). O tema Monaco
 * ganha uma regra por combinação usada (ver `monacoTheme.ts`).
 */
export function styleToken(style: ScopeStyle, defaultFg: string): string {
  const fg = (style.foreground ?? defaultFg).replace("#", "").toLowerCase();
  const fsKey = fontStyleKey(style.fontStyle);
  return fsKey ? `tm.${fg}.${fsKey}` : `tm.${fg}`;
}

export function fontStyleKey(fontStyle: string | undefined): string {
  if (!fontStyle) return "";
  const map: Record<string, string> = { italic: "i", bold: "b", underline: "u", strikethrough: "s" };
  return fontStyle
    .split(" ")
    .map((p) => map[p] ?? "")
    .filter(Boolean)
    .sort()
    .join("");
}

/** `ib` → `bold italic` (o `fontStyle` do Monaco). */
export function fontStyleFromKey(key: string): string {
  const map: Record<string, string> = { i: "italic", b: "bold", u: "underline", s: "strikethrough" };
  return [...key].map((k) => map[k]).filter(Boolean).join(" ");
}
