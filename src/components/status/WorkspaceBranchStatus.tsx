import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../../icons/codicons/Codicon";

export interface WorkspaceBranchStatusRoot {
  id: string;
  name: string;
  path?: string;
  connId?: string;
  branch: string | null;
  isRepo: boolean;
  remote?: boolean;
  changes?: number;
  conflicted?: number;
  ahead?: number;
  behind?: number;
  hasUpstream?: boolean;
}

export interface WorkspaceBranchStatusContext {
  name: string;
  activeRoot?: string | null;
  activeRootPath?: string | null;
  folderCount: number;
  remote?: boolean;
  branches?: WorkspaceBranchStatusRoot[];
}

interface WorkspaceBranchStatusProps {
  workspace: WorkspaceBranchStatusContext;
  onSelectBranch?: (root: WorkspaceBranchStatusRoot) => void;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function copyValue(value: string | null | undefined) {
  if (!value) return;
  void navigator.clipboard?.writeText(value);
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function workspaceRootMatchesQuery(root: WorkspaceBranchStatusRoot, query: string): boolean {
  if (!query) return true;
  const parts = [
    root.name,
    root.path,
    root.branch,
    root.isRepo ? "git repo repositório repository" : "sem git no git",
    root.remote ? "ssh remoto remote" : "local",
  ];
  return parts.some((part) => String(part ?? "").toLowerCase().includes(query));
}

export function WorkspaceBranchStatus({
  workspace,
  onSelectBranch,
}: WorkspaceBranchStatusProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState("");
  const branches = workspace.branches ?? [];
  const hasBranchMenu = branches.length > 0;
  const repoRoots = branches.filter((root) => root.isRepo);
  const repoCount = repoRoots.length;
  const remoteCount = branches.filter((root) => root.remote).length;
  const missingGitCount = branches.filter((root) => !root.isRepo).length;
  const changedRepoCount = repoRoots.filter((root) => (root.changes ?? 0) > 0).length;
  const conflictedRepoCount = repoRoots.filter((root) => (root.conflicted ?? 0) > 0).length;
  const totalChanges = repoRoots.reduce((total, root) => total + (root.changes ?? 0), 0);
  const totalConflicts = repoRoots.reduce((total, root) => total + (root.conflicted ?? 0), 0);
  const totalAhead = repoRoots.reduce((total, root) => total + (root.ahead ?? 0), 0);
  const totalBehind = repoRoots.reduce((total, root) => total + (root.behind ?? 0), 0);
  const branchSummary = repoRoots.map((root) => root.branch || "sem branch");
  const uniqueBranches = [...new Set(branchSummary)];
  const mixedBranches = uniqueBranches.length > 1;
  const statusLabel = repoCount === 0 ? "sem Git" : mixedBranches ? `${uniqueBranches.length} branches` : uniqueBranches[0];
  const hasSyncWork = totalAhead > 0 || totalBehind > 0;
  const branchDistribution = [...repoRoots.reduce((map, root) => {
    const branchName = root.branch || "sem branch";
    map.set(branchName, (map.get(branchName) ?? 0) + 1);
    return map;
  }, new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const branchInsight =
    repoCount === 0
      ? "Nenhuma pasta do workspace é um repositório Git."
      : conflictedRepoCount > 0
        ? `${conflictedRepoCount} repo${conflictedRepoCount === 1 ? "" : "s"} com conflito.`
        : changedRepoCount > 0
          ? `${changedRepoCount} de ${repoCount} repos com alterações.`
          : mixedBranches
            ? `${uniqueBranches.length} branches diferentes em ${repoCount} repos.`
            : `Todos os repos estão em ${uniqueBranches[0]}.`;
  const activeRootName = workspace.activeRoot ?? null;
  const activeRootPath = workspace.activeRootPath ?? null;
  const isActiveRoot = (root: WorkspaceBranchStatusRoot) =>
    samePath(root.path, activeRootPath) || Boolean(activeRootName && root.name === activeRootName);
  const orderedBranches = [...branches].sort((a, b) => {
    const aActive = isActiveRoot(a) ? 0 : 1;
    const bActive = isActiveRoot(b) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    if (a.isRepo !== b.isRepo) return a.isRepo ? -1 : 1;
    if (a.remote !== b.remote) return a.remote ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const normalizedQuery = query.trim().toLowerCase();
  const filteredBranches = useMemo(
    () => orderedBranches.filter((root) => workspaceRootMatchesQuery(root, normalizedQuery)),
    [orderedBranches, normalizedQuery]
  );
  const branchSections = useMemo(
    () =>
      [
        {
          key: "active",
          label: "Root ativa",
          roots: filteredBranches.filter(isActiveRoot),
        },
        {
          key: "local",
          label: "Repositórios locais",
          roots: filteredBranches.filter((root) => !isActiveRoot(root) && root.isRepo && !root.remote),
        },
        {
          key: "remote",
          label: "Repositórios SSH",
          roots: filteredBranches.filter((root) => !isActiveRoot(root) && root.isRepo && root.remote),
        },
        {
          key: "missing",
          label: "Sem Git",
          roots: filteredBranches.filter((root) => !isActiveRoot(root) && !root.isRepo),
        },
      ].filter((section) => section.roots.length > 0),
    [filteredBranches, activeRootName, activeRootPath]
  );
  const hasFilter = normalizedQuery.length > 0;

  const closeMenu = () => setMenu(null);
  const openMenu = (rect: DOMRect) => {
    const menuWidth = Math.min(540, window.innerWidth - 24);
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
    setMenu({ x, y: rect.top });
  };
  const openBranchPicker = (root: WorkspaceBranchStatusRoot) => {
    if (!root.isRepo || !root.path || !onSelectBranch) return;
    onSelectBranch(root);
    closeMenu();
  };
  const tooltip = [
    `Workspace: ${workspace.name}`,
    workspace.activeRoot
      ? `Root ativa: ${workspace.activeRoot}${workspace.remote ? " (SSH)" : ""}`
      : null,
    branches.length
      ? [
          "Branches:",
          ...branches.map((root) => {
            const branch = root.isRepo ? root.branch || "sem branch" : "não é repositório Git";
            return `- ${root.name}${root.remote ? " (SSH)" : ""}: ${branch}`;
          }),
        ].join("\n")
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      <span
        className={`status-item status-workspace-context${hasBranchMenu ? " status-clickable" : ""}`}
        title={tooltip}
        role={hasBranchMenu ? "button" : undefined}
        tabIndex={hasBranchMenu ? 0 : undefined}
        aria-label={hasBranchMenu ? `Workspace ${workspace.name}; mostrar branches das pastas` : undefined}
        onClick={
          hasBranchMenu
            ? (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(rect);
              }
            : undefined
        }
        onKeyDown={
          hasBranchMenu
            ? (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(rect);
              }
            : undefined
        }
      >
        <Codicon name={workspace.remote ? "remote" : "folderOpened"} />
        <span className="status-workspace-name">{workspace.name}</span>
        {repoCount > 0 && (
          <span
            className={`status-workspace-branch-chip${mixedBranches ? " mixed" : ""}${
              totalConflicts > 0 ? " conflict" : ""
            }`}
            title={
              mixedBranches
                ? `${uniqueBranches.length} branches em ${repoCount} repos`
                : `Branch ${statusLabel}`
            }
          >
            <Codicon name="gitBranch" size={12} />
            {statusLabel}
          </span>
        )}
        {totalConflicts > 0 && (
          <span className="status-workspace-mini-badge conflict" title={`${totalConflicts} conflitos no workspace`}>
            <Codicon name="warning" size={11} />
            {totalConflicts}
          </span>
        )}
        {totalConflicts === 0 && totalChanges > 0 && (
          <span className="status-workspace-mini-badge" title={`${totalChanges} alterações no workspace`}>
            <Codicon name="openChanges" size={11} />
            {totalChanges}
          </span>
        )}
        {hasSyncWork && (
          <span className="status-workspace-mini-badge sync" title={`${totalBehind} para baixar · ${totalAhead} para enviar`}>
            {totalBehind > 0 && <>↓{totalBehind}</>}
            {totalAhead > 0 && <>↑{totalAhead}</>}
          </span>
        )}
      </span>

      {menu &&
        createPortal(
          <>
            <div
              className="status-menu-overlay"
              onClick={closeMenu}
              onContextMenu={(event) => {
                event.preventDefault();
                closeMenu();
              }}
            />
            <div
              className="status-workspace-menu"
              style={{ left: menu.x, top: menu.y }}
              role="menu"
            >
              <div className="status-workspace-menu-title">
                <Codicon name="folderOpened" size={14} />
                <div>
                  <span>{workspace.name}</span>
                  <small>
                    {workspace.folderCount} pastas · {repoCount} repos
                    {remoteCount > 0 ? ` · ${remoteCount} SSH` : ""}
                    {missingGitCount > 0 ? ` · ${missingGitCount} sem Git` : ""}
                  </small>
                </div>
                <button
                  type="button"
                  className="status-workspace-menu-action"
                  title="Copiar nome do workspace"
                  onClick={() => copyValue(workspace.name)}
                >
                  <Codicon name="copy" size={12} />
                </button>
              </div>
              <div className={`status-workspace-branch-summary${mixedBranches ? " mixed" : ""}`}>
                <Codicon name={mixedBranches ? "warning" : repoCount > 0 ? "success" : "info"} size={13} />
                <span>
                  {hasFilter
                    ? `${filteredBranches.length} de ${branches.length} roots correspondem ao filtro.`
                    : branchInsight}
                </span>
              </div>
              {branchDistribution.length > 0 && (
                <div className="status-workspace-branch-distribution" aria-label="Distribuição de branches">
                  {branchDistribution.slice(0, 4).map(([branchName, count]) => (
                    <span key={branchName} title={`${count} repo${count === 1 ? "" : "s"} em ${branchName}`}>
                      <Codicon name="gitBranch" size={11} />
                      <span>{branchName}</span>
                      {count > 1 && <small>{count}</small>}
                    </span>
                  ))}
                  {branchDistribution.length > 4 && (
                    <span title={`${branchDistribution.length - 4} branches adicionais`}>
                      +{branchDistribution.length - 4}
                    </span>
                  )}
                </div>
              )}
              <div className="status-workspace-filter" role="search">
                <Codicon name="search" size={12} />
                <input
                  type="search"
                  value={query}
                  placeholder="Filtrar workspace"
                  aria-label="Filtrar roots do workspace"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                {hasFilter ? (
                  <button type="button" aria-label="Limpar filtro" onClick={() => setQuery("")}>
                    <Codicon name="close" size={12} />
                  </button>
                ) : (
                  <span aria-hidden="true" />
                )}
              </div>
              <div className="status-workspace-branch-list">
                {branchSections.length === 0 ? (
                  <div className="status-workspace-empty">Nenhuma root encontrada para "{query.trim()}".</div>
                ) : branchSections.map((section) => (
                  <div className="status-workspace-branch-section" key={section.key}>
                    <div className="status-workspace-branch-section-title">
                      <span>{section.label}</span>
                      <small>{section.roots.length}</small>
                    </div>
                    {section.roots.map((root, index) => {
                      const isActive = isActiveRoot(root);
                      const changes = root.changes ?? 0;
                      const conflicts = root.conflicted ?? 0;
                      const ahead = root.ahead ?? 0;
                      const behind = root.behind ?? 0;
                      const hasSync = root.isRepo && root.hasUpstream && (ahead > 0 || behind > 0);
                      const hasHealth = root.isRepo && (changes > 0 || conflicts > 0 || hasSync || root.hasUpstream === false);
                      return (
                        <div
                          key={`${section.key}:${root.id}:${root.name}:${root.branch ?? "no-repo"}:${index}`}
                          className={`status-workspace-branch-row${root.isRepo ? "" : " disabled"}${isActive ? " active" : ""}${
                            root.isRepo && onSelectBranch ? " clickable" : ""
                          }`}
                          title={root.isRepo && onSelectBranch ? `Trocar branch de ${root.name}` : undefined}
                          tabIndex={root.isRepo && onSelectBranch ? 0 : undefined}
                          aria-disabled={!root.isRepo}
                          aria-label={
                            root.isRepo
                              ? `${root.name}, branch ${root.branch || "sem branch"}`
                              : `${root.name}, sem Git`
                          }
                          onClick={() => openBranchPicker(root)}
                          onKeyDown={(event) => {
                            if (!root.isRepo || !onSelectBranch) return;
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            openBranchPicker(root);
                          }}
                          role="menuitem"
                        >
                          <Codicon name={root.remote ? "remote" : "folder"} size={13} />
                          <span className="status-workspace-branch-main">
                            <span className="status-workspace-branch-root">{root.name}</span>
                            {root.path && (
                              <span className="status-workspace-branch-path" title={root.path}>
                                {baseName(root.path)}
                              </span>
                            )}
                          </span>
                          <span className="status-workspace-branch-name" title={root.branch ?? undefined}>
                            <Codicon name={root.isRepo ? "gitBranch" : "error"} size={12} />
                            {root.isRepo ? root.branch || "sem branch" : "sem Git"}
                          </span>
                          <span className={`status-workspace-branch-health${conflicts > 0 ? " conflict" : ""}`}>
                            {hasHealth ? (
                              <>
                                {conflicts > 0 ? (
                                  <span title={`${conflicts} conflito${conflicts === 1 ? "" : "s"}`}>
                                    <Codicon name="warning" size={11} />
                                    {conflicts}
                                  </span>
                                ) : changes > 0 ? (
                                  <span title={`${changes} alteração${changes === 1 ? "" : "ões"}`}>
                                    <Codicon name="openChanges" size={11} />
                                    {changes}
                                  </span>
                                ) : null}
                                {hasSync ? (
                                  <span title={`${ahead} ahead, ${behind} behind`}>
                                    {ahead > 0 ? `↑${ahead}` : ""}
                                    {behind > 0 ? `↓${behind}` : ""}
                                  </span>
                                ) : root.hasUpstream === false ? (
                                  <span title="Branch sem upstream">sem upstream</span>
                                ) : null}
                              </>
                            ) : (
                              <span title="Sem alterações">limpo</span>
                            )}
                          </span>
                          <span className="status-workspace-branch-state">
                            {isActive ? "ativa" : root.remote ? "SSH" : "local"}
                          </span>
                          <span className="status-workspace-branch-actions">
                            <button
                              type="button"
                              title={root.isRepo && root.branch ? "Copiar branch" : "Branch indisponível"}
                              disabled={!root.isRepo || !root.branch}
                              onClick={(event) => {
                                event.stopPropagation();
                                copyValue(root.branch);
                              }}
                            >
                              <Codicon name="copy" size={12} />
                            </button>
                            <button
                              type="button"
                              title={root.path ? "Copiar caminho" : "Caminho indisponível"}
                              disabled={!root.path}
                              onClick={(event) => {
                                event.stopPropagation();
                                copyValue(root.path);
                              }}
                            >
                              <Codicon name="copyPath" size={12} />
                            </button>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </>,
          document.body
        )}
    </>
  );
}
