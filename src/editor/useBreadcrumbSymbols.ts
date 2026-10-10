import { useEffect, useState } from "react";
import type { editor } from "monaco-editor";
import { getService, IOutlineModelService } from "@codingame/monaco-vscode-api/services";
import { symbolPathAt, type SymbolNode } from "./breadcrumbs";

/** Token nunca cancelado (o serviço de outline só lê `isCancellationRequested`). */
const NEVER_CANCELLED = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};

export interface BreadcrumbSymbols {
  /** Símbolos de topo do documento (árvore). */
  symbols: readonly SymbolNode[];
  /** Cadeia sob o cursor (externo → interno). */
  chain: readonly SymbolNode[];
}

const EMPTY: BreadcrumbSymbols = { symbols: [], chain: [] };

function sameChain(a: readonly SymbolNode[], b: readonly SymbolNode[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Símbolos do documento para os breadcrumbs, pelo MESMO pipeline do outline
 * do Monaco (Ctrl+Shift+O): `IOutlineModelService`, que agrega os
 * DocumentSymbolProviders já registrados (LSP — Roslyn/TS/…, e o outline
 * próprio de `.cshtml`). Não registra providers nem cria outra instância do
 * Monaco; o serviço faz cache por versão do modelo. Recalcula com debounce em
 * edições e só re-renderiza quando a cadeia sob o cursor muda.
 */
export function useBreadcrumbSymbols(ed: editor.IStandaloneCodeEditor | null): BreadcrumbSymbols {
  const [state, setState] = useState<BreadcrumbSymbols>(EMPTY);

  useEffect(() => {
    if (!ed) {
      setState(EMPTY);
      return;
    }
    let disposed = false;
    let timer = 0;
    let seq = 0;
    let symbols: readonly SymbolNode[] = [];
    let lastRetry = 0;

    const publish = () => {
      if (disposed) return;
      const pos = ed.getPosition();
      const chain = pos ? symbolPathAt(symbols, pos.lineNumber, pos.column) : [];
      setState((cur) => (cur.symbols === symbols && sameChain(cur.chain, chain) ? cur : { symbols, chain }));
    };

    const refresh = async () => {
      const model = ed.getModel();
      const mine = ++seq;
      if (!model) {
        symbols = [];
        publish();
        return;
      }
      try {
        const service = await getService(IOutlineModelService);
        const outline = await service.getOrCreate(model, NEVER_CANCELLED as never);
        if (disposed || mine !== seq || ed.getModel() !== model) return;
        symbols = outline.getTopLevelSymbols() as unknown as SymbolNode[];
      } catch {
        if (disposed || mine !== seq) return;
        symbols = [];
      }
      publish();
    };

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), ms);
    };

    schedule(0);
    const subs = [
      ed.onDidChangeModel(() => {
        symbols = [];
        publish();
        schedule(0);
      }),
      ed.onDidChangeModelContent(() => schedule(500)),
      // O id de linguagem chega depois do modelo (plaintext → typescript…).
      ed.onDidChangeModelLanguage(() => schedule(0)),
      ed.onDidChangeCursorPosition(() => {
        publish();
        // Providers LSP registram depois que o servidor sobe: sem símbolos
        // ainda, tenta de novo (com folga) quando o usuário se move.
        const now = Date.now();
        if (symbols.length === 0 && now - lastRetry > 1500) {
          lastRetry = now;
          schedule(150);
        }
      }),
    ];
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      subs.forEach((s) => s.dispose());
    };
  }, [ed]);

  return state;
}
