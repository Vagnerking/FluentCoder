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
 *
 * Nota: `@code { }` é diretiva Blazor (`.razor`), não MVC — reconhecida aqui de
 * propósito, como preparo para estender o outline a `.razor` (ADR 0005); é inócua
 * num `.cshtml` real (nunca aparece).
 */

/** Tipo de símbolo do outline; o adapter mapeia para o `SymbolKind` do Monaco. */
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
  /** Coluna 0-based logo após o NOME no fonte (para o selectionRange do adapter,
   *  sem inferir pelo comprimento do nome de exibição). Sempre na linha `line`. */
  nameEndCharacter: number;
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
 * aninhamento. Retorna o offset do `}` ou -1.
 *
 * `csharp = true` (blocos `@{ }`/`@code`/`@functions`): o corpo é C#, então pula
 * strings/chars e comentários `//`/`/* *​/` para não confundir chaves neles.
 *
 * `csharp = false` (`@section Nome { markup }`): o corpo é MARKUP Razor, não C#.
 * Aplicar lexing de C# aqui quebraria em apóstrofos de texto (`<p>Don't</p>`) e
 * em `//` de URLs (`https://…`). Aqui só balanceamos `{`/`}`, ignorando apenas os
 * comentários Razor `@* *@` (onde uma chave literal não conta).
 */
function matchBrace(text: string, open: number, csharp: boolean): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (csharp && (c === '"' || c === "'")) {
      // pula string/char C# (com escape)
      const quote = c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
    } else if (csharp && c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (csharp && c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else if (!csharp && c === "@" && text[i + 1] === "*") {
      // comentário Razor @* … *@ no markup — não conta chaves nele.
      const end = text.indexOf("*@", i + 2);
      i = end === -1 ? text.length : end + 1;
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
      // Bloco de código @{ … } — corpo C#.
      const close = matchBrace(text, at + 1, true);
      const endPos = close === -1 ? posAt(idx, text.length) : posAt(idx, close);
      symbols.push({
        name: "@{ }",
        kind: "codeBlock",
        line: start.line,
        character: start.character,
        nameEndCharacter: start.character + 2, // `@{`
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
        nameEndCharacter: start.character + rest.length,
        endLine: start.line,
        endCharacter: start.character + rest.length,
      });
      continue;
    }

    // @section Nome { }, @functions { }, @code { }. A `{` deve vir logo após a
    // keyword (só espaços e, para @section, um identificador de nome) — BOUNDED,
    // senão um `@section` malformado casaria uma `{` distante e engoliria blocos
    // legítimos no meio. Sem `{` válido nesse trecho → não é bloco, segue.
    const afterKw = at + 1 + kw.length;
    const head = /^\s*([A-Za-z_][\w.]*)?\s*\{/.exec(text.slice(afterKw, afterKw + 256));
    if (!head) continue;
    const braceOff = afterKw + head.index + head[0].length - 1; // offset do `{`
    const between = (head[1] ?? "").trim();
    const name = kw === "section" ? `@section ${between}` : `@${kw}`;
    // Coluna após o nome/keyword no fonte, antes do `{`.
    const nameEndChar = start.character + 1 + kw.length + (between ? 1 + between.length : 0);
    // @section tem corpo MARKUP (não lexar C#); @functions/@code são C#.
    const close = matchBrace(text, braceOff, kw !== "section");
    const endPos = close === -1 ? posAt(idx, text.length) : posAt(idx, close);
    symbols.push({
      name,
      kind: kw === "section" ? "section" : kw === "functions" ? "functions" : "code",
      line: start.line,
      character: start.character,
      nameEndCharacter: nameEndChar,
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
