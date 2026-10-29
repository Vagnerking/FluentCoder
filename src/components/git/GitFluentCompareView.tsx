import type { MouseEvent } from "react";
import type { GitCommit, GitStatus, GitUpstreamComparison } from "../../types";
import { Codicon } from "../../icons/codicons/Codicon";

interface GitFluentCompareViewProps {
  status?: GitStatus | null;
  comparison?: GitUpstreamComparison | null;
  busy: boolean;
  onPull: () => void;
  onPush: () => void;
  onOpenCommitMenu: (event: MouseEvent, commit: GitCommit) => void;
  onCopyHash: (hash: string) => void;
  onOpenRemote: (url?: string) => void;
}

interface CommitColumnProps {
  title: string;
  icon: "gitPush" | "gitPull";
  emptyLabel: string;
  direction: "ahead" | "behind";
  commits: GitCommit[];
  onOpenCommitMenu: (event: MouseEvent, commit: GitCommit) => void;
  onCopyHash: (hash: string) => void;
  onOpenRemote: (url?: string) => void;
}

function CommitColumn({
  title,
  icon,
  emptyLabel,
  direction,
  commits,
  onOpenCommitMenu,
  onCopyHash,
  onOpenRemote,
}: CommitColumnProps) {
  return (
    <div className="git-compare-column">
      <div className="git-compare-title">
        <Codicon name={icon} size={12} />
        {title}
        <span>{commits.length}</span>
      </div>
      {commits.length === 0 ? (
        <div className="git-compare-empty">{emptyLabel}</div>
      ) : (
        commits.map((commit) => (
          <div
            className="git-compare-row"
            key={`${direction}:${commit.hash}`}
            title={commit.hash}
            onContextMenu={(event) => onOpenCommitMenu(event, commit)}
          >
            <Codicon name="gitCommit" size={12} />
            <div>
              <span>{commit.subject}</span>
              <small>
                {commit.short} · {commit.isCurrentUser ? "You" : commit.author} · {commit.date}
              </small>
            </div>
            <button type="button" title="Copiar hash" onClick={() => onCopyHash(commit.hash)}>
              <Codicon name="copy" size={12} />
            </button>
            <button
              type="button"
              title={commit.remoteUrl ? "Abrir commit remoto" : "Sem URL remota"}
              disabled={!commit.remoteUrl}
              onClick={() => onOpenRemote(commit.remoteUrl)}
            >
              <Codicon name="remote" size={12} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

export function GitFluentCompareView({
  status,
  comparison,
  busy,
  onPull,
  onPush,
  onOpenCommitMenu,
  onCopyHash,
  onOpenRemote,
}: GitFluentCompareViewProps) {
  const hasUpstream = Boolean(status?.hasUpstream);

  return (
    <div className="git-compare-panel">
      {!hasUpstream ? (
        <div className="git-compare-empty">Configure um upstream para comparar esta branch.</div>
      ) : !comparison ? (
        <div className="git-compare-empty">Carregando comparação...</div>
      ) : comparison.ahead.length === 0 && comparison.behind.length === 0 ? (
        <div className="git-compare-empty">Up to date com {comparison.upstream}.</div>
      ) : (
        <div className="git-compare-columns">
          <CommitColumn
            title="Saindo"
            icon="gitPush"
            emptyLabel="Nada para enviar."
            direction="ahead"
            commits={comparison.ahead}
            onOpenCommitMenu={onOpenCommitMenu}
            onCopyHash={onCopyHash}
            onOpenRemote={onOpenRemote}
          />
          <CommitColumn
            title="Entrando"
            icon="gitPull"
            emptyLabel="Nada para baixar."
            direction="behind"
            commits={comparison.behind}
            onOpenCommitMenu={onOpenCommitMenu}
            onCopyHash={onCopyHash}
            onOpenRemote={onOpenRemote}
          />
        </div>
      )}

      {hasUpstream && (
        <div className="git-compare-actions">
          <button type="button" disabled={busy} onClick={onPull}>
            <Codicon name="gitPull" size={12} />
            Pull
          </button>
          <button type="button" disabled={busy} onClick={onPush}>
            <Codicon name="gitPush" size={12} />
            Push
          </button>
        </div>
      )}
    </div>
  );
}
