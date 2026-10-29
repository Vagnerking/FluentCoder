/**
 * Cores de temas de extensões: só `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`
 * (auditoria §9.4 — nada de `url()`, `var()` ou expressões ao virar CSS).
 * Utilitários de mistura e contraste (WCAG) para os tokens Fluent. Puro.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX.test(v.trim());
}

export function parseColor(v: unknown): Rgba | null {
  if (!isHexColor(v)) return null;
  let h = v.trim().slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** `#rrggbb` ou `#rrggbbaa` (alfa < 1). */
export function toHex(c: Rgba): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return c.a >= 0.999 ? base : `${base}${hex2(c.a * 255)}`;
}

/** Normaliza uma cor de tema (ou `null` se inválida). */
export function normalizeColor(v: unknown): string | null {
  const c = parseColor(v);
  return c ? toHex(c) : null;
}

/** Compõe `top` (com alfa) sobre `bottom` (opaco) → opaco. */
export function flatten(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

/** Mistura `a` e `b` (t = peso de `b`). */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

export function withAlpha(c: Rgba, a: number): Rgba {
  return { ...c, a };
}

/** `rgba(r, g, b, a)` para CSS (aceita a mesma cor que `toHex`). */
export function toCss(c: Rgba): string {
  return c.a >= 0.999 ? toHex(c) : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 1000) / 1000})`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Razão de contraste WCAG entre duas cores opacas. */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(c: Rgba): boolean {
  return luminance(c) < 0.4;
}

/**
 * Garante contraste mínimo de `fg` (já composto) sobre `bg`: aproxima `fg` do
 * branco (fundo escuro) ou do preto (fundo claro) até atingir `min`.
 */
export function ensureContrast(fg: Rgba, bg: Rgba, min: number): Rgba {
  const solidFg = fg.a < 1 ? flatten(fg, bg) : fg;
  if (contrast(solidFg, bg) >= min) return fg;
  const target: Rgba = isDark(bg) ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 };
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(solidFg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}
