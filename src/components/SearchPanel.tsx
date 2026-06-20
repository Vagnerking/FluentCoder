import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelSearch, searchInDir } from "../api";
import type { FileNode, SearchMatch } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface SearchPanelProps {
  /** Root folder to search within, or null when no folder is open. */
  rootPath: string | null;
  /** Sub-folder to scope the search to, or null to use the workspace root. */
  scopePath?: string | null;
  /** Clears the folder scope, returning the search to the workspace root. */
  onClearScope?: () => void;
  /** Opens a file (and ideally jumps to a line) when a result is clicked. */
  onOpenMatch: (node: FileNode, line: number) => void;
}

/** Groups flat matches by file path, preserving first-seen order. */
function groupByFile(matches: SearchMatch[]): Map<string, SearchMatch[]> {
  const groups = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const list = groups.get(m.path);
    if (list) list.push(m);
    else groups.set(m.path, [m]);
  }
  return groups;
}

/** Last path segment, handling Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * The Search view in the sidebar. Runs a recursive, case-insensitive text
 * search through the open folder via the Rust `search_in_dir` command and
 * lists results grouped by file, VSCode-style. The search root is the
 * workspace root by default but can be narrowed to a sub-folder via `scopePath`
 * (e.g. the explorer's "Localizar na pasta").
 */
export function SearchPanel({
  rootPath,
  scopePath = null,
  onClearScope,
  onOpenMatch,
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const [limitHit, setLimitHit] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  // Effective search root: the scoped folder when set, else the workspace root.
  const searchRoot =
    scopePath && rootPath && scopePath.startsWith(rootPath) ? scopePath : rootPath;
  const isScoped = !!searchRoot && searchRoot !== rootPath;

  const runSearch = useCallback(
    async (term: string, requestId: number) => {
      if (!searchRoot || !term || requestId !== requestRef.current) return;
      setStatus("searching");
      setError(null);
      try {
        await cancelSearch();
        if (requestId !== requestRef.current) return;
        const response = await searchInDir(searchRoot, term);
        if (requestId !== requestRef.current || response.cancelled) return;
        setMatches(response.matches);
        setLimitHit(response.limitHit);
        setElapsedMs(response.elapsedMs);
        setStatus("done");
      } catch (err) {
        if (requestId !== requestRef.current) return;
        console.error(err);
        setMatches([]);
        setLimitHit(false);
        setError("Não foi possível concluir a pesquisa.");
        setStatus("done");
      }
    },
    [searchRoot]
  );

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const term = query.trim();
    const requestId = ++requestRef.current;
    void cancelSearch();

    if (!searchRoot || !term) {
      setMatches([]);
      setLimitHit(false);
      setElapsedMs(0);
      setError(null);
      setStatus("idle");
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void runSearch(term, requestId);
    }, 200);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, searchRoot, runSearch]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      void cancelSearch();
    },
    []
  );

  // Focus the input when a scope is applied (the action opens the panel).
  useEffect(() => {
    if (isScoped) inputRef.current?.focus();
  }, [isScoped]);

  const groups = useMemo(() => groupByFile(matches), [matches]);

  function searchNow() {
    const term = query.trim();
    if (!searchRoot || !term) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const requestId = ++requestRef.current;
    void runSearch(term, requestId);
  }

  return (
    <div className="search-panel">
      <div className="search-header">
        <span className="explorer-title">PESQUISAR</span>
      </div>

      <div className="search-input-row">
        <Codicon name="search" className="search-input-icon" />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Pesquisar"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") searchNow();
            if (e.key === "Escape") {
              requestRef.current += 1;
              void cancelSearch();
              setStatus(matches.length ? "done" : "idle");
            }
          }}
          disabled={!rootPath}
        />
      </div>

      {isScoped && searchRoot && (
        <div className="search-scope">
          <span className="search-scope-chip" title={searchRoot}>
            <Codicon name="folder" size={12} />
            <span className="search-scope-name">{baseName(searchRoot)}</span>
            <button
              className="search-scope-clear"
              title="Limpar escopo da pasta"
              aria-label="Limpar escopo da pasta"
              onClick={() => onClearScope?.()}
            >
              <Codicon name="close" size={12} />
            </button>
          </span>
        </div>
      )}

      <div className="search-results">
        {!rootPath ? (
          <div className="search-empty">Abra uma pasta para pesquisar.</div>
        ) : error ? (
          <div className="search-empty" role="alert">{error}</div>
        ) : status === "done" && matches.length === 0 ? (
          <div className="search-empty">Nenhum resultado.</div>
        ) : (
          <>
            {status === "searching" && (
              <div className="search-progress" role="status">
                <Codicon name="loading" size={12} spin /> Pesquisando…
              </div>
            )}
            {matches.length > 0 && (
              <div className="search-summary">
                {matches.length} resultado(s) em {groups.size} arquivo(s)
                {limitHit ? " · limite atingido" : ""}
                {status === "done" ? ` · ${elapsedMs} ms` : ""}
              </div>
            )}
            {[...groups.entries()].map(([path, fileMatches]) => (
              <div key={path} className="search-file-group">
                <div className="search-file-name" title={path}>
                  <FileIcon path={path} className="search-file-icon" />
                  {fileMatches[0].name}
                </div>
                {fileMatches.map((m, i) => (
                  <div
                    key={i}
                    className="search-match-row"
                    title={`${path}:${m.line}`}
                    onClick={() =>
                      onOpenMatch(
                        { name: m.name, path: m.path, isDir: false },
                        m.line
                      )
                    }
                  >
                    <span className="search-match-line">{m.line}</span>
                    <span className="search-match-text">{m.text.trim()}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
