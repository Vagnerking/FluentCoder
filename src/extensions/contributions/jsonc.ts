/**
 * JSONC (JSON com comentários e vírgulas finais) — o formato dos temas, temas
 * de ícones, snippets e `language-configuration.json` do VS Code.
 *
 * Contribuição declarativa também é ENTRADA HOSTIL (auditoria §9.4): teto de
 * tamanho e de profundidade antes de qualquer uso. Puro (sem DOM/Tauri).
 */

export interface JsoncLimits {
  /** Teto em caracteres (padrão 4 MiB). */
  maxChars?: number;
  /** Profundidade máxima de objetos/arrays (padrão 64). */
  maxDepth?: number;
}

export class ContributionParseError extends Error {}

/** Remove comentários `//`/`/* *\/` e vírgulas finais, preservando strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  // Posição (em `out`) da última vírgula ainda "pendente" (sem valor depois).
  let pendingComma = -1;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      pendingComma = -1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === ",") {
      pendingComma = out.length;
      out += c;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (pendingComma !== -1) out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      pendingComma = -1;
      out += c;
      i++;
      continue;
    }
    if (!/\s/.test(c)) pendingComma = -1;
    out += c;
    i++;
  }
  return out;
}

function depthOf(v: unknown, limit: number, depth = 0): number {
  if (depth > limit) return depth;
  if (!v || typeof v !== "object") return depth;
  let max = depth;
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
    max = Math.max(max, depthOf(x, limit, depth + 1));
    if (max > limit) break;
  }
  return max;
}

/** `JSON.parse` tolerante a JSONC, com tetos. Lança `ContributionParseError`. */
export function parseJsonc<T = unknown>(text: string, limits: JsoncLimits = {}): T {
  const maxChars = limits.maxChars ?? 4 * 1024 * 1024;
  const maxDepth = limits.maxDepth ?? 64;
  if (text.length > maxChars) throw new ContributionParseError(`arquivo grande demais (${text.length} caracteres)`);
  const clean = stripJsonc(text.replace(/^﻿/, ""));
  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch (err) {
    throw new ContributionParseError(`JSON inválido: ${(err as Error).message}`);
  }
  if (depthOf(value, maxDepth) > maxDepth) throw new ContributionParseError("estrutura aninhada demais");
  return value as T;
}
