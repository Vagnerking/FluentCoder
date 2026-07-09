/**
 * Estrutura (document symbols) e folding de blocos Razor de um `.cshtml`
 * (milestone #7). Puro (sem monaco/html-service) para testar em `node --test`,
 * no mesmo espírito de `cshtmlHtmlProjection.ts`.
 *
 * Opera DIRETO no `.cshtml` (não no `.g.cs`): os símbolos que o usuário
 * reconhece são as diretivas e blocos Razor (`@model`, `@page`, `@section Nome`,
 * `@functions`/`@code`, `@{ }`), não a classe gerada. O folding de blocos Razor
 * casa `{ … }` balanceado a partir de cada diretiva/transição de bloco; o folding
 * de tags HTML vem do `vscode-html-languageservice` (somado no adapter).
 *
 * Linhas/colunas aqui são 0-based (estilo LSP); o adapter converte para Monaco.
 */

/** Tipo de símbolo, mapeado a um `SymbolKind` LSP no adapter. */
export type CshtmlSymbolKind =
  | "model"
  | "page"
  | "using"
  | "inject"
  | "section"
  | "functions"
  | "code"
  | "codeBlock";

export interface CshtmlSymbol {
  name: string;
  kind: CshtmlSymbolKind;
  /** Linha 0-based onde o símbolo começa. */
  line: number;
  /** Coluna 0-based do início. */
  character: number;
  /** Linha 0-based do fim (para blocos com `{ }`; = line para diretivas). */
  endLine: number;
  endCharacter: number;
}

/** Um intervalo dobrável (0-based, inclusivo no start, a última linha do bloco). */
export interface CshtmlFold {
  startLine: number;
  endLine: number;
  kind: "region" | "comment";
}

interface LineIndex {
  /** Offset (UTF-16) de início de cada linha. */
  starts: number[];
}

function indexLines(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return { starts };
}

function posAt(idx: LineIndex, offset: number): { line: number; character: number } {
  // Busca binária da maior linha cujo start <= offset.
  let lo = 0,
    hi = idx.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - idx.starts[lo] };
}

/** Diretivas de linha única `@word Resto` que viram símbolos (sem bloco). */
const LINE_DIRECTIVE_KINDS: Record<string, CshtmlSymbolKind> = {
  model: "model",
  page: "page",
  using: "using",
  inject: "inject",
};

/**
 * Acha o índice do `}` que fecha o `{` em `open` (offset do `{`), respeitando
 * strings, comentários e aninhamento. Retorna o offset do `}` ou -1.
 */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      // pula string/char (com escape)
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extrai símbolos + folds de blocos Razor de um `.cshtml`. Reconhece:
 *  - `@model X`, `@page`, `@using X`, `@inject T name` (diretivas de linha);
 *  - `@section Nome { … }`, `@functions { … }`, `@code { … }`, `@{ … }`
 *    (blocos com corpo dobrável);
 *  - comentários `@* … *@` (fold de comentário).
 * Não faz parsing de HTML (isso vem do html-service via folding).
 */
export function parseCshtmlOutline(text: string): {
  symbols: CshtmlSymbol[];
  folds: CshtmlFold[];
} {
  const idx = indexLines(text);
  const symbols: CshtmlSymbol[] = [];
  const folds: CshtmlFold[] = [];

  // As keywords exigem fronteira de palavra à direita (senão `@modelData` casaria
  // `@model`); `{`/`*` não. `@@` (escape Razor) é filtrado abaixo pelo char anterior.
  const re = /@(?:(model|page|using|inject|section|functions|code)(?![A-Za-z0-9_])|(\{|\*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const at = m.index;
    // `@@` é escape do Razor (um `@` literal) — não é uma transição. Pula quando
    // o caractere anterior também é `@`.
    if (at > 0 && text[at - 1] === "@") continue;
    const kw = m[1] ?? m[2];
    const start = posAt(idx, at);

    if (kw === "*") {
      // Comentário @* … *@
      const end = text.indexOf("*@", at + 2);
      const endOff = end === -1 ? text.length : end + 2;
      const endPos = posAt(idx, endOff);
      if (endPos.line > start.line) {
        folds.push({ startLine: start.line, endLine: endPos.line, kind: "comment" });
      }
      re.lastIndex = endOff;
      continue;
    }

    if (kw === "{") {
      // Bloco de código @{ … }
      const close = matchBrace(text, at + 1);
      const endPos = close === -1 ? posAt(idx, text.length) : posAt(idx, close);
      symbols.push({
        name: "@{ }",
        kind: "codeBlock",
        line: start.line,
        character: start.character,
        endLine: endPos.line,
        endCharacter: endPos.character + 1,
      });
      if (endPos.line > start.line) {
        folds.push({ startLine: start.line, endLine: endPos.line, kind: "region" });
      }
      re.lastIndex = close === -1 ? text.length : close + 1;
      continue;
    }

    const lineKind = LINE_DIRECTIVE_KINDS[kw];
    if (lineKind) {
      // Diretiva de linha: nome = resto da linha (trim).
      const lineEnd = text.indexOf("\n", at);
      const rest = text.slice(at, lineEnd === -1 ? text.length : lineEnd).trim();
      symbols.push({
        name: rest,
        kind: lineKind,
        line: start.line,
        character: start.character,
        endLine: start.line,
        endCharacter: start.character + rest.length,
      });
      continue;
    }

    // @section Nome { }, @functions { }, @code { }
    const afterKw = at + 1 + kw.length;
    const braceRel = text.slice(afterKw).search(/\{/);
    if (braceRel === -1) continue;
    const braceOff = afterKw + braceRel;
    // Para @section, o nome está entre a keyword e o `{`.
    const between = text.slice(afterKw, braceOff).trim();
    const name = kw === "section" ? `@section ${between}` : `@${kw}`;
    const close = matchBrace(text, braceOff);
    const endPos = close === -1 ? posAt(idx, text.length) : posAt(idx, close);
    symbols.push({
      name,
      kind: kw === "section" ? "section" : kw === "functions" ? "functions" : "code",
      line: start.line,
      character: start.character,
      endLine: endPos.line,
      endCharacter: endPos.character + 1,
    });
    if (endPos.line > start.line) {
      folds.push({ startLine: start.line, endLine: endPos.line, kind: "region" });
    }
    re.lastIndex = close === -1 ? text.length : close + 1;
  }

  return { symbols, folds };
}
