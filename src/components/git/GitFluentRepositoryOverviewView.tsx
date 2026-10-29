import type { MouseEvent } from "react";
import type {
  GitBranchInfo,
  GitCommit,
  GitRemoteInfo,
  GitStashEntry,
  GitStatus,
  GitWorktreeInfo,
} from "../../types";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Codicon } from "../../icons/codicons/Codicon";
import type {
  GitFluentContributor,
  GitFluentTab,
  GitFluentTagRef,
} from "../../git/gitFluent";

interface GitFluentRepositoryOverviewViewProps {
  repositoryPath: string;
  repositoryName: string;
  repositoryPathLabel: string;
  provider?: "local" | "ssh";
  status?: GitStatus | null;
  commits: GitCommit[];
  branches: GitBranchInfo[];
  remoteBranches: GitBranchInfo[];
  remotes: GitRemoteInfo[];
  stashes: GitStashEntry[];
  tags: GitFluentTagRef[];
  contributors: GitFluentContributor[];
  worktrees: GitWorktreeInfo[];
  onSelectTab: (tab: GitFluentTab) => void;
  onCopyRepositoryPath: () => void;
  onOpenRepositoryMenu: (event: MouseEvent) => void;
}

interface OverviewRow {
  tab?: GitFluentTab;
  icon: IconAction;
  label: string;
  detail: string;
  count: number | string;
  current?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

function plural(count: number, singular: string, pluralLabel: string): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function OverviewNavRow({
  row,
  onSelectTab,
}: {
  row: OverviewRow;
  onSelectTab: (tab: GitFluentTab) => void;
}) {
  return (
    <button
      type="button"
      className={`git-repository-row git-repository-nav-row${row.current ? " current" : ""}`}
      disabled={row.disabled}
      title={row.detail}
      onClick={() => {
        if (row.onClick) row.onClick();
        else if (row.tab) onSelectTab(row.tab);
      }}
    >
      <Codicon name={row.icon} size={13} />
      <span>{row.label}</span>
      <small>{row.detail}</small>
      <em>{row.count}</em>
    </button>
  );
}

export function GitFluentRepositoryOverviewView({
  repositoryPath,
  repositoryName,
  repositoryPathLabel,
  provider,
  status,
  commits,
  branches,
  remoteBranches,
  remotes,
  stashes,
  tags,
  contributors,
  worktrees,
  onSelectTab,
  onCopyRepositoryPath,
  onOpenRepositoryMenu,
}: GitFluentRepositoryOverviewViewProps) {
  const providerLabel = provider === "ssh" ? "SSH" : "LOCAL";
  const currentBranch = status?.branch || branches.find((branch) => branch.current)?.name || "sem branch";
  const latestCommit = commits[0];
  const syncLabel = status?.hasUpstream
    ? `${status.behind ?? 0} entrando · ${status.ahead ?? 0} saindo`
    : "sem upstream";
  const branchCount = branches.length + remoteBranches.length;
  const rows: OverviewRow[] = [
    {
      tab: "graph",
      icon: "gitGraph",
      label: "Grafo",
      detail: latestCommit ? `${latestCommit.short} · ${latestCommit.date}` : "commits do repositório",
      count: commits.length,
    },
    {
      tab: "history",
      icon: "timeline",
      label: "Timeline",
      detail: "linha do tempo contextual",
      count: commits.length || "ctx",
    },
    {
      tab: "compare",
      icon: "compareWithSelected",
      label: "Comparar",
      detail: syncLabel,
      count: status?.hasUpstream ? `${status.behind ?? 0}↓ ${status.ahead ?? 0}↑` : "-",
      disabled: !status?.hasUpstream,
    },
    {
      tab: "branches",
      icon: "gitBranch",
      label: "Branches",
      detail: currentBranch,
      count: branchCount,
    },
    {
      tab: "remotes",
      icon: "gitRemote",
      label: "Remotos",
      detail: remotes.length ? remotes.map((remote) => remote.name).slice(0, 2).join(", ") : "nenhum remoto",
      count: remotes.length,
    },
    {
      tab: "worktrees",
      icon: "gitWorktree",
      label: "Worktrees",
      detail: plural(worktrees.length, "worktree", "worktrees"),
      count: worktrees.length,
    },
    {
      tab: "stashes",
      icon: "gitStash",
      label: "Stashes",
      detail: stashes.length ? "alterações guardadas" : "nenhum stash",
      count: stashes.length,
    },
    {
      tab: "tags",
      icon: "tag",
      label: "Tags",
      detail: tags.length ? "refs anotadas no grafo recente" : "nenhuma tag carregada",
      count: tags.length,
    },
    {
      tab: "contributors",
      icon: "gitContributor",
      label: "Pessoas",
      detail: contributors.length ? "autores no grafo recente" : "nenhum contributor carregado",
      count: contributors.length,
    },
  ];

  return (
    <div className="git-fluent-list git-repository-overview" role="tabpanel">
      <button
        type="button"
        className="git-repository-card"
        title={repositoryPath}
        onContextMenu={onOpenRepositoryMenu}
        onClick={onCopyRepositoryPath}
      >
        <Codicon name={provider === "ssh" ? "gitRemote" : "gitRepo"} size={14} />
        <div>
          <span>{repositoryName}</span>
          <small>{repositoryPathLabel}</small>
        </div>
        <span className="git-repository-kind">{providerLabel}</span>
      </button>

      <div className="git-repository-tree">
        {rows.map((row) => (
          <OverviewNavRow
            key={`${row.label}:${row.tab ?? "changes"}`}
            row={row}
            onSelectTab={onSelectTab}
          />
        ))}
      </div>
    </div>
  );
}
