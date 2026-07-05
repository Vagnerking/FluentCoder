/**
 * Coloração leve do `code` INLINE citado pelo agente (chips como `LogIn`,
 * `DateTime.UtcNow`, `try/catch`, `null`).
 *
 * Fences têm linguagem e usam o Shiki (`codeHighlight.ts`); o inline não tem,
 * então um chip inteiro numa cor só deixava "tudo muito azul". Este módulo
 * tokeniza o trecho e classifica cada token por heurística de forma —
 * palavra-chave conhecida, `Chamada(`, `PascalCase`, `camelCase`, número,
 * string — nas mesmas cores Dark+ do editor. É proposital que seja simples:
 * um palpite de cor errado num chip é inofensivo, e a função é pura/testável.
 */

export type InlineTokenKind =
  | "control"
  | "keyword"
  | "type"
  | "fn"
  | "var"
  | "num"
  | "str"
  | "plain";

export interface InlineToken {
  text: string;
  kind: InlineTokenKind;
}

/** Fluxo de controle — roxo (`C586C0`), como `keyword.if` no tema do editor. */
const CONTROL = new Set([
  "if",
  "else",
  "switch",
  "case",
  "default",
  "for",
  "foreach",
  "while",
  "do",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  "yield",
  "goto",
  "await",
]);

/** Declarações, modificadores e literais — azul (`569CD6`). */
const KEYWORD = new Set([
  "null",
  "true",
  "false",
  "undefined",
  "new",
  "var",
  "let",
  "const",
  "void",
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "readonly",
  "abstract",
  "virtual",
  "override",
  "sealed",
  "partial",
  "class",
  "interface",
  "enum",
  "struct",
  "record",
  "delegate",
  "namespace",
  "using",
  "import",
  "export",
  "from",
  "this",
  "base",
  "super",
  "typeof",
  "nameof",
  "sizeof",
  "is",
  "as",
  "in",
  "out",
  "ref",
  "params",
  "async",
  "function",
  "def",
  "fn",
  "get",
  "set",
  // Tipos primitivos comuns (C#/TS) também são azuis no Dark+.
  "string",
  "int",
  "uint",
  "bool",
  "boolean",
  "double",
  "decimal",
  "float",
  "long",
  "short",
  "byte",
  "char",
  "object",
  "dynamic",
  "number",
  "any",
  "unknown",
  "never",
]);

/**
 * Classifica um identificador pelo contexto: palavra-chave conhecida > chamada
 * (`Nome(`) > `PascalCase` (tipo) > demais (variável/membro).
 */
function classifyIdentifier(
  word: string,
  source: string,
  end: number,
): InlineTokenKind {
  const lower = word.toLowerCase();
  if (CONTROL.has(lower)) return "control";
  if (KEYWORD.has(lower)) return "keyword";
  // Olha o próximo caractere não-espaço: `(` marca chamada de função/método.
  const rest = source.slice(end);
  const next = /^\s*(\S)/.exec(rest)?.[1];
  if (next === "(") return "fn";
  if (/^[A-Z]/.test(word)) return "type";
  return "var";
}

/**
 * Tokeniza um trecho inline em `{texto, tipo}` na ordem original (a
 * concatenação dos textos reproduz o trecho byte a byte).
 */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const re =
    /("[^"]*"?|'[^']*'?)|(\d+(?:\.\d+)*)|([A-Za-z_][A-Za-z0-9_]*)|([^"'0-9A-Za-z_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], kind: "str" });
    } else if (match[2] !== undefined) {
      tokens.push({ text: match[2], kind: "num" });
    } else if (match[3] !== undefined) {
      tokens.push({
        text: match[3],
        kind: classifyIdentifier(match[3], text, re.lastIndex),
      });
    } else {
      tokens.push({ text: match[4], kind: "plain" });
    }
  }
  return tokens;
}
