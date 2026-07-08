import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { GitCommit } from "../../types";
import { Codicon } from "../../icons/codicons/Codicon";
import { Tooltip } from "../Tooltip";
import { GitFluentFilterInput } from "./GitFluentFilterInput";

interface GitFluentHistoryViewProps {
  commits: GitCommit[];
  scope: {
    type: "repository" | "file" | "line";
    label: string;
    detail?: string;
    onClear?: () => void;
  };
  visibleLimit?: number;
  onSelectCommit: (commit: GitCommit) => void;
  onOpenCommitMenu: (event: MouseEvent, commit: GitCommit) => void;
  onOpenGraph: () => void;
}

interface TimelineGroup {
  key: string;
  label: string;
  commits: GitCommit[];
}

function timelinePeriod(date: string): { key: string; label: string } {
  const value = date.toLowerCase();
  if (
    /agora|segundo|minuto|hora|hoje|second|minute|hour|today/.test(value)
  ) {
    return { key: "today", label: "Hoje" };
  }
  if (/ontem|yesterday/.test(value)) {
    return { key: "yesterday", label: "Ontem" };
  }
  if (/\b\d+\s+dias?\b|\b\d+\s+days?\b/.test(value)) {
    return { key: "days", label: "Últimos dias" };
  }
  if (/semana|week/.test(value)) {
    return { key: "weeks", label: "Últimas semanas" };
  }
  if (/m[eê]s|meses|month/.test(value)) {
    return { key: "months", label: "Últimos meses" };
  }
  if (/ano|year/.test(value)) {
    return { key: "years", label: "Mais antigo" };
  }
  return { key: "recent", label: "Recentes" };
}

function groupTimelineCommits(commits: GitCommit[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  for (const commit of commits) {
    const period = timelinePeriod(commit.date);
    const group = groups.get(period.key) ?? {
      key: period.key,
      label: period.label,
      commits: [],
    };
    group.commits.push(commit);
    groups.set(period.key, group);
  }
  return [...groups.values()];
}

function commitMatchesQuery(commit: GitCommit, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    commit.hash,
    commit.short,
    commit.subject,
    commit.author,
    commit.authorEmail,
    commit.date,
    commit.isCurrentUser ? "you voce você meu meus" : "",
    commit.filesChanged,
    commit.additions,
    commit.deletions,
  ].some((part) => String(part ?? "").toLowerCase().includes(normalizedQuery));
}

export function GitFluentHistoryView({
  commits,
  scope,
  visibleLimit = 24,
  onSelectCommit,
  onOpenCommitMenu,
  onOpenGraph,
}: GitFluentHistoryViewProps) {
  const [query, setQuery] = useState("");
  const [renderLimit, setRenderLimit] = useState(visibleLimit);
  const deferredQuery = useDeferredValue(query);
  const trimmedQuery = deferredQuery.trim();
  const hasFilter = trimmedQuery.length > 0;
  const filteredCommits = useMemo(
    () => commits.filter((commit) => commitMatchesQuery(commit, deferredQuery)),
    [commits, deferredQuery]
  );
  const visibleCommits = useMemo(() => filteredCommits.slice(0, renderLimit), [filteredCommits, renderLimit]);
  const remaining = Math.max(0, filteredCommits.length - visibleCommits.length);
  const repositoryScope = scope.type === "repository";
  const groups = useMemo(() => groupTimelineCommits(visibleCommits), [visibleCommits]);
  const selectCommitRef = useRef(onSelectCommit);
  const openCommitMenuRef = useRef(onOpenCommitMenu);

  useEffect(() => {
    selectCommitRef.current = onSelectCommit;
  }, [onSelectCommit]);

  useEffect(() => {
    openCommitMenuRef.current = onOpenCommitMenu;
  }, [onOpenCommitMenu]);

  const handleSelectCommit = useCallback((commit: GitCommit) => {
    selectCommitRef.current(commit);
  }, []);

  const handleOpenCommitMenu = useCallback((event: MouseEvent, commit: GitCommit) => {
    openCommitMenuRef.current(event, commit);
  }, []);

  useEffect(() => {
    setRenderLimit(visibleLimit);
  }, [trimmedQuery, commits, visibleLimit]);

  return (
    <div className="git-fluent-list git-fluent-commit-list" role="tabpanel" aria-label="Timeline do Git Fluent">
      <div className={`git-fluent-history-scope ${scope.type}`}>
        <Codicon
          name={
            scope.type === "line"
              ? "timeline"
              : scope.type === "file"
                ? "fileHistory"
                : "gitCommit"
          }
          size={13}
        />
        <span>
          <strong>{scope.label}</strong>
          {scope.detail && <small>{scope.detail}</small>}
        </span>
        {scope.onClear && scope.type !== "repository" && (
          <button type="button" title="Voltar ao histórico do repositório" onClick={scope.onClear}>
            <Codicon name="close" size={12} />
          </button>
        )}
      </div>
      {repositoryScope && (
        <button
          type="button"
          className="git-fluent-history-jump"
          onClick={onOpenGraph}
        >
          <Codicon name="graph" size={15} />
          <span>
            <strong>Grafo completo</strong>
            <small>{commits.length ? `${commits.length} commits na timeline` : "Carregar grafo do repositório"}</small>
          </span>
          <Codicon name="chevronRight" size={12} />
        </button>
      )}
      {commits.length > 0 && (
        <GitFluentFilterInput
          value={query}
          placeholder="Filtrar timeline"
          label="Filtrar commits da timeline"
          onChange={setQuery}
        />
      )}
      {commits.length === 0 ? (
        <div className="git-fluent-empty">Nenhum commit carregado.</div>
      ) : visibleCommits.length === 0 ? (
        <div className="git-fluent-empty">Nenhum commit encontrado para "{trimmedQuery}".</div>
      ) : (
        <>
          {groups.map((group) => (
            <section className="git-fluent-timeline-group" key={`timeline-${group.key}`}>
              <div className="git-fluent-timeline-heading">
                <Codicon name="timeline" size={12} />
                <span>{group.label}</span>
                <small>{group.commits.length}</small>
              </div>
              {group.commits.map((commit, index) => (
                <GitFluentTimelineRow
                  key={`fluent-history-${commit.hash}`}
                  commit={commit}
                  latest={index === 0}
                  onSelectCommit={handleSelectCommit}
                  onOpenCommitMenu={handleOpenCommitMenu}
                />
              ))}
            </section>
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="git-fluent-more-row"
              onClick={() => setRenderLimit((current) => Math.min(current + visibleLimit, filteredCommits.length))}
            >
              <Codicon name="timeline" size={13} />
              <span>{hasFilter ? "Mostrar mais filtrados" : "Mostrar mais na timeline"}</span>
              <small>
                {visibleCommits.length}/{filteredCommits.length}
              </small>
            </button>
          )}
        </>
      )}
    </div>
  );
}

interface GitFluentTimelineRowProps {
  commit: GitCommit;
  latest: boolean;
  onSelectCommit: (commit: GitCommit) => void;
  onOpenCommitMenu: (event: MouseEvent, commit: GitCommit) => void;
}

const GitFluentTimelineRow = memo(function GitFluentTimelineRow({
  commit,
  latest,
  onSelectCommit,
  onOpenCommitMenu,
}: GitFluentTimelineRowProps) {
  const handleSelect = useCallback(() => onSelectCommit(commit), [commit, onSelectCommit]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelectCommit(commit);
    },
    [commit, onSelectCommit]
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
    <div
      className="git-fluent-timeline-row"
      title={commit.hash}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <span className="git-fluent-timeline-rail" aria-hidden="true">
        <span className={`git-fluent-timeline-dot${latest ? " latest" : ""}`} />
      </span>
      <span className="git-fluent-avatar" aria-hidden="true">
        {commit.avatarUrl ? (
          <img src={commit.avatarUrl} alt="" />
        ) : (
          (commit.author || "?").slice(0, 1).toUpperCase()
        )}
      </span>
      <span className="git-fluent-commit-main">
        <span className="git-fluent-commit-subject">{commit.subject}</span>
        <span className="git-fluent-commit-meta">
          {commit.isCurrentUser ? "You" : commit.author} · {commit.date}
        </span>
      </span>
      {Boolean(commit.filesChanged || commit.additions || commit.deletions) && (
        <span className="git-fluent-commit-stats">
          {commit.filesChanged ? `${commit.filesChanged} arq.` : ""}
          {commit.additions ? ` +${commit.additions}` : ""}
          {commit.deletions ? ` -${commit.deletions}` : ""}
        </span>
      )}
      <code>{commit.short}</code>
      <span className="git-fluent-timeline-actions">
        <Tooltip label="Mais ações do commit">
          <button
            type="button"
            className="git-file-action"
            aria-label={`Mais ações para ${commit.short}`}
            onClick={handleActionClick}
          >
            <Codicon name="filterFiles" size={13} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
});
