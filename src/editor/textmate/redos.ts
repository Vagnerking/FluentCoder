/**
 * Guarda contra ReDoS (backtracking catastrófico) nas regex que vêm de
 * extensões — gramáticas TextMate (Oniguruma) e `language-configuration.json`
 * (RegExp do JS). Auditoria 03 §9.4. Três camadas:
 *
 * 1. ESTÁTICA (aqui, puro): teto de tamanho por regex e por gramática, e
 *    recusa dos padrões clássicos de explosão — quantificador sobre grupo cujo
 *    corpo é um único átomo já quantificado (`(a+)+`, `(\w*)*`, `(?:.+){2,}`)
 *    e alternância repetida com ramos iguais (`(a|a)*`).
 * 2. COMPILAÇÃO: cada regex da gramática é compilada no Oniguruma antes de
 *    usar (`grammarService.ts`); a do JS, com `try` — inválida = regra fora.
 * 3. TEMPO: JS → `timedRegex` mede a regex contra entradas adversariais e
 *    descarta a que passar do orçamento; TextMate → `timeLimit` por linha do
 *    vscode-textmate + desligar a gramática que estoura repetidamente
 *    (`grammarService.ts`). O Oniguruma ainda tem o teto interno de retries.
 */

/** Teto de uma regex de gramática (as reais chegam a ~10 KB). */
export const MAX_GRAMMAR_REGEX = 16 * 1024;
/** Teto de regras/padrões percorridos numa gramática. */
export const MAX_GRAMMAR_PATTERNS = 20_000;
/** Teto das regex de `language-configuration.json` (auditoria: 1 KB). */
export const MAX_CONFIG_REGEX = 1024;

/**
 * Quantificador ilimitado aplicado a um grupo cujo corpo é UM átomo já
 * quantificado com `+`/`*`/`{n,}` — a forma de altura de estrela 2 que explode.
 */
const NESTED_QUANTIFIER =
  /\((?:\?(?::|<?[=!]|<[a-zA-Z_]\w*>|[imx-]+:))?(?:\\.|\[(?:\\.|[^\]\\])*\]|\.|[^\\()[\]|])(?:[+*]|\{\d+,\})[?+]?\)(?:[+*]|\{\d+,\})/;

/** Alternância repetida com dois ramos idênticos: `(a|a)*`, `(?:x|x)+`. */
const DUPLICATE_ALTERNATION = /\((?:\?:)?([^()|]+)\|\1\)(?:[+*]|\{\d+,\})/;

/** Motivo da recusa (pt-BR) ou `null` se a regex parece segura. */
export function regexRisk(source: string, maxLength = MAX_GRAMMAR_REGEX): string | null {
  if (source.length > maxLength) return `regex grande demais (${source.length} caracteres)`;
  if (NESTED_QUANTIFIER.test(source)) return "quantificador aninhado (risco de backtracking catastrófico)";
  if (DUPLICATE_ALTERNATION.test(source)) return "alternância repetida com ramos iguais (risco de backtracking catastrófico)";
  return null;
}

export interface GrammarCheck {
  ok: boolean;
  problems: string[];
  /** Todas as regex (para o teste de compilação no Oniguruma). */
  patterns: { where: string; source: string; backrefs: boolean }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const REGEX_KEYS = ["match", "begin", "end", "while", "firstLineMatch", "foldingStartMarker", "foldingStopMarker"] as const;

/** Percorre a gramática (repositório, padrões, capturas, injeções) e valida as regex. */
export function checkGrammar(raw: unknown): GrammarCheck {
  const problems: string[] = [];
  const patterns: GrammarCheck["patterns"] = [];
  if (!isObj(raw) || typeof raw.scopeName !== "string") return { ok: false, problems: ["gramática sem `scopeName`"], patterns };
  let visited = 0;
  const stack: { node: unknown; path: string; depth: number }[] = [{ node: raw, path: raw.scopeName, depth: 0 }];
  while (stack.length) {
    const { node, path, depth } = stack.pop()!;
    if (++visited > MAX_GRAMMAR_PATTERNS) {
      problems.push(`gramática grande demais (> ${MAX_GRAMMAR_PATTERNS} regras)`);
      break;
    }
    if (depth > 64) {
      problems.push("gramática aninhada demais");
      break;
    }
    if (Array.isArray(node)) {
      node.forEach((n, i) => stack.push({ node: n, path: `${path}[${i}]`, depth: depth + 1 }));
      continue;
    }
    if (!isObj(node)) continue;
    for (const k of REGEX_KEYS) {
      const v = node[k];
      if (typeof v !== "string") continue;
      const risk = regexRisk(v);
      if (risk) problems.push(`${path}.${k}: ${risk}`);
      // `end`/`while` podem citar capturas do `begin` (\1): só compilam depois da substituição.
      patterns.push({ where: `${path}.${k}`, source: v, backrefs: (k === "end" || k === "while") && /\\\d|\\k</.test(v) });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "patterns" || k === "repository" || k === "injections" || k === "captures" || k === "beginCaptures" || k === "endCaptures" || k === "whileCaptures") {
        if (isObj(v)) for (const [kk, vv] of Object.entries(v)) stack.push({ node: vv, path: `${path}.${k}.${kk}`, depth: depth + 1 });
        else if (Array.isArray(v)) stack.push({ node: v, path: `${path}.${k}`, depth: depth + 1 });
      }
    }
  }
  return { ok: problems.length === 0, problems, patterns };
}

/** Entradas adversariais para medir uma RegExp do JS. */
const ATTACKS = ["a".repeat(3000) + "!", " ".repeat(3000) + "!", "\t".repeat(1500) + "x" + " ".repeat(1500) + "{", "ab".repeat(1500) + "\u0000", "(".repeat(1000) + "x" + ")".repeat(999)];

export interface TimedRegexResult {
  regex: RegExp | null;
  problem?: string;
}

/**
 * Compila uma regex de `language-configuration.json` com as três travas
 * (tamanho/estrutura, compilação e orçamento de tempo `budgetMs` nas entradas
 * adversariais). `now` injetável para teste.
 */
export function timedRegex(source: unknown, flags = "", budgetMs = 25, now: () => number = () => performance.now()): TimedRegexResult {
  let src: string;
  let fl = flags;
  if (typeof source === "string") src = source;
  else if (isObj(source) && typeof source.pattern === "string") {
    src = source.pattern;
    if (typeof source.flags === "string") fl = source.flags.replace(/[^gimsuy]/g, "");
  } else return { regex: null, problem: "regex ausente" };
  const risk = regexRisk(src, MAX_CONFIG_REGEX);
  if (risk) return { regex: null, problem: risk };
  let re: RegExp;
  try {
    re = new RegExp(src, fl.replace(/g/g, ""));
  } catch (err) {
    return { regex: null, problem: `regex inválida: ${(err as Error).message}` };
  }
  const t0 = now();
  for (const s of ATTACKS) {
    re.test(s);
    if (now() - t0 > budgetMs) return { regex: null, problem: `regex lenta demais (> ${budgetMs} ms nas entradas de teste)` };
  }
  return { regex: new RegExp(src, fl) };
}
