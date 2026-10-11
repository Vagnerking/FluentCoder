import { IconButton } from "../ui/IconButton";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { GitRevisionDiffTarget } from "../../api";
import type { GitCommitFile, GitGraphCommit } from "../../types";
import { commitFileStatusClass, fileName, joinRepoPath } from "../../git/gitUi";
import type { GitFluentGraphRow } from "../../git/gitFluent";
import {
  filterGitFluentGraphRows,
  graphRefIcon,
  graphRefKind,
  graphRefLabel,
  visibleGitFluentGraphRefs,
} from "../../git/gitFluent";
import { Codicon } from "../../icons/codicons/Codicon";
import { GitFluentFilterInput } from "./GitFluentFilterInput";

/** Arquivos de um commit: carregando, lista ou erro. */
export type GitCommitFilesState = "loading" | GitCommitFile[] | { error: string };

interface GitFluentGraphViewProps {
  rows: GitFluentGraphRow[];
  selectedHash: string | null;
  /** Arquivos por hash (`gitCommitFiles`), mostrados sob o commit selecionado. */
  commitFiles?: Record<string, GitCommitFilesState>;
  rootPath: string;
  connId?: string;
  onToggleCommit: (hash: string) => void;
  onOpenCommitMenu: (event: MouseEvent, commit: GitGraphCommit) => void;
  onOpenFile: (path: string, name: string) => void;
  onOpenRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget,
    rootPath?: string,
    connId?: string
  ) => void;
}

export function GitFluentGraphView({
  rows,
  selectedHash,
  commitFiles,
  rootPath,
  connId,
  onToggleCommit,
  onOpenCommitMenu,
  onOpenFile,
  onOpenRevisionDiff,
}: GitFluentGraphViewProps) {
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(40);
  const deferredQuery = useDeferredValue(query);
  const trimmedQuery = deferredQuery.trim();
  const visibleRows = useMemo(() => filterGitFluentGraphRows(rows, deferredQuery), [rows, deferredQuery]);
  const renderedRows = useMemo(() => visibleRows.slice(0, visibleLimit), [visibleRows, visibleLimit]);
  const hasFilter = trimmedQuery.length > 0;
  const toggleCommitRef = useRef(onToggleCommit);
  const openCommitMenuRef = useRef(onOpenCommitMenu);

  useEffect(() => {
    toggleCommitRef.current = onToggleCommit;
  }, [onToggleCommit]);

  useEffect(() => {
    openCommitMenuRef.current = onOpenCommitMenu;
  }, [onOpenCommitMenu]);

  const handleToggleCommit = useCallback((hash: string) => {
    toggleCommitRef.current(hash);
  }, []);

  const handleOpenCommitMenu = useCallback((event: MouseEvent, commit: GitGraphCommit) => {
    openCommitMenuRef.current(event, commit);
  }, []);

  useEffect(() => {
    setVisibleLimit(40);
  }, [trimmedQuery, rows]);

  return (
    <div className="git-graph-list git-fluent-graph-list" role="tabpanel" aria-label="Grafo Git Fluent">
      {rows.length === 0 ? (
        <div className="git-fluent-empty">Nenhum commit carregado no grafo.</div>
      ) : (
        <>
          <GitFluentFilterInput
            value={query}
            placeholder="Filtrar commits"
            label="Filtrar commits do grafo"
            onChange={setQuery}
          />
          {renderedRows.length === 0 ? (
            <div className="git-fluent-empty">Nenhum commit encontrado para "{trimmedQuery}".</div>
          ) : null}
          {renderedRows.map((row) => {
            const selected = selectedHash === row.commit.hash;
            const files = selected ? commitFiles?.[row.commit.hash] : undefined;
            return (
              <div key={`fluent-graph-${row.commit.hash}`} className="git-fluent-graph-entry">
                <GitFluentGraphRowItem
                  row={row}
                  selected={selected}
                  onToggleCommit={handleToggleCommit}
                  onOpenCommitMenu={handleOpenCommitMenu}
                />
                {files !== undefined && (
                  <GitCommitFilesList
                    commit={row.commit}
                    files={files}
                    rootPath={rootPath}
                    connId={connId}
                    onOpenFile={onOpenFile}
                    onOpenRevisionDiff={onOpenRevisionDiff}
                  />
                )}
              </div>
            );
          })}
          {visibleRows.length > renderedRows.length ? (
            <button
              type="button"
              className="git-fluent-more-row"
              onClick={() => setVisibleLimit((current) => Math.min(current + 40, visibleRows.length))}
            >
              <Codicon name="filterFiles" size={13} />
              <span>{hasFilter ? "Mostrar mais commits filtrados" : "Mostrar mais commits"}</span>
              <small>
                {renderedRows.length}/{visibleRows.length}
              </small>
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

interface GitFluentGraphRowItemProps {
  row: GitFluentGraphRow;
  selected: boolean;
  onToggleCommit: (hash: string) => void;
  onOpenCommitMenu: (event: MouseEvent, commit: GitGraphCommit) => void;
}

const GitFluentGraphRowItem = memo(function GitFluentGraphRowItem({
  row,
  selected,
  onToggleCommit,
  onOpenCommitMenu,
}: GitFluentGraphRowItemProps) {
  const { commit } = row;
  const visibleRefs = useMemo(() => visibleGitFluentGraphRefs(row.refs), [row.refs]);
  const graphRowStyle = useMemo(
    () =>
      ({
        "--git-graph-color": row.color,
        "--git-graph-width": `${row.graphWidth}px`,
      }) as CSSProperties,
    [row.color, row.graphWidth]
  );
  const handleToggle = useCallback(() => onToggleCommit(commit.hash), [commit.hash, onToggleCommit]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onToggleCommit(commit.hash);
    },
    [commit.hash, onToggleCommit]
  );
  const handleContextMenu = useCallback(
    (event: MouseEvent) => onOpenCommitMenu(event, commit),
    [commit, onOpenCommitMenu]
  );
  const handleActionClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onOpenCommitMenu(event, commit);
    },
    [commit, onOpenCommitMenu]
  );

  return (
    <article
      className={`git-graph-row git-fluent-graph-row${row.isHead ? " head" : ""}${row.isMerge ? " merge" : ""}${selected ? " selected" : ""}`}
      style={graphRowStyle}
      title={commit.hash}
      aria-label={`${commit.subject}, ${commit.author}, ${commit.short}`}
      role="button"
      tabIndex={0}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <div className="git-graph-rail" aria-hidden="true">
        <svg
          className="git-graph-svg"
          viewBox={`0 0 ${row.graphWidth} 22`}
          preserveAspectRatio="none"
        >
          {row.lanes.map((lane) => (
            <line
              key={`lane-${commit.hash}-${lane.index}`}
              className="git-graph-svg-lane"
              x1={lane.x}
              y1={lane.above ? 0 : 11}
              x2={lane.x}
              y2={lane.below ? 22 : 11}
              stroke={lane.color}
            />
          ))}
          {row.connectors.map((connector, connectorIndex) => (
            <path
              key={`connector-${commit.hash}-${connectorIndex}`}
              className={`git-graph-svg-connector ${connector.kind}`}
              d={`M ${connector.fromX} 11 C ${connector.fromX} 17 ${connector.toX} 16 ${connector.toX} 22`}
              stroke={connector.color}
            />
          ))}
        </svg>
        <span
          className="git-graph-dot"
          style={{ left: row.nodeX - 5, borderColor: row.color }}
        />
      </div>
      <div className="git-graph-main">
        <div className="git-graph-subject-line">
          <span className="git-graph-subject">
            {row.isMerge && <Codicon name="gitMerge" size={12} />}
            <span>{commit.subject}</span>
          </span>
          <span className="git-graph-meta">
            <span>{commit.isCurrentUser ? "You" : commit.author}</span>
            <span>{commit.date}</span>
          </span>
        </div>
      </div>
      {visibleRefs.length > 0 && (
        <div className="git-graph-refs git-fluent-graph-refs">
          {visibleRefs.map((ref) => (
            <span
              key={`${commit.hash}:fluent:${ref}`}
              className={`git-graph-ref ${graphRefKind(ref)}`}
              title={ref}
            >
              <Codicon name={graphRefIcon(ref)} size={10} />
              {graphRefLabel(ref)}
            </span>
          ))}
        </div>
      )}
      <div className="git-graph-actions">
        <IconButton
          icon="filterFiles"
          size="sm"
          label="Mais ações do commit"
          className="git-file-action"
          onClick={handleActionClick}
        />
      </div>
    </article>
  );
});

function GitCommitFilesList({
  commit,
  files,
  rootPath,
  connId,
  onOpenFile,
  onOpenRevisionDiff,
}: {
  commit: GitGraphCommit;
  files: GitCommitFilesState;
  rootPath: string;
  connId?: string;
  onOpenFile: (path: string, name: string) => void;
  onOpenRevisionDiff?: GitFluentGraphViewProps["onOpenRevisionDiff"];
}) {
  if (files === "loading") {
    return <div className="git-graph-commit-files is-empty">Carregando arquivos…</div>;
  }
  if (!Array.isArray(files)) {
    return <div className="git-graph-commit-files is-empty is-error">{files.error}</div>;
  }
  if (files.length === 0) {
    return <div className="git-graph-commit-files is-empty">Nenhum arquivo alterado neste commit.</div>;
  }
  return (
    <ul className="git-graph-commit-files" aria-label={`Arquivos do commit ${commit.short}`}>
      {files.map((file) => {
        const absolutePath = joinRepoPath(rootPath, file.path);
        const open = () => {
          if (onOpenRevisionDiff) {
            onOpenRevisionDiff(absolutePath, commit.hash, commit.short, "previous", rootPath, connId);
          } else {
            onOpenFile(absolutePath, fileName(file.path));
          }
        };
        return (
          <li key={`${commit.hash}:${file.path}`}>
            <button
              type="button"
              className="git-graph-commit-file"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={open}
            >
              <span className={`git-commit-file-status ${commitFileStatusClass(file.status)}`}>
                {file.status}
              </span>
              <span className="git-graph-commit-file-name">{fileName(file.path)}</span>
              <span className="git-graph-commit-file-dir">
                {file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}
              </span>
              <span className="git-graph-commit-file-stats">
                {file.additions ? <span className="add">+{file.additions}</span> : null}
                {file.deletions ? <span className="del">-{file.deletions}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
