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
      children?: unknown[];
    };
    return {
      name: d.name,
      kind: d.kind,
      range: d.range,
      children: d.children?.map(toRanged),
    };
  };
  return Array.isArray(res) ? res.map(toRanged) : [];
}

// ── Type Hierarchy ──────────────────────────────────────────────────────────

function typeItem(name: string, kind: number, uri: string, range: LspRange): vscode.TypeHierarchyItem {
  return new vscode.TypeHierarchyItem(
    kind as unknown as vscode.SymbolKind,
    name,
    "",
    vscode.Uri.parse(uri),
    toVsRange(range),
    toVsRange(range)
  );
}

const typeHierarchyProvider: vscode.TypeHierarchyProvider = {
  async prepareTypeHierarchy(document, position) {
    const uri = document.uri.toString();
    // Acha o símbolo (tipo) que contém a posição via documentSymbol.
    const syms = await documentSymbols(uri);
    const container = containerOfPosition(syms, { line: position.line, character: position.character });
    if (!container) return undefined;
    // Só tipos: class/struct/interface/enum/record.
    if (![5, 10, 11, 23].includes(container.kind)) return undefined;
    return typeItem(container.name, container.kind, uri, container.range);
  },

  async provideTypeHierarchySupertypes(item) {
    const uri = item.uri.toString();
    // definition no nome do tipo → a base; ampliado por hover (parse da cláusula).
    const pos = { line: item.range.start.line, character: item.range.start.character };
    const results: vscode.TypeHierarchyItem[] = [];
    // 1) hover → nomes de supertipos → workspace/symbol para localizá-los.
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
    const pos = { line: item.range.start.line, character: item.range.start.character };
    // implementation no tipo → classes derivadas / implementações diretas.
    const res = await lspRequest<unknown>("textDocument/implementation", {
      textDocument: { uri }, position: pos,
    });
    const out: vscode.TypeHierarchyItem[] = [];
    for (const loc of asLocations(res)) {
      const name = await symbolNameAt(loc);
      out.push(typeItem(name ?? "(tipo)", 5, loc.uri, loc.range));
    }
    return out;
  },
};

// ── Call Hierarchy ──────────────────────────────────────────────────────────

function callItem(name: string, kind: number, uri: string, range: LspRange): vscode.CallHierarchyItem {
  return new vscode.CallHierarchyItem(
    kind as unknown as vscode.SymbolKind,
    name,
    "",
    vscode.Uri.parse(uri),
    toVsRange(range),
    toVsRange(range)
  );
}

const callHierarchyProvider: vscode.CallHierarchyProvider = {
  async prepareCallHierarchy(document, position) {
    const uri = document.uri.toString();
    const syms = await documentSymbols(uri);
    const container = containerOfPosition(syms, { line: position.line, character: position.character });
    if (!container) return undefined;
    return callItem(container.name, container.kind, uri, container.range);
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
    // Cache de documentSymbol + texto por arquivo (para container + heurística).
    const symCache = new Map<string, RangedSymbol[]>();
    for (const ref of refs) {
      // Heurística "é chamada": olha o texto da linha da referência.
      const line = await lineTextAt(ref.uri, ref.range.start.line);
      if (line != null && !isLikelyCall(line, ref.range.end.character)) continue;
      let syms = symCache.get(ref.uri);
      if (!syms) {
        syms = await documentSymbols(ref.uri);
        symCache.set(ref.uri, syms);
      }
      const container = containerOfPosition(syms, ref.range.start);
      if (!container) continue;
      const key = `${ref.uri}#${container.name}#${container.range.start.line}`;
      let entry = byContainer.get(key);
      if (!entry) {
        entry = { item: callItem(container.name, container.kind, ref.uri, container.range), ranges: [] };
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
    const calls = scanOutgoingCalls(text, item.range);
    const out: vscode.CallHierarchyOutgoingCall[] = [];
    for (const call of calls) {
      const def = await lspRequest<unknown>("textDocument/definition", {
        textDocument: { uri }, position: { line: call.line, character: call.character },
      });
      const loc = asLocations(def)[0];
      if (!loc) continue;
      out.push(
        new vscode.CallHierarchyOutgoingCall(
          callItem(call.name, 6 /* Method */, loc.uri, loc.range),
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

/** Resolve um tipo pelo nome simples via workspace/symbol (primeiro hit em fonte). */
async function resolveTypeByName(name: string): Promise<LspLocation | null> {
  const res = await lspRequest<Array<{ name: string; location?: LspLocation; kind?: number }>>(
    "workspace/symbol", { query: name }
  );
  if (!Array.isArray(res)) return null;
  const hit = res.find(
    (s) => s.name === name && s.location && !/\.g\.cs$/i.test(s.location.uri) && [5, 10, 11, 23].includes(s.kind ?? -1)
  );
  return hit?.location ?? null;
}

/** Nome do símbolo cujo range começa em `loc` (via documentSymbol do arquivo). */
async function symbolNameAt(loc: LspLocation): Promise<string | null> {
  const syms = await documentSymbols(loc.uri);
  const found = containerOfPosition(syms, loc.range.start);
  return found?.name ?? null;
}

/** Texto de uma linha 0-based de um arquivo (via o model Monaco se aberto, senão fs). */
async function lineTextAt(uri: string, line: number): Promise<string | null> {
  const text = await fileText(uri);
  if (text == null) return null;
  return text.split(/\r?\n/)[line] ?? null;
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

/** Alvos de chamada no corpo de `range`: identificador seguido de `(`. */
function scanOutgoingCalls(
  text: string,
  range: vscode.Range
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
      // pula keywords de controle que não são chamadas.
      if (/^(if|for|foreach|while|switch|catch|using|lock|return|new|nameof|typeof|sizeof)$/.test(name)) continue;
      const character = m.index;
      const key = `${name}#${ln}#${character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, line: ln, character });
    }
  }
  return out;
}

/**
 * Registra os providers de Call/Type Hierarchy para `.cs`. Retorna os disposables
 * (entram no contribution set do cliente C# → reset de servidores).
 */
export function installCsharpHierarchyProviders(): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { language: "csharp", scheme: "file" };
  return [
    vscode.languages.registerTypeHierarchyProvider(selector, typeHierarchyProvider),
    vscode.languages.registerCallHierarchyProvider(selector, callHierarchyProvider),
  ];
}
