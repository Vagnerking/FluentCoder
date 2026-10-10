/**
 * Providers de Call/Type Hierarchy para C# (ADR 0004), registrados via a API
 * `vscode` do `@codingame/monaco-vscode-api` (o `monaco.languages` standalone não
 * expõe esses providers). Como o Roslyn standalone NÃO implementa
 * `callHierarchy`/`typeHierarchy` (endpoints `-32601`), a hierarquia é COMPOSTA de
 * `definition`/`implementation`/`references`/`documentSymbol` — a lógica pura está
 * em `csharpHierarchy.ts`; aqui fica só o wiring fino + conversões.
 *
 * Cada request LSP vai ao cliente C# principal via `getRunningClient` +
 * `sendRequest`. Best-effort: falhas nunca quebram o editor; retornam vazio.
 */
import * as vscode from "vscode";
import { getRunningClient } from "./client";
import { CSHARP_SERVER_ID } from "./servers/csharp";
import { fromFileUri } from "./uri";
import {
  containerOfPosition,
  isLikelyCall,
  parseSupertypes,
  lspKindToVscode,
  TYPE_KINDS,
  CALL_KINDS,
  CONTAINER_KINDS,
  type RangedSymbol,
} from "./csharpHierarchy";
import { lspLog } from "./debug";

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos; end: LspPos };
type LspLocation = { uri: string; range: LspRange };

const client = () => getRunningClient(CSHARP_SERVER_ID);

/** vscode.Position (1-based? não — vscode é 0-based, igual LSP). */
function toVsRange(r: LspRange): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

/** Normaliza a resposta de definition/implementation/references em Location[]. */
function asLocations(res: unknown): LspLocation[] {
  const arr = Array.isArray(res) ? res : res ? [res] : [];
  const out: LspLocation[] = [];
  for (const raw of arr) {
    const l = raw as { uri?: string; targetUri?: string; range?: LspRange; targetSelectionRange?: LspRange };
    const uri = l.uri ?? l.targetUri;
    const range = l.range ?? l.targetSelectionRange;
    if (uri && range) out.push({ uri, range });
  }
  return out;
}

async function lspRequest<T>(method: string, params: unknown): Promise<T | null> {
  const c = client();
  if (!c) return null;
  try {
    return await c.sendRequest<T>(method, params);
  } catch (err) {
    lspLog("hierarchy request failed", method, String(err));
    return null;
  }
}

/** documentSymbol de um arquivo (LSP), como árvore de RangedSymbol. */
async function documentSymbols(uri: string): Promise<RangedSymbol[]> {
  const res = await lspRequest<unknown[]>("textDocument/documentSymbol", {
    textDocument: { uri },
  });
  const toRanged = (s: unknown): RangedSymbol => {
    const d = s as {
      name: string;
      kind: number;
      range: LspRange;
      selectionRange?: LspRange;
      children?: unknown[];
    };
    return {
      name: d.name,
      kind: d.kind,
      range: d.range,
      // O selectionRange (só o nome) é o alvo certo para references/definition;
      // cai no range inteiro se o servidor não o enviar.
      selectionRange: d.selectionRange ?? d.range,
      children: d.children?.map(toRanged),
    };
  };
  return Array.isArray(res) ? res.map(toRanged) : [];
}

// ── Type Hierarchy ──────────────────────────────────────────────────────────

function typeItem(
  name: string,
  lspKind: number,
  uri: string,
  range: LspRange,
  selectionRange: LspRange = range
): vscode.TypeHierarchyItem {
  return new vscode.TypeHierarchyItem(
    lspKindToVscode(lspKind) as vscode.SymbolKind,
    name,
    "",
    vscode.Uri.parse(uri),
    toVsRange(range),
    toVsRange(selectionRange)
  );
}

const typeHierarchyProvider: vscode.TypeHierarchyProvider = {
  async prepareTypeHierarchy(document, position) {
    const uri = document.uri.toString();
    // O TIPO envolvente da posição — com TYPE_KINDS, o cursor no corpo de um método
    // ainda resolve para o tipo (o método é ignorado; o tipo pai vence), como no VS.
    const syms = await documentSymbols(uri);
    const container = containerOfPosition(
      syms,
      { line: position.line, character: position.character },
      TYPE_KINDS
    );
    if (!container) return undefined;
    return typeItem(container.name, container.kind, uri, container.range, container.selectionRange);
  },

  async provideTypeHierarchySupertypes(item) {
    const uri = item.uri.toString();
    // hover no NOME do tipo → parse da cláusula de base.
    const pos = { line: item.selectionRange.start.line, character: item.selectionRange.start.character };
    const results: vscode.TypeHierarchyItem[] = [];
    // hover no tipo → parse dos nomes da cláusula de base → workspace/symbol.
    const hover = await lspRequest<{ contents?: unknown }>("textDocument/hover", {
      textDocument: { uri }, position: pos,
    });
    const hoverText = hoverToText(hover?.contents);
    for (const name of parseSupertypes(hoverText)) {
      const loc = await resolveTypeByName(name);
      if (loc) results.push(typeItem(name, 5, loc.uri, loc.range));
    }
    return results;
  },

  async provideTypeHierarchySubtypes(item) {
    const uri = item.uri.toString();
    const pos = { line: item.selectionRange.start.line, character: item.selectionRange.start.character };
    // implementation no tipo → classes derivadas / implementações diretas.
    const res = await lspRequest<unknown>("textDocument/implementation", {
      textDocument: { uri }, position: pos,
    });
    const out: vscode.TypeHierarchyItem[] = [];
    const symCache = new Map<string, RangedSymbol[]>();
    for (const loc of asLocations(res)) {
      const sym = await symbolAt(loc, symCache);
      // Usa o nome E o kind reais (interface vs class → ícone correto).
      out.push(typeItem(sym?.name ?? "(tipo)", sym?.kind ?? 5, loc.uri, loc.range));
    }
    return out;
  },
};

// ── Call Hierarchy ──────────────────────────────────────────────────────────

function callItem(
  name: string,
  lspKind: number,
  uri: string,
  range: LspRange,
  selectionRange: LspRange = range
): vscode.CallHierarchyItem {
  return new vscode.CallHierarchyItem(
    lspKindToVscode(lspKind) as vscode.SymbolKind,
    name,
    "",
    vscode.Uri.parse(uri),
    toVsRange(range),
    toVsRange(selectionRange)
  );
}

const callHierarchyProvider: vscode.CallHierarchyProvider = {
  async prepareCallHierarchy(document, position) {
    const uri = document.uri.toString();
    const syms = await documentSymbols(uri);
    // Só métodos/ctors/props/funções são chamáveis — cursor numa classe/em branco
    // não vira item de call hierarchy (evita references ao nome do tipo).
    const container = containerOfPosition(
      syms,
      { line: position.line, character: position.character },
      CALL_KINDS
    );
    if (!container) return undefined;
    return callItem(container.name, container.kind, uri, container.range, container.selectionRange);
  },

  async provideCallHierarchyIncomingCalls(item) {
    const uri = item.uri.toString();
    const pos = { line: item.selectionRange.start.line, character: item.selectionRange.start.character };
    // references no método → filtra as que são chamadas → agrupa por método container.
    const res = await lspRequest<unknown[]>("textDocument/references", {
      textDocument: { uri }, position: pos, context: { includeDeclaration: false },
    });
    const refs = asLocations(res);
    // Agrupa por (arquivo, método container). Um call por container.
    const byContainer = new Map<string, { item: vscode.CallHierarchyItem; ranges: vscode.Range[] }>();
    // Caches por arquivo (documentSymbol + texto) para não re-buscar por ref.
    const symCache = new Map<string, RangedSymbol[]>();
    const textCache = new Map<string, string | null>();
    for (const ref of refs) {
      // Heurística "é chamada": olha o texto da linha da referência.
      let text = textCache.get(ref.uri);
      if (text === undefined) {
        text = await fileText(ref.uri);
        textCache.set(ref.uri, text);
      }
      const line = text?.split(/\r?\n/)[ref.range.start.line] ?? null;
      if (line != null && !isLikelyCall(line, ref.range.end.character)) continue;
      let syms = symCache.get(ref.uri);
      if (!syms) {
        syms = await documentSymbols(ref.uri);
        symCache.set(ref.uri, syms);
      }
      const container = containerOfPosition(syms, ref.range.start, CONTAINER_KINDS);
      if (!container) continue;
      const key = `${ref.uri}#${container.name}#${container.range.start.line}`;
      let entry = byContainer.get(key);
      if (!entry) {
        entry = {
          item: callItem(container.name, container.kind, ref.uri, container.range, container.selectionRange),
          ranges: [],
        };
        byContainer.set(key, entry);
      }
      entry.ranges.push(toVsRange(ref.range));
    }
    return [...byContainer.values()].map((e) => new vscode.CallHierarchyIncomingCall(e.item, e.ranges));
  },

  async provideCallHierarchyOutgoingCalls(item) {
    // MVP: escaneia o corpo do método por identificadores seguidos de `(` e
    // resolve cada alvo por definition. Aproximação textual (ADR 0004).
    const uri = item.uri.toString();
    const text = await fileText(uri);
    if (text == null) return [];
    // Começa DEPOIS da linha da assinatura (selectionRange), senão o próprio nome
    // do método casa o regex e vira uma "chamada para si mesmo".
    const bodyStart = { line: item.selectionRange.end.line, character: 0 };
    const calls = scanOutgoingCalls(text, { start: bodyStart, end: item.range.end });
    const out: vscode.CallHierarchyOutgoingCall[] = [];
    const symCache = new Map<string, RangedSymbol[]>();
    for (const call of calls) {
      if (call.name === item.name) continue; // recursão para si mesmo — ignora
      const def = await lspRequest<unknown>("textDocument/definition", {
        textDocument: { uri }, position: { line: call.line, character: call.character },
      });
      const loc = asLocations(def)[0];
      if (!loc) continue;
      const sym = await symbolAt(loc, symCache);
      out.push(
        new vscode.CallHierarchyOutgoingCall(
          callItem(call.name, sym?.kind ?? 6, loc.uri, loc.range, sym?.selectionRange ?? loc.range),
          [new vscode.Range(call.line, call.character, call.line, call.character + call.name.length)]
        )
      );
    }
    return out;
  },
};

// ── helpers de resolução ────────────────────────────────────────────────────

function hoverToText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((c) => (typeof c === "string" ? c : (c as { value?: string }).value ?? "")).join("\n");
  if (contents && typeof contents === "object" && "value" in contents) return String((contents as { value: unknown }).value);
  return "";
}

/** Resolve um tipo pelo nome simples via workspace/symbol (primeiro hit em fonte).
 *  Nota: homônimos em namespaces diferentes resolvem para o primeiro hit
 *  (limitação MVP aceitável — ver ADR 0004). */
async function resolveTypeByName(name: string): Promise<LspLocation | null> {
  const res = await lspRequest<Array<{ name: string; location?: LspLocation; kind?: number }>>(
    "workspace/symbol", { query: name }
  );
  if (!Array.isArray(res)) return null;
  const hit = res.find(
    (s) => s.name === name && s.location && !/\.g\.cs$/i.test(s.location.uri) && TYPE_KINDS.has(s.kind ?? -1)
  );
  return hit?.location ?? null;
}

/** Símbolo (nome+kind) na posição `loc`, via documentSymbol do arquivo. `symCache`
 *  memoiza o documentSymbol por arquivo (subtypes pode ter N locs no mesmo). */
async function symbolAt(
  loc: LspLocation,
  symCache: Map<string, RangedSymbol[]>
): Promise<RangedSymbol | null> {
  let syms = symCache.get(loc.uri);
  if (!syms) {
    syms = await documentSymbols(loc.uri);
    symCache.set(loc.uri, syms);
  }
  return containerOfPosition(syms, loc.range.start, CONTAINER_KINDS);
}

/** Conteúdo de um arquivo: do model Monaco aberto, senão do disco. */
async function fileText(uri: string): Promise<string | null> {
  try {
    const monaco = await import("monaco-editor");
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model && !model.isDisposed()) return model.getValue();
  } catch {
    /* fallthrough */
  }
  try {
    const { readFile } = await import("../api");
    const { content } = await readFile(fromFileUri(uri));
    return content;
  } catch {
    return null;
  }
}

/** Palavras-chave C# seguidas de `(` que NÃO são chamadas. */
const NON_CALL_KEYWORDS =
  /^(if|else|for|foreach|while|do|switch|case|default|catch|using|lock|fixed|return|new|nameof|typeof|sizeof|checked|unchecked|stackalloc|is|as|base|this|when|await)$/;

/** Alvos de chamada no corpo de `range` (0-based): identificador seguido de `(`.
 *  Dedup por NOME — a árvore de call hierarchy mostra uma aresta por callee, não
 *  uma por ocorrência (a primeira posição basta para resolver a definition). */
function scanOutgoingCalls(
  text: string,
  range: { start: { line: number }; end: { line: number } }
): { name: string; line: number; character: number }[] {
  const lines = text.split(/\r?\n/);
  const out: { name: string; line: number; character: number }[] = [];
  const seen = new Set<string>();
  for (let ln = range.start.line; ln <= range.end.line && ln < lines.length; ln++) {
    const lineText = lines[ln];
    const re = /([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      const name = m[1];
      if (NON_CALL_KEYWORDS.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, line: ln, character: m.index });
    }
  }
  return out;
}

/**
 * Registra os providers de Call/Type Hierarchy para `.cs`. Retorna disposables
 * como `{ dispose(): void }` — o tipo estrutural que `vscode.Disposable` e
 * `monaco.IDisposable` compartilham — para o caller passar a
 * `addClientContributions` sem um `as unknown as` (entram no reset do cliente C#).
 */
export function installCsharpHierarchyProviders(): { dispose(): void }[] {
  const selector: vscode.DocumentSelector = { language: "csharp", scheme: "file" };
  return [
    vscode.languages.registerTypeHierarchyProvider(selector, typeHierarchyProvider),
    vscode.languages.registerCallHierarchyProvider(selector, callHierarchyProvider),
  ];
}
