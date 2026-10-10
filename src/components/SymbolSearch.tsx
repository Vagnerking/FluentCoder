import { useEffect, useMemo, useRef, useState } from "react";
import { useModalDismiss } from "./useModalDismiss";
import {
  toSymbolHits,
  rankSymbolHits,
  symbolKindLabel,
  type LspSymbolInformation,
  type SymbolHit,
} from "../lsp/workspaceSymbols";
import { getRunningClient } from "../lsp/client";
import { CSHARP_SERVER_ID } from "../lsp/servers/csharp";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface SymbolSearchProps {
  /** Opens the chosen symbol's file at its line/column (1-based). */
  onOpenSymbol: (path: string, line: number, column: number) => void;
  onClose: () => void;
}

/** Debounce for the `workspace/symbol` round-trip while typing. */
const QUERY_DEBOUNCE_MS = 150;
const MAX_VISIBLE = 100;

/** Basename for the dim path shown on each row. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * "Ir para Símbolo no Projeto" (VS Code's Ctrl+T). Queries `workspace/symbol` on
 * the running C# (Roslyn) client, ranks the hits with the pure matcher in
 * `lsp/workspaceSymbols`, and reveals the chosen symbol. Mirrors the QuickOpen
 * overlay (reuses the `quick-open-*` CSS) for a consistent look.
 *
 * Only C# is wired: Roslyn is the sole server exposing whole-solution symbols
 * here. With no C# server running (no folder / non-.NET project) the list stays
 * empty with a clear hint.
 */
export function SymbolSearch({ onOpenSymbol, onClose }: SymbolSearchProps) {
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<SymbolHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [noServer, setNoServer] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Query Roslyn on a debounce. An empty query returns nothing (Roslyn would
  // otherwise stream the entire symbol table). Each keystroke supersedes the
  // previous request via the `cancelled` guard.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSymbols([]);
      setLoading(false);
      setNoServer(false);
      return;
    }
    const client = getRunningClient(CSHARP_SERVER_ID);
    if (!client) {
      setSymbols([]);
      setNoServer(true);
      return;
    }
    setNoServer(false);
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .sendRequest("workspace/symbol", { query: q })
        .then((res) => {
          if (cancelled) return;
          const list = Array.isArray(res) ? (res as LspSymbolInformation[]) : [];
          setSymbols(toSymbolHits(list));
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setSymbols([]);
          setLoading(false);
        });
    }, QUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const visible = useMemo(
    () => rankSymbolHits(query, symbols, MAX_VISIBLE),
    [query, symbols]
  );

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function openAt(index: number) {
    const hit = visible[index];
    if (!hit) return;
    onOpenSymbol(hit.path, hit.line, hit.column);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (visible.length ? (s + 1) % visible.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        visible.length ? (s - 1 + visible.length) % visible.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      openAt(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  const emptyText = noServer
    ? "Servidor C# não está ativo — abra um projeto .NET."
    : query.trim()
      ? loading
        ? "Procurando…"
        : "Nenhum símbolo encontrado."
      : "Digite para procurar símbolos (classes, métodos, …).";

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div className="quick-open">
        <div className="quick-pick-title">Ir para símbolo no projeto</div>
        <input
          ref={inputRef}
          className="quick-open-input"
          type="text"
          placeholder="Digite o nome de um símbolo…"
          value={query}
          aria-label="Ir para símbolo: pesquisar por nome"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="quick-open-list" role="listbox" ref={listRef}>
          {visible.length === 0 ? (
            <div className="quick-open-empty">{emptyText}</div>
          ) : (
            visible.map((hit, i) => (
              <div
                key={`${hit.path}:${hit.line}:${hit.column}:${hit.name}`}
                role="option"
                aria-selected={i === selected}
                className={"quick-open-item" + (i === selected ? " selected" : "")}
                title={`${hit.containerName ? hit.containerName + "." : ""}${hit.name} — ${hit.path}`}
                onMouseMove={() => setSelected(i)}
                onClick={() => openAt(i)}
              >
                <FileIcon path={hit.path} className="quick-open-icon" />
                <span className="quick-open-name">{hit.name}</span>
                <span className="symbol-kind-tag">{symbolKindLabel(hit.kind)}</span>
                <span className="quick-open-path">
                  {hit.containerName ? `${hit.containerName} · ` : ""}
                  {baseName(hit.path)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
