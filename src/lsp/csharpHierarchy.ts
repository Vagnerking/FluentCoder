/**
 * Lógica PURA de composição de Call/Type Hierarchy para C# (ADR 0004). O Roslyn
 * standalone não implementa `callHierarchy`/`typeHierarchy` (endpoints retornam
 * `-32601`), então a hierarquia é derivada de `definition`/`implementation`/
 * `references`/`documentSymbol`. Este módulo contém só as partes puras/testáveis;
 * o wiring `vscode` fino vive em `csharpHierarchyProvider.ts`.
 */

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Um símbolo com range (0-based, meio-aberto) — subconjunto do LSP DocumentSymbol. */
export interface RangedSymbol {
  name: string;
  /** LSP SymbolKind. */
  kind: number;
  /** Range do símbolo inteiro (assinatura + corpo). */
  range: LspRange;
  /** Range só do NOME (para pedir references/definition no lugar certo). */
  selectionRange: LspRange;
  /** Símbolos aninhados (métodos dentro de classe, etc.). */
  children?: RangedSymbol[];
}

/** LSP SymbolKind (1-based) → vscode SymbolKind (0-based). Passar o valor LSP cru
 *  como vscode SymbolKind pintaria o ícone errado (class viraria method, etc.). */
export function lspKindToVscode(lspKind: number): number {
  // vscode: File=0, Module=1, Namespace=2, Package=3, Class=4, Method=5,
  // Property=6, Field=7, Constructor=8, Enum=9, Interface=10, Function=11,
  // Variable=12, Constant=13, … EnumMember=21, Struct=22. LSP é tudo +1.
  return lspKind >= 1 ? lspKind - 1 : lspKind;
}

/** Kinds LSP que são TIPOS (class/enum/interface/struct/record→class). */
export const TYPE_KINDS = new Set([5, 10, 11, 23]);

/** Kinds LSP "chamáveis" para call hierarchy (método/ctor/propriedade/função). */
export const CALL_KINDS = new Set([6, 9, 12, 7]);

/** Posição 0-based. */
export interface Pos {
  line: number;
  character: number;
}

function contains(range: LspRange, pos: Pos): boolean {
  const afterStart =
    pos.line > range.start.line ||
    (pos.line === range.start.line && pos.character >= range.start.character);
  // Range LSP é meio-aberto: `end` é exclusivo (`<`), não inclusivo.
  const beforeEnd =
    pos.line < range.end.line ||
    (pos.line === range.end.line && pos.character < range.end.character);
  return afterStart && beforeEnd;
}

/** Conjunto amplo de containers (para agrupar uma referência pelo símbolo que a
 *  envolve, seja método ou tipo — o "chamador" no incoming call). */
export const CONTAINER_KINDS = new Set([
  5 /* Class */, 6 /* Method */, 9 /* Constructor */, 12 /* Function */,
  11 /* Interface */, 23 /* Struct */, 10 /* Enum */, 7 /* Property */,
]);

/**
 * Acha o símbolo MAIS PROFUNDO cujo kind está em `kinds` e que contém `pos`,
 * caminhando a árvore de `documentSymbol`. Parametrizar `kinds` é essencial:
 *   - Type Hierarchy passa {@link TYPE_KINDS} → com o cursor no CORPO de um método,
 *     ainda acha o TIPO envolvente (o método não é um kind de tipo, então é
 *     ignorado e o tipo pai vence);
 *   - Call Hierarchy passa {@link CALL_KINDS} → só métodos/ctors/props/funções;
 *   - o agrupamento de referências passa {@link CONTAINER_KINDS} (amplo).
 * Retorna null se nenhum símbolo de `kinds` contém `pos`.
 */
export function containerOfPosition(
  symbols: readonly RangedSymbol[],
  pos: Pos,
  kinds: ReadonlySet<number> = CONTAINER_KINDS
): RangedSymbol | null {
  let best: RangedSymbol | null = null;
  const visit = (list: readonly RangedSymbol[]) => {
    for (const s of list) {
      if (!contains(s.range, pos)) continue;
      if (kinds.has(s.kind)) best = s; // mais profundo do kind pedido vence
      if (s.children) visit(s.children);
    }
  };
  visit(symbols);
  return best;
}

/**
 * Heurística "esta referência é uma CHAMADA?": o identificador é seguido (pulando
 * espaços/generics `<...>`) de um `(`. Distingue `foo()` (chamada) de `var f =
 * foo;` (method group) na maioria dos casos. `identEnd` é o offset logo APÓS o
 * identificador na linha/texto.
 */
export function isLikelyCall(lineText: string, identEnd: number): boolean {
  let i = identEnd;
  // pula espaços
  while (i < lineText.length && /\s/.test(lineText[i])) i++;
  // pula um bloco de generics <...> balanceado numa linha só
  if (lineText[i] === "<") {
    let depth = 0;
    while (i < lineText.length) {
      if (lineText[i] === "<") depth++;
      else if (lineText[i] === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (lineText[i] === ";" || lineText[i] === "=") {
        return false; // não era generics de chamada
      }
      i++;
    }
    while (i < lineText.length && /\s/.test(lineText[i])) i++;
  }
  return lineText[i] === "(";
}

/**
 * Extrai os nomes de SUPERTIPOS de um texto de hover/assinatura C# do tipo, do
 * padrão `... class Circle : Base, IShape ...` (ou `struct`/`interface`/`record`).
 * Retorna os identificadores após `:` até `{`/quebra/`where`, sem argumentos
 * genéricos aninhados. Vazio quando não há cláusula de base.
 */
export function parseSupertypes(hoverText: string): string[] {
  // Pega "class Nome<...> : LISTA" — a LISTA vai até `{`, `where` ou fim de linha.
  const m = hoverText.match(
    /\b(?:class|struct|interface|record(?:\s+(?:class|struct))?)\s+[A-Za-z_]\w*(?:<[^>]*>)?\s*:\s*([^\{]+)/
  );
  if (!m) return [];
  let list = m[1];
  // corta em `where` (constraints) e no `;` de um tipo sem corpo (`record X : Y;`).
  const whereIdx = list.search(/\bwhere\b/);
  if (whereIdx !== -1) list = list.slice(0, whereIdx);
  const semi = list.indexOf(";");
  if (semi !== -1) list = list.slice(0, semi);
  // separa por vírgula no nível 0 (ignora vírgulas dentro de <...>).
  const parts: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of list) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(token);
      token = "";
      continue;
    }
    token += ch;
  }
  parts.push(token);
  return parts
    .map((p) => p.trim())
    // só o nome simples (sem generics nem namespace) para resolver por workspace/symbol.
    .map((p) => p.replace(/<.*$/, "").trim())
    .map((p) => {
      const dot = p.lastIndexOf(".");
      return dot === -1 ? p : p.slice(dot + 1);
    })
    .filter((p) => /^[A-Za-z_]\w*$/.test(p));
}
