import { useEffect, useRef, useState } from "react";
import { searchInDir } from "../api";
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Effective search root: the scoped folder when set, else the workspace root.
  const searchRoot =
    scopePath && rootPath && scopePath.startsWith(rootPath) ? scopePath : rootPath;
  const isScoped = !!searchRoot && searchRoot !== rootPath;

  async function runSearch() {
    if (!searchRoot || !query.trim()) return;
    setStatus("searching");
    try {
      const results = await searchInDir(searchRoot, query.trim());
      setMatches(results);
    } catch (err) {
      console.error(err);
      setMatches([]);
    } finally {
      setStatus("done");
    }
  }

  // Re-run when the scope changes if there is already a query typed.
  useEffect(() => {
    if (query.trim()) runSearch();
    // Only react to scope changes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRoot]);

  // Focus the input when a scope is applied (the action opens the panel).
  useEffect(() => {
    if (isScoped) inputRef.current?.focus();
  }, [isScoped]);

  const groups = groupByFile(matches);

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
            if (e.key === "Enter") runSearch();
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
        ) : status === "searching" ? (
          <div className="search-empty">Pesquisando…</div>
        ) : status === "done" && matches.length === 0 ? (
          <div className="search-empty">Nenhum resultado.</div>
        ) : (
          <>
            {matches.length > 0 && (
              <div className="search-summary">
                {matches.length} resultado(s) em {groups.size} arquivo(s)
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
