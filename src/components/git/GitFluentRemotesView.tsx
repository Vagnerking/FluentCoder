import { useMemo, useState, type MouseEvent } from "react";
import {
  buildGitFluentRemoteTree,
  filterGitFluentRemoteTree,
  gitFluentRemoteBranchDisplayName,
  type GitFluentRefLayout,
} from "../../git/gitFluent";
import type { GitBranchInfo, GitRemoteInfo } from "../../types";
import { Codicon } from "../../icons/codicons/Codicon";
import { Tooltip } from "../Tooltip";
import { GitFluentFilterInput } from "./GitFluentFilterInput";

interface GitFluentRemotesViewProps {
  remotes: GitRemoteInfo[];
  remoteBranches: GitBranchInfo[];
  collapsedGroups: Set<string>;
  branchLayout: GitFluentRefLayout;
  busy: boolean;
  onToggleGroup: (key: string) => void;
  onOpenRemoteMenu: (event: MouseEvent, remote: GitRemoteInfo) => void;
  onOpenRemoteBranchMenu: (event: MouseEvent, branch: GitBranchInfo) => void;
  onFetchRemote: (remote: GitRemoteInfo) => void;
  onCheckoutRemoteBranch: (branch: GitBranchInfo) => void;
}

export function GitFluentRemotesView({
  remotes,
  remoteBranches,
  collapsedGroups,
  branchLayout,
  busy,
  onToggleGroup,
  onOpenRemoteMenu,
  onOpenRemoteBranchMenu,
  onFetchRemote,
  onCheckoutRemoteBranch,
}: GitFluentRemotesViewProps) {
  const [query, setQuery] = useState("");
  const remoteTree = useMemo(
    () => buildGitFluentRemoteTree(remotes, remoteBranches),
    [remotes, remoteBranches]
  );
  const filteredRemoteTree = useMemo(
    () => filterGitFluentRemoteTree(remoteTree, query),
    [remoteTree, query]
  );
  const trimmedQuery = query.trim();
  const hasFilter = trimmedQuery.length > 0;
  const branchCount = filteredRemoteTree.reduce((total, remoteNode) => total + remoteNode.branches.length, 0);

  return (
    <div className="git-fluent-list" role="tabpanel">
      {remoteTree.length === 0 ? (
        <div className="git-fluent-empty">Nenhum remoto carregado.</div>
      ) : (
        <div className="git-remote-list" role="tree" aria-label="Remotos">
          <GitFluentFilterInput
            value={query}
            placeholder="Filtrar remotos"
            label="Filtrar remotos do Git Fluent"
            onChange={setQuery}
          />
          {filteredRemoteTree.length === 0 && (
            <div className="git-fluent-empty">Nenhum remoto encontrado para "{trimmedQuery}".</div>
          )}
          {filteredRemoteTree.length > 0 && (
            <div className="git-ref-section-header">
              <span>
                <Codicon name="gitRemote" size={12} />
                Remotos
              </span>
              <small>
                {filteredRemoteTree.length}
                {branchCount > 0 ? ` / ${branchCount}` : ""}
              </small>
            </div>
          )}
          {filteredRemoteTree.map((remoteNode) => {
            const collapsed = !hasFilter && collapsedGroups.has(remoteNode.key);
            const remote = remoteNode.remote;
            return (
              <div className="git-remote-tree-group" key={remoteNode.key}>
                <div
                  className={`git-remote-tree-header${remoteNode.configured ? "" : " muted"}`}
                  title={remoteNode.fetchUrl ?? remoteNode.name}
                  onContextMenu={(event) => remote && onOpenRemoteMenu(event, remote)}
                >
                  <button
                    type="button"
                    className="git-remote-tree-toggle"
                    aria-expanded={!collapsed}
                    onClick={() => onToggleGroup(remoteNode.key)}
                  >
                    <Codicon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
                    <Codicon name="gitRemote" size={13} />
                    <span className="git-remote-tree-name">
                      <span>{remoteNode.name}</span>
                      {remoteNode.fetchUrl && (
                        <em>
                          {remoteProviderLabel(remoteNode.fetchUrl)} · {remoteUrlLabel(remoteNode.fetchUrl)}
                        </em>
                      )}
                    </span>
                    <small>{remoteNode.branches.length}</small>
                  </button>
                  <div className="git-remote-tree-actions">
                    <Tooltip label={remote ? `Fetch ${remote.name}` : "Remote não configurado"}>
                      <button
                        className="git-file-action"
                        disabled={busy || !remote}
                        aria-label={remote ? `Fetch ${remote.name}` : "Remote não configurado"}
                        onClick={() => remote && onFetchRemote(remote)}
                      >
                        <Codicon name="refresh" size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label={remote ? "Mais ações" : "Remote não configurado"}>
                      <button
                        className="git-file-action"
                        disabled={busy || !remote}
                        aria-label={remote ? `Mais ações para ${remote.name}` : "Remote não configurado"}
                        onClick={(event) => remote && onOpenRemoteMenu(event, remote)}
                      >
                        <Codicon name="filterFiles" size={13} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
                {!collapsed && remoteNode.branches.length === 0 && (
                  <div className="git-fluent-empty nested">Nenhuma branch remota carregada.</div>
                )}
                {!collapsed && renderRemoteBranches({
                  remoteNode,
                  branchLayout,
                  busy,
                  onCheckoutRemoteBranch,
                  onOpenRemoteBranchMenu,
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function remoteUrlLabel(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.host}${parsed.pathname.replace(/\.git$/, "")}`;
  } catch {
    return trimmed.replace(/\.git$/, "");
  }
}

function remoteProviderLabel(url: string): string {
  const normalized = url.trim().toLowerCase();
  if (normalized.includes("github.com")) return "GitHub";
  if (normalized.includes("gitlab.com")) return "GitLab";
  if (normalized.includes("bitbucket.org")) return "Bitbucket";
  return "Git";
}

function renderRemoteBranches({
  remoteNode,
  branchLayout,
  busy,
  onCheckoutRemoteBranch,
  onOpenRemoteBranchMenu,
}: {
  remoteNode: ReturnType<typeof buildGitFluentRemoteTree>[number];
  branchLayout: GitFluentRefLayout;
  busy: boolean;
  onCheckoutRemoteBranch: (branch: GitBranchInfo) => void;
  onOpenRemoteBranchMenu: (event: MouseEvent, branch: GitBranchInfo) => void;
}) {
  const rows = branchLayout === "tree"
    ? groupRemoteBranches(remoteNode.branches, remoteNode)
    : [{ key: `${remoteNode.key}:__flat`, label: "", grouped: false, branches: remoteNode.branches }];

  return rows.map((group) => (
    <div className="git-remote-branch-group" key={group.key}>
      {group.grouped && (
        <div className="git-ref-tree-header git-remote-branch-namespace">
          <Codicon name="chevronDown" size={12} />
          <Codicon name="gitBranch" size={13} />
          <span>{group.label}</span>
          <small>{group.branches.length}</small>
        </div>
      )}
      {group.branches.map((branch) => {
        const displayName = group.grouped
          ? gitFluentRemoteBranchDisplayName(remoteNode, branch).slice(group.label.length + 1)
          : gitFluentRemoteBranchDisplayName(remoteNode, branch);
        return (
          <div
            key={`fluent-remote-branch-${branch.name}`}
            role="treeitem"
            tabIndex={0}
            className={`git-ref-row remote${branchLayout === "tree" ? " nested" : ""}${group.grouped ? " namespace-child" : ""}`}
            title={`${branch.name}\n${branch.subject}`}
            onContextMenu={(event) => onOpenRemoteBranchMenu(event, branch)}
          >
            <Codicon name="gitBranch" size={13} />
            <div className="git-ref-main">
              <span className="git-ref-name">{displayName || branch.name}</span>
              <span className="git-ref-meta">
                {branch.date}
                {branch.author ? ` · ${branch.author}` : ""}
              </span>
            </div>
            <span className="git-ref-actions">
              <Tooltip label="Criar branch local rastreada">
                <button
                  className="git-file-action"
                  aria-label={`Criar branch local para ${branch.name}`}
                  disabled={busy}
                  onClick={() => onCheckoutRemoteBranch(branch)}
                >
                  <Codicon name="gitPull" size={13} />
                </button>
              </Tooltip>
              <Tooltip label="Mais ações">
                <button
                  className="git-file-action"
                  aria-label={`Mais ações para ${branch.name}`}
                  onClick={(event) => onOpenRemoteBranchMenu(event, branch)}
                >
                  <Codicon name="filterFiles" size={13} />
                </button>
              </Tooltip>
            </span>
          </div>
        );
      })}
    </div>
  ));
}

function groupRemoteBranches(
  branches: GitBranchInfo[],
  remoteNode: ReturnType<typeof buildGitFluentRemoteTree>[number]
) {
  const groups = new Map<string, { key: string; label: string; grouped: boolean; branches: GitBranchInfo[] }>();
  for (const branch of branches) {
    const display = gitFluentRemoteBranchDisplayName(remoteNode, branch);
    const [head, ...tail] = display.split("/");
    const grouped = tail.length > 0;
    const label = grouped ? head : "";
    const key = grouped ? `${remoteNode.key}:ns:${label}` : `${remoteNode.key}:__root`;
    const group = groups.get(key) ?? { key, label, grouped, branches: [] };
    group.branches.push(branch);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.grouped !== b.grouped) return a.grouped ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}
