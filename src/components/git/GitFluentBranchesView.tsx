import { useMemo, useState, type MouseEvent } from "react";
import {
  filterGitFluentBranchGroups,
  gitFluentBranchDisplayName,
  type GitFluentBranchGroup,
  type GitFluentRefLayout,
} from "../../git/gitFluent";
import type { GitBranchInfo } from "../../types";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Tooltip } from "../Tooltip";
import { GitFluentFilterInput } from "./GitFluentFilterInput";

interface GitFluentBranchesViewProps {
  localGroups: GitFluentBranchGroup[];
  remoteGroups: GitFluentBranchGroup[];
  collapsedGroups: Set<string>;
  layout: GitFluentRefLayout;
  busy: boolean;
  onToggleGroup: (key: string) => void;
  onOpenBranchMenu: (event: MouseEvent, branch: GitBranchInfo) => void;
  onOpenRemoteBranchMenu: (event: MouseEvent, branch: GitBranchInfo) => void;
  onCheckoutBranch: (branch: GitBranchInfo) => void;
  onCheckoutRemoteBranch: (branch: GitBranchInfo) => void;
}

export function GitFluentBranchesView({
  localGroups,
  remoteGroups,
  collapsedGroups,
  layout,
  busy,
  onToggleGroup,
  onOpenBranchMenu,
  onOpenRemoteBranchMenu,
  onCheckoutBranch,
  onCheckoutRemoteBranch,
}: GitFluentBranchesViewProps) {
  const [query, setQuery] = useState("");
  const normalizedLocalGroups = useMemo(
    () => flattenBranchGroups(localGroups, "local:__list", "Branches", layout),
    [localGroups, layout]
  );
  const normalizedRemoteGroups = useMemo(
    () => flattenBranchGroups(remoteGroups, "remote:__list", "Branches remotas", layout),
    [remoteGroups, layout]
  );
  const filteredLocalGroups = useMemo(
    () => filterGitFluentBranchGroups(normalizedLocalGroups, query),
    [normalizedLocalGroups, query]
  );
  const filteredRemoteGroups = useMemo(
    () => filterGitFluentBranchGroups(normalizedRemoteGroups, query),
    [normalizedRemoteGroups, query]
  );
  const trimmedQuery = query.trim();
  const hasFilter = trimmedQuery.length > 0;
  const empty = localGroups.length === 0 && remoteGroups.length === 0;
  const noMatches = !empty && filteredLocalGroups.length === 0 && filteredRemoteGroups.length === 0;
  const localCount = filteredLocalGroups.reduce((total, group) => total + group.branches.length, 0);
  const remoteCount = filteredRemoteGroups.reduce((total, group) => total + group.branches.length, 0);

  return (
    <div className="git-fluent-list" role="tabpanel">
      {empty ? (
        <div className="git-fluent-empty">Nenhuma branch carregada.</div>
      ) : (
        <div className="git-ref-list" role="tree" aria-label="Branches">
          <GitFluentFilterInput
            value={query}
            placeholder="Filtrar branches"
            label="Filtrar branches do Git Fluent"
            onChange={setQuery}
          />
          {noMatches && (
            <div className="git-fluent-empty">Nenhuma branch encontrada para "{trimmedQuery}".</div>
          )}
          {filteredLocalGroups.length > 0 && (
            <GitRefSectionHeader icon="gitBranch" label="Local" count={localCount} />
          )}
          {filteredLocalGroups.map((group) => {
            const collapsedGroup = !hasFilter && collapsedGroups.has(group.key);
            return (
              <div className="git-ref-tree-group" key={group.key}>
                {group.grouped && (
                  <button
                    type="button"
                    className="git-ref-tree-header"
                    aria-expanded={!collapsedGroup}
                    onClick={() => onToggleGroup(group.key)}
                  >
                    <Codicon name={collapsedGroup ? "chevronRight" : "chevronDown"} size={12} />
                    <Codicon name="gitBranch" size={13} />
                    <span>{group.label}</span>
                    <small>{group.branches.length}</small>
                  </button>
                )}
                {!collapsedGroup && group.branches.map((branch) => {
                  const displayName = gitFluentBranchDisplayName(group, branch);
                  return (
                    <div
                      key={`fluent-branch-${branch.name}`}
                      role="treeitem"
                      tabIndex={0}
                      className={`git-ref-row${branch.current ? " current" : ""}${group.grouped ? " nested" : ""}`}
                      title={`${branch.name}\n${branch.subject}`}
                      onContextMenu={(event) => onOpenBranchMenu(event, branch)}
                    >
                      <Codicon name={branch.current ? "success" : "gitBranch"} size={13} />
                      <div className="git-ref-main">
                        <span className="git-ref-name">{displayName}</span>
                        <span className="git-ref-meta">
                          {branch.date}
                          {branch.author ? ` · ${branch.author}` : ""}
                        </span>
                      </div>
                      {branch.hasUpstream && (branch.ahead > 0 || branch.behind > 0) && (
                        <span className="git-ref-sync">
                          {branch.behind > 0 && <><Codicon name="gitPull" size={11} />{branch.behind}</>}
                          {branch.ahead > 0 && <><Codicon name="gitPush" size={11} />{branch.ahead}</>}
                        </span>
                      )}
                      <span className="git-ref-actions">
                        <Tooltip label={branch.current ? "Branch atual" : "Checkout"}>
                          <button
                            className="git-file-action"
                            aria-label={branch.current ? "Branch atual" : `Checkout ${branch.name}`}
                            disabled={busy || branch.current}
                            onClick={() => onCheckoutBranch(branch)}
                          >
                            <Codicon name="arrowLeft" size={13} />
                          </button>
                        </Tooltip>
                        <Tooltip label="Mais ações">
                          <button
                            className="git-file-action"
                            aria-label={`Mais ações para ${branch.name}`}
                            onClick={(event) => onOpenBranchMenu(event, branch)}
                          >
                            <Codicon name="filterFiles" size={13} />
                          </button>
                        </Tooltip>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {filteredRemoteGroups.length > 0 && (
            <GitRefSectionHeader icon="gitRemote" label="Remotas" count={remoteCount} />
          )}
          {filteredRemoteGroups.map((group) => {
            const collapsedGroup = !hasFilter && collapsedGroups.has(group.key);
            return (
              <div className="git-ref-tree-group remote" key={group.key}>
                {group.grouped && (
                  <button
                    type="button"
                    className="git-ref-tree-header"
                    aria-expanded={!collapsedGroup}
                    onClick={() => onToggleGroup(group.key)}
                  >
                    <Codicon name={collapsedGroup ? "chevronRight" : "chevronDown"} size={12} />
                    <Codicon name="gitRemote" size={13} />
                    <span>{group.label}</span>
                    <small>{group.branches.length}</small>
                  </button>
                )}
                {!collapsedGroup && group.branches.map((branch) => {
                  const displayName = gitFluentBranchDisplayName(group, branch);
                  return (
                    <div
                      key={`fluent-remote-branch-${branch.name}`}
                      role="treeitem"
                      tabIndex={0}
                      className={`git-ref-row remote${group.grouped ? " nested" : ""}`}
                      title={`${branch.name}\n${branch.subject}`}
                      onContextMenu={(event) => onOpenRemoteBranchMenu(event, branch)}
                    >
                      <Codicon name="gitBranch" size={13} />
                      <div className="git-ref-main">
                        <span className="git-ref-name">{displayName}</span>
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
                            <Codicon name="arrowLeft" size={13} />
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
            );
          })}
        </div>
      )}
    </div>
  );
}

function GitRefSectionHeader({
  icon,
  label,
  count,
}: {
  icon: IconAction;
  label: string;
  count: number;
}) {
  return (
    <div className="git-ref-section-header">
      <span>
        <Codicon name={icon} size={12} />
        {label}
      </span>
      <small>{count}</small>
    </div>
  );
}

function flattenBranchGroups(
  groups: GitFluentBranchGroup[],
  key: string,
  label: string,
  layout: GitFluentRefLayout
): GitFluentBranchGroup[] {
  if (layout === "tree") return groups;
  const branches = groups.flatMap((group) => group.branches);
  return branches.length > 0
    ? [
        {
          key,
          label,
          grouped: false,
          branches,
        },
      ]
    : [];
}
