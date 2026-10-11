/**
 * Tema de ícones de PRODUTO (`contributes.productIconThemes`) → CSS que troca
 * os glifos dos codicons (`.codicon-<id>::before`) — os da UI do app e os do
 * Monaco. Puro e com tudo validado: id de ícone só `[a-z0-9-]`, glifo = um code
 * point (vira escape `\XXXX`), família/URL gerados pelo app (nunca texto da
 * extensão cru no CSS).
 */
import { decodeFontCharacter } from "../icon-theme/engine.ts";

export interface ProductIconFont {
  id: string;
  src: { path: string; format?: string }[];
  weight?: string;
  style?: string;
}

export interface ProductIconDocument {
  fonts: ProductIconFont[];
  iconDefinitions: Record<string, { fontCharacter: string; fontId?: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function normalizeProductIconTheme(raw: unknown): ProductIconDocument {
  if (!isObj(raw)) throw new Error("tema de ícones de produto não é um objeto JSON");
  const fonts: ProductIconFont[] = [];
  if (Array.isArray(raw.fonts)) {
    for (const f of raw.fonts) {
      if (!isObj(f) || typeof f.id !== "string" || !Array.isArray(f.src)) continue;
      const src = f.src.filter((x): x is { path: string; format?: string } => isObj(x) && typeof x.path === "string");
      if (src.length) fonts.push({ id: f.id, src, weight: typeof f.weight === "string" ? f.weight : undefined, style: typeof f.style === "string" ? f.style : undefined });
    }
  }
  const iconDefinitions: ProductIconDocument["iconDefinitions"] = {};
  if (isObj(raw.iconDefinitions)) {
    for (const [k, v] of Object.entries(raw.iconDefinitions)) {
      if (!/^[a-z0-9-]{1,64}$/.test(k) || !isObj(v) || typeof v.fontCharacter !== "string") continue;
      iconDefinitions[k] = { fontCharacter: v.fontCharacter, fontId: typeof v.fontId === "string" ? v.fontId : undefined };
    }
  }
  return { fonts, iconDefinitions };
}

/** `` → `\e001` (escape CSS de um code point). */
function cssEscapeChar(ch: string): string {
  return `\\${ch.codePointAt(0)!.toString(16)}`;
}

/**
 * Gera o CSS. `fontUrl(path)` devolve a URL segura do arquivo da fonte (ou
 * null para recusar); `familyPrefix` isola as famílias deste tema.
 */
export function productIconCss(doc: ProductIconDocument, fontUrl: (path: string) => string | null, familyPrefix: string): { css: string; icons: number } {
  const families = new Map<string, string>();
  const parts: string[] = [];
  doc.fonts.forEach((f, i) => {
    const srcs = f.src
      .map((s) => {
        if (!/\.(woff2?|ttf|otf)$/i.test(s.path)) return null;
        const url = fontUrl(s.path);
        const format = (s.format ?? "").replace(/[^a-z0-9-]/gi, "");
        return url ? `url("${url.replace(/["\\\n]/g, "")}")${format ? ` format("${format}")` : ""}` : null;
      })
      .filter(Boolean);
    if (!srcs.length) return;
    const family = `${familyPrefix}-${i}`;
    families.set(f.id, family);
    const weight = /^(normal|bold|\d{3})$/.test(f.weight ?? "") ? f.weight : "normal";
    const style = /^(normal|italic|oblique)$/.test(f.style ?? "") ? f.style : "normal";
    parts.push(`@font-face{font-family:"${family}";src:${srcs.join(",")};font-weight:${weight};font-style:${style};font-display:block}`);
  });
  const first = families.values().next().value as string | undefined;
  let icons = 0;
  for (const [id, def] of Object.entries(doc.iconDefinitions)) {
    const family = (def.fontId ? families.get(def.fontId) : undefined) ?? first;
    const ch = decodeFontCharacter(def.fontCharacter);
    if (!family || !ch) continue;
    parts.push(`.codicon.codicon-${id}::before,.codicon-${id}::before{font-family:"${family}"!important;content:"${cssEscapeChar(ch)}"!important}`);
    icons++;
  }
  return { css: parts.join("\n"), icons };
}
