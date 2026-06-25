import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cancelSearch, searchInDir } from "../api";
import type { FileMatches, FileNode, LineMatch, SearchOptions } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Tooltip } from "./Tooltip";

interface SearchPanelProps {
  /** Root folder to search within, or null when no folder is open. */
  rootPath: string | null;
  /** Sub-folder to scope the search to, or null to use the workspace root. */
  scopePath?: string | null;
  /** Clears the folder scope, returning the search to the workspace root. */
  onClearScope?: () => void;
  /**
   * Opens a result: jumps to the line and selects the matched term (1-based
   * Monaco columns) so it's highlighted in the editor.
   */
  onOpenMatch: (
    node: FileNode,
    line: number,
    startColumn: number,
    endColumn: number
  ) => void;
}

/** Last path segment, handling Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Splits a comma-separated glob field into trimmed, non-empty patterns. */
function parseGlobs(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reads a boolean toggle from localStorage so the regex/case/whole-word choices
 * survive across sessions, like VSCode. Falls back to `initial` when storage is
 * unavailable (and never throws).
 */
function usePersistentBool(key: string, initial: boolean) {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      /* storage unavailable — ignore */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/**
 * Chars of context kept before the first match when clipping a long line. Small
 * on purpose: the results column is narrow, so the matched term must sit near
 * the start of the visible text or it gets cut off by the row's ellipsis.
 */
const LEAD_CONTEXT = 6;

/**
 * Renders a result line with the matched ranges wrapped in `<mark>`, VSCode-style.
 * Leading whitespace is trimmed, and if the first match sits far into a long line
 * the start is clipped (with an ellipsis) so the matched term is always visible
 * in the panel instead of being cut off by the row's `text-overflow: ellipsis`.
 * Ranges are char offsets into the original `text` (right-trimmed + capped by the
 * backend); they're shifted to stay aligned with the displayed string.
 */
function highlightLine(text: string, ranges: [number, number][]): ReactNode {
  // 1) Drop leading whitespace; shift ranges to match.
  const leading = text.length - text.trimStart().length;
  const body = text.slice(leading);
  let rel = ranges.map(
    ([s, e]) => [s - leading, e - leading] as [number, number]
  );

  // 2) If the first match is far in, clip the start so it stays on screen.
  const firstStart = rel.length ? rel[0][0] : 0;
  let prefix = "";
  let cut = 0;
  if (firstStart > LEAD_CONTEXT) {
    cut = firstStart - LEAD_CONTEXT;
    prefix = "…";
  }
  const display = prefix + body.slice(cut);
  const shift = prefix.length - cut;
  rel = rel.map(([s, e]) => [s + shift, e + shift] as [number, number]);

  if (rel.length === 0) return display;

  // 3) Wrap each (clamped) range in a highlight mark.
  const parts: ReactNode[] = [];
  let cursor = 0;
  rel.forEach(([rawStart, rawEnd], i) => {
    const start = Math.max(0, Math.min(rawStart, display.length));
    const end = Math.max(start, Math.min(rawEnd, display.length));
    if (start > cursor) parts.push(display.slice(cursor, start));
    if (end > start) {
      parts.push(
        <mark key={i} className="search-match-highlight">
          {display.slice(start, end)}
        </mark>
      );
    }
    cursor = end;
  });
  if (cursor < display.length) parts.push(display.slice(cursor));
  return parts;
}

/**
 * The Search view in the sidebar. Runs a recursive search through the open
 * folder via the Rust `search_in_dir` command and lists results grouped by file,
 * VSCode-style. Results stream in incrementally (one file event at a time). The
 * toggles (regex, case-sensitive, whole-word) and the include/exclude glob
 * fields mirror VSCode's search box. The search root is the workspace root by
 * default but can be narrowed to a sub-folder via `scopePath` (the explorer's
 * "Localizar na pasta").
 */
export function SearchPanel({
  rootPath,
  scopePath = null,
  onClearScope,
  onOpenMatch,
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileMatches[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const [summary, setSummary] = useState<{
    limitHit: boolean;
    totalMatches: number;
    totalFiles: number;
    elapsedMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regexInvalid, setRegexInvalid] = useState(false);

  // Search toggles (persisted) and the collapsible glob filter fields.
  const [regex, setRegex] = usePersistentBool("search.regex", false);
  const [caseSensitive, setCaseSensitive] = usePersistentBool("search.case", false);
  const [wholeWord, setWholeWord] = usePersistentBool("search.word", false);
  const [showFilters, setShowFilters] = useState(false);
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  // Streaming events are batched into one state update per animation frame, so a
  // burst of file hits doesn't trigger dozens of re-renders that freeze typing.
  const pendingFilesRef = useRef<FileMatches[]>([]);
  const rafRef = useRef<number | null>(null);

  // Effective search root: the scoped folder when set, else the workspace root.
  const searchRoot =
    scopePath && rootPath && scopePath.startsWith(rootPath) ? scopePath : rootPath;
  const isScoped = !!searchRoot && searchRoot !== rootPath;

  const includeGlobs = useMemo(() => parseGlobs(includeText), [includeText]);
  const excludeGlobs = useMemo(() => parseGlobs(excludeText), [excludeText]);
  const options: SearchOptions = useMemo(
    () => ({ regex, caseSensitive, wholeWord, includeGlobs, excludeGlobs }),
    [regex, caseSensitive, wholeWord, includeGlobs, excludeGlobs]
  );

  // Discards any queued batch + pending frame. Called before each new search.
  const resetBatch = useCallback(() => {
    pendingFilesRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const runSearch = useCallback(
    async (term: string, requestId: number) => {
      if (!searchRoot || !term || requestId !== requestRef.current) return;
      setStatus("searching");
      setError(null);
      setRegexInvalid(false);
      setFiles([]);
      setSummary(null);
      resetBatch();

      // Flushes the queued file batch into state in a single update per frame.
      const flush = () => {
        rafRef.current = null;
        if (requestId !== requestRef.current) {
          pendingFilesRef.current = [];
          return;
        }
        const batch = pendingFilesRef.current;
        pendingFilesRef.current = [];
        if (batch.length) setFiles((prev) => [...prev, ...batch]);
      };

      try {
        // No explicit cancelSearch() here: starting a search already invalidates
        // any in-flight one on the backend (it bumps the generation), so the
        // extra round-trip only added latency.
        await searchInDir(searchRoot, term, options, (event) => {
          // Drop events from a search that's already been superseded.
          if (requestId !== requestRef.current) return;
          if (event.type === "matches") {
            pendingFilesRef.current.push(event.file);
            if (rafRef.current === null) {
              rafRef.current = requestAnimationFrame(flush);
            }
          } else if (!event.cancelled) {
            // Final flush so the last batch isn't dropped, then close out.
            if (rafRef.current !== null) {
              cancelAnimationFrame(rafRef.current);
              rafRef.current = null;
            }
            const batch = pendingFilesRef.current;
            pendingFilesRef.current = [];
            if (batch.length) setFiles((prev) => [...prev, ...batch]);
            setSummary({
              limitHit: event.limitHit,
              totalMatches: event.totalMatches,
              totalFiles: event.totalFiles,
              elapsedMs: event.elapsedMs,
            });
            setStatus("done");
          }
        });
      } catch (err) {
        if (requestId !== requestRef.current) return;
        console.error(err);
        // The backend rejects with "Consulta inválida" for a bad regex; flag the
        // input and keep whatever results were already shown.
        if (options.regex) setRegexInvalid(true);
        setError(
          options.regex
            ? "Expressão regular inválida."
            : "Não foi possível concluir a pesquisa."
        );
        setStatus("done");
      }
    },
    [searchRoot, options, resetBatch]
  );

  // Debounced auto-search: re-runs whenever the query OR any option changes.
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const term = query.trim();
    const requestId = ++requestRef.current;
    void cancelSearch();

    if (!searchRoot || !term) {
      resetBatch();
      setFiles([]);
      setSummary(null);
      setError(null);
      setRegexInvalid(false);
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
  }, [query, searchRoot, options, runSearch, resetBatch]);

  // Cancel any in-flight search (and its pending batch) when the panel unmounts.
  useEffect(
    () => () => {
      requestRef.current += 1;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void cancelSearch();
    },
    []
  );

  // Focus the input when a scope is applied (the action opens the panel).
  useEffect(() => {
    if (isScoped) inputRef.current?.focus();
  }, [isScoped]);

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

  const totalMatches = summary?.totalMatches ?? files.reduce((n, f) => n + f.matches.length, 0);

  return (
    <div className="search-panel">
      <div className="search-header">
        <span className="explorer-title">PESQUISAR</span>
      </div>

      <div className="search-input-row">
        <Codicon name="search" className="search-input-icon" />
        <input
          ref={inputRef}
          className={`search-input${regexInvalid ? " search-input-invalid" : ""}`}
          type="text"
          placeholder="Pesquisar"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") searchNow();
            if (e.key === "Escape") {
              requestRef.current += 1;
              void cancelSearch();
              setStatus(files.length ? "done" : "idle");
            }
          }}
          disabled={!rootPath}
        />
        <div className="search-controls">
          <Tooltip label="Diferenciar maiúsculas de minúsculas (Alt+C)">
            <button
              type="button"
              className={`search-toggle${caseSensitive ? " active" : ""}`}
              aria-label="Diferenciar maiúsculas de minúsculas"
              aria-pressed={caseSensitive}
              disabled={!rootPath}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              <Codicon name="caseSensitive" size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Palavra inteira (Alt+W)">
            <button
              type="button"
              className={`search-toggle${wholeWord ? " active" : ""}`}
              aria-label="Palavra inteira"
              aria-pressed={wholeWord}
              disabled={!rootPath}
              onClick={() => setWholeWord((v) => !v)}
            >
              <Codicon name="wholeWord" size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Usar expressão regular (Alt+R)">
            <button
              type="button"
              className={`search-toggle${regex ? " active" : ""}`}
              aria-label="Usar expressão regular"
              aria-pressed={regex}
              disabled={!rootPath}
              onClick={() => setRegex((v) => !v)}
            >
              <Codicon name="regex" size={16} />
            </button>
          </Tooltip>
          <span className="search-controls-sep" aria-hidden="true" />
          <Tooltip label="Alternar arquivos a incluir/excluir">
            <button
              type="button"
              className={`search-toggle${showFilters ? " active" : ""}`}
              aria-label="Alternar arquivos a incluir/excluir"
              aria-pressed={showFilters}
              disabled={!rootPath}
              onClick={() => setShowFilters((v) => !v)}
            >
              <Codicon name="filterFiles" size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {showFilters && (
        <div className="search-filters">
          <label className="search-filter-label">arquivos a incluir</label>
          <input
            className="search-glob-input"
            type="text"
            placeholder="ex.: *.ts, src/**"
            value={includeText}
            onChange={(e) => setIncludeText(e.target.value)}
            disabled={!rootPath}
          />
          <label className="search-filter-label">arquivos a excluir</label>
          <input
            className="search-glob-input"
            type="text"
            placeholder="ex.: **/test/**, *.min.js"
            value={excludeText}
            onChange={(e) => setExcludeText(e.target.value)}
            disabled={!rootPath}
          />
        </div>
      )}

      {isScoped && searchRoot && (
        <div className="search-scope">
          <span className="search-scope-chip" title={searchRoot}>
            <Codicon name="folder" size={12} />
            <span className="search-scope-name">{baseName(searchRoot)}</span>
            <Tooltip label="Limpar escopo da pasta">
              <button
                className="search-scope-clear"
                aria-label="Limpar escopo da pasta"
                onClick={() => onClearScope?.()}
              >
                <Codicon name="close" size={12} />
              </button>
            </Tooltip>
          </span>
        </div>
      )}

      <div className="search-results">
        {!rootPath ? (
          <div className="search-empty">Abra uma pasta para pesquisar.</div>
        ) : error ? (
          <div className="search-empty" role="alert">
            {error}
          </div>
        ) : status === "done" && files.length === 0 ? (
          <div className="search-empty">Nenhum resultado.</div>
        ) : (
          <>
            {status === "searching" && (
              <div className="search-progress" role="status">
                <Codicon name="loading" size={12} spin /> Pesquisando…
              </div>
            )}
            {files.length > 0 && (
              <div className="search-summary">
                {totalMatches} resultado(s) em {files.length} arquivo(s)
                {summary?.limitHit ? " · limite atingido" : ""}
                {status === "done" && summary ? ` · ${summary.elapsedMs} ms` : ""}
              </div>
            )}
            {files.map((file) => (
              <FileGroup key={file.path} file={file} onOpenMatch={onOpenMatch} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One file's results: a header row plus its matching lines. Memoized so that as
 * new file batches stream in, the already-rendered groups aren't re-processed
 * (their `file` is stable and `onOpenMatch` is a stable callback).
 */
const FileGroup = memo(function FileGroup({
  file,
  onOpenMatch,
}: {
  file: FileMatches;
  onOpenMatch: (
    node: FileNode,
    line: number,
    startColumn: number,
    endColumn: number
  ) => void;
}) {
  return (
    <div className="search-file-group">
      <div className="search-file-name" title={file.path}>
        <FileIcon path={file.path} className="search-file-icon" />
        {file.name}
      </div>
      {file.matches.map((m: LineMatch, i) => {
        // First match on the line → 1-based Monaco columns for the selection.
        const first = m.ranges[0];
        const startColumn = (first ? first[0] : 0) + 1;
        const endColumn = (first ? first[1] : 0) + 1;
        return (
          <div
            key={i}
            className="search-match-row"
            title={`${file.path}:${m.line}`}
            onClick={() =>
              onOpenMatch(
                { name: file.name, path: file.path, isDir: false },
                m.line,
                startColumn,
                endColumn
              )
            }
          >
            <span className="search-match-line">{m.line}</span>
            <span className="search-match-text">
              {highlightLine(m.text, m.ranges)}
            </span>
          </div>
        );
      })}
    </div>
  );
});
