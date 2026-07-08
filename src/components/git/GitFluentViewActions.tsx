import type { GitFluentTab } from "../../git/gitFluent";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Tooltip } from "../Tooltip";

interface GitFluentViewActionsProps {
  activeTab: GitFluentTab;
  busy: boolean;
  hasUpstream: boolean;
  onCreateSuggestedBranch: () => void;
  onRefreshBranches: () => void;
  onAddRemote: () => void;
  onRefreshRemotes: () => void;
  onRefreshGraph: () => void;
  onRefreshStashes: () => void;
  onCreateWorktree: () => void;
  onPruneWorktrees: () => void;
  onRefreshCompare: () => void;
  onRefreshHistory: () => void;
  onRefreshRepository: () => void;
}

function ActionButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconAction;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className="git-link-btn"
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
      >
        <Codicon name={icon} />
      </button>
    </Tooltip>
  );
}

export function GitFluentViewActions({
  activeTab,
  busy,
  hasUpstream,
  onCreateSuggestedBranch,
  onRefreshBranches,
  onAddRemote,
  onRefreshRemotes,
  onRefreshGraph,
  onRefreshStashes,
  onCreateWorktree,
  onPruneWorktrees,
  onRefreshCompare,
  onRefreshHistory,
  onRefreshRepository,
}: GitFluentViewActionsProps) {
  switch (activeTab) {
    case "branches":
      return (
        <>
          <ActionButton
            label="Criar branch sugerida"
            icon="add"
            disabled={busy}
            onClick={onCreateSuggestedBranch}
          />
          <ActionButton
            label="Atualizar branches"
            icon="refresh"
            disabled={busy}
            onClick={onRefreshBranches}
          />
        </>
      );
    case "remotes":
      return (
        <>
          <ActionButton label="Adicionar remoto" icon="add" disabled={busy} onClick={onAddRemote} />
          <ActionButton
            label="Atualizar remotos"
            icon="refresh"
            disabled={busy}
            onClick={onRefreshRemotes}
          />
        </>
      );
    case "tags":
    case "contributors":
    case "graph":
      return (
        <ActionButton
          label="Atualizar grafo"
          icon="refresh"
          disabled={busy}
          onClick={onRefreshGraph}
        />
      );
    case "stashes":
      return (
        <ActionButton
          label="Atualizar stashes"
          icon="refresh"
          disabled={busy}
          onClick={onRefreshStashes}
        />
      );
    case "worktrees":
      return (
        <>
          <ActionButton label="Nova worktree" icon="add" disabled={busy} onClick={onCreateWorktree} />
          <ActionButton
            label="Limpar referências órfãs"
            icon="trash"
            disabled={busy}
            onClick={onPruneWorktrees}
          />
        </>
      );
    case "compare":
      return (
        <ActionButton
          label="Atualizar comparação"
          icon="refresh"
          disabled={busy || !hasUpstream}
          onClick={onRefreshCompare}
        />
      );
    case "history":
      return (
        <ActionButton
          label="Atualizar histórico"
          icon="refresh"
          disabled={busy}
          onClick={onRefreshHistory}
        />
      );
    case "repositories":
      return (
        <ActionButton
          label="Atualizar repositório"
          icon="refresh"
          disabled={busy}
          onClick={onRefreshRepository}
        />
      );
    default:
      return null;
  }
}
