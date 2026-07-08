import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
  gitBranches,
  gitCheckout,
  gitCheckoutRemoteBranch,
  gitCommit,
  gitCompareUpstream,
  gitDiscardAll,
  gitDiscardFile,
  gitFetch,
  gitFetchRemote,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitGraph,
  gitLog,
  gitLogFile,
  gitLogLine,
  gitPull,
  gitPush,
  gitRemoteBranches,
  gitRemoteAdd,
  gitRemoteRemove,
  gitRemoteRename,
  gitRemoteSetUrl,
  gitRemotes,
  gitRenameBranch,
  gitRevertCommit,
  gitStage,
  gitStageAll,
  gitStashApply,
  gitStashDrop,
  gitStashFiles,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitUnstage,
  gitUnstageAll,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemove,
  gitWorktrees,
  revealInExplorer,
  type GitRevisionDiffTarget,
  type GitChangeView,
} from "../api";
import type {
  ContextMenuItem,
  GitBranchInfo,
  GitCommit,
  GitFileStatus,
  GitGraphCommit,
  GitHistoryTarget,
  GitRemoteInfo,
  GitStashEntry,
  GitStashFile,
  GitStatus,
  GitUpstreamComparison,
  GitWorktreeInfo,
} from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import { FileIcon } from "../icon-theme/material/FileIcon";
import {
  suggestWithGitAssistant,
  type GitAssistAdapter,
  type GitAssistPreferences,
} from "../git/assist";
import { fileName, joinRepoPath } from "../git/gitUi";
import {
  GIT_FLUENT_PRIMARY_TABS,
  GIT_FLUENT_TABS,
  buildGitFluentBranchGroups,
  buildGitFluentGraphRows,
  buildGitFluentRemoteTree,
  graphRefKind,
  graphRefLabel,
  type GitFluentContributor,
  type GitFluentRefLayout,
  type GitFluentTab,
  type GitFluentToolbarDensity,
  type GitFluentTagRef,
} from "../git/gitFluent";
import { GitFluentBranchesView } from "./git/GitFluentBranchesView";
import { GitFluentCompareView } from "./git/GitFluentCompareView";
import { GitFluentGraphView } from "./git/GitFluentGraphView";
import { GitFluentHistoryView } from "./git/GitFluentHistoryView";
import { GitFluentContributorsView, GitFluentTagsView } from "./git/GitFluentRefsViews";
import { GitFluentRemotesView } from "./git/GitFluentRemotesView";
import { GitFluentRepositoryOverviewView } from "./git/GitFluentRepositoryOverviewView";
import { GitFluentStashesView } from "./git/GitFluentStashesView";
import { GitFluentToolbar } from "./git/GitFluentToolbar";
import { GitFluentViewActions } from "./git/GitFluentViewActions";
import { GitFluentWorktreesView } from "./git/GitFluentWorktreesView";
import { TreeContextMenu } from "./TreeContextMenu";
import { Tooltip } from "./Tooltip";

interface GitPanelProps {
  /** Open folder; the repo is resolved from here. Null when nothing is open. */
  rootPath: string | null;
  workspaceRoots?: GitWorkspaceRoot[];
  /** Open a file (e.g. when a changed file is clicked). */
  onOpenFile: (path: string, name: string) => void;
  /** Opens a working-tree diff for a changed file. */
  onOpenChanges?: (
    path: string,
    rootPath?: string,
    connId?: string,
    view?: GitChangeView
  ) => void;
  /** Opens the selected file as it existed at a commit, read-only. */
  onOpenRevision?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    rootPath?: string,
    connId?: string
  ) => void;
  /** Opens a Git Fluent revision diff tab for the selected file commit. */
  onOpenRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget,
    rootPath?: string,
    connId?: string
  ) => void;
  /**
   * Absolute path whose history to show (ISSUE-71 · File History). When set, the
   * History section auto-expands and lists only this file's commits, with a
   * banner to clear back to the repo-wide log. Null = normal repo history.
   */
  historyFile?: string | null;
  historyTarget?: GitHistoryTarget | null;
  /** Clears the file-history filter, returning to the repo-wide log. */
  onClearHistoryFile?: () => void;
  /** Opens a local folder in the current workbench window. */
  onOpenLocalFolderInCurrentWindow?: (path: string) => void;
  /** Opens a local folder in a new workbench window. */
  onOpenLocalFolderInNewWindow?: (path: string) => void;
  /** Optional bridge to the app's local agents for commit/branch suggestions. */
  gitAssistant?: GitAssistAdapter;
  /** Future settings hook for commit/branch generation rules. */
  gitAssistPreferences?: GitAssistPreferences;
}

export interface GitWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
  connId?: string;
  status?: "connected" | "connecting" | "error";
  error?: string;
}

interface GitRepositoryPanelProps extends Omit<GitPanelProps, "workspaceRoots"> {
  rootName?: string;
  embedded?: boolean;
  connId?: string;
  provider?: "local" | "ssh";
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onHideRepository?: () => void;
}

const GIT_HIDDEN_REPOSITORIES_STORAGE_KEY = "fluentCoder.git.hiddenRepositories";
const GIT_COLLAPSED_REPOSITORIES_STORAGE_KEY = "fluentCoder.git.collapsedRepositories";
const GIT_FLUENT_ACTIVE_TAB_STORAGE_KEY = "fluentCoder.gitFluent.activeTab";
const GIT_FLUENT_COLLAPSED_STORAGE_KEY = "fluentCoder.gitFluent.collapsed";
const GIT_FLUENT_COLLAPSED_GROUPS_STORAGE_KEY = "fluentCoder.gitFluent.collapsedGroups";
const GIT_FLUENT_BRANCH_LAYOUT_STORAGE_KEY = "fluentCoder.gitFluent.branchLayout";
const GIT_FLUENT_REMOTE_BRANCH_LAYOUT_STORAGE_KEY = "fluentCoder.gitFluent.remoteBranchLayout";
const GIT_FLUENT_TOOLBAR_DENSITY_STORAGE_KEY = "fluentCoder.gitFluent.toolbarDensity";
const GIT_PANEL_VIEW_ORDER_STORAGE_KEY = "fluentCoder.git.panelViewOrder";

type GitPanelViewId = "changes" | "gitFluent";

const GIT_PANEL_VIEW_ORDER: GitPanelViewId[] = ["changes", "gitFluent"];

function readStringSet(key: string): Set<string> {
  try {
    if (typeof window === "undefined") return new Set();
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function writeStringSet(key: string, ids: Set<string>) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      key,
      JSON.stringify([...ids])
    );
  } catch {
    // Local storage is only a view preference; ignore quota/privacy failures.
  }
}

function readStringPreference<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const value = window.localStorage.getItem(key);
    return values.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStringPreference(key: string, value: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  } catch {
    // Local storage is only a view preference; ignore quota/privacy failures.
  }
}

function readGitPanelViewOrder(): GitPanelViewId[] {
  try {
    if (typeof window === "undefined") return GIT_PANEL_VIEW_ORDER;
    const raw = window.localStorage.getItem(GIT_PANEL_VIEW_ORDER_STORAGE_KEY);
    if (!raw) return GIT_PANEL_VIEW_ORDER;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return GIT_PANEL_VIEW_ORDER;
    const known = new Set<GitPanelViewId>(GIT_PANEL_VIEW_ORDER);
    const saved = parsed.filter((value): value is GitPanelViewId => known.has(value));
    const missing = GIT_PANEL_VIEW_ORDER.filter((view) => !saved.includes(view));
    return [...saved, ...missing];
  } catch {
    return GIT_PANEL_VIEW_ORDER;
  }
}

function writeGitPanelViewOrder(order: GitPanelViewId[]) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GIT_PANEL_VIEW_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Local storage is only a view preference; ignore quota/privacy failures.
  }
}

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    if (typeof window === "undefined") return fallback;
    const value = window.localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBooleanPreference(key: string, value: boolean) {
  writeStringPreference(key, String(value));
}

function readGitFluentActiveTab(): GitFluentTab {
  return readStringPreference(
    GIT_FLUENT_ACTIVE_TAB_STORAGE_KEY,
    GIT_FLUENT_PRIMARY_TABS.map((tab) => tab.id),
    "graph"
  );
}

function readGitFluentRefLayout(key: string): GitFluentRefLayout {
  return readStringPreference(key, ["tree", "list"], "tree");
}

function readGitFluentToolbarDensity(): GitFluentToolbarDensity {
  return readStringPreference(GIT_FLUENT_TOOLBAR_DENSITY_STORAGE_KEY, ["compact", "comfortable"], "compact");
}

function readHiddenRepositoryIds(): Set<string> {
  return readStringSet(GIT_HIDDEN_REPOSITORIES_STORAGE_KEY);
}

function readCollapsedRepositoryIds(): Set<string> {
  return readStringSet(GIT_COLLAPSED_REPOSITORIES_STORAGE_KEY);
}

/** Maps a porcelain code to a single-letter badge + a CSS modifier. */
function badge(file: GitFileStatus): { letter: string; kind: string } {
  if (file.untracked) return { letter: "U", kind: "untracked" };
  // Use the worktree column for unstaged, the index column for staged.
  const idx = file.code.charAt(0);
  const wt = file.code.charAt(1);
  const c = file.staged ? idx : wt;
  switch (c) {
    case "M":
      return { letter: "M", kind: "modified" };
    case "A":
      return { letter: "A", kind: "added" };
    case "D":
      return { letter: "D", kind: "deleted" };
    case "R":
      return { letter: "R", kind: "renamed" };
    default:
      return { letter: c === "." ? "M" : c || "?", kind: "modified" };
  }
}

function openExternal(url: string | undefined) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `${parts[parts.length - 3]}/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function safeWorktreeSegment(value: string): string {
  return (value || "worktree")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    || "worktree";
}

function localNameFromRemoteBranch(remoteBranch: string): string {
  const parts = remoteBranch.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : remoteBranch.trim();
}

function remoteBranchParts(
  remoteBranch: string,
  remotes: GitRemoteInfo[]
): { remote: string; branch: string } | null {
  const sortedRemotes = [...remotes].sort((a, b) => b.name.length - a.name.length);
  for (const remote of sortedRemotes) {
    const prefix = `${remote.name}/`;
    if (remoteBranch.startsWith(prefix)) {
      const branch = remoteBranch.slice(prefix.length);
      return branch ? { remote: remote.name, branch } : null;
    }
  }
  const slash = remoteBranch.indexOf("/");
  if (slash <= 0 || slash === remoteBranch.length - 1) return null;
  return {
    remote: remoteBranch.slice(0, slash),
    branch: remoteBranch.slice(slash + 1),
  };
}

function siblingWorktreePath(rootPath: string, branchOrRef: string): string {
  const normalized = rootPath.replace(/[\\/]+$/, "");
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const separator = normalized.includes("\\") ? "\\" : "/";
  const parent = lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
  const repo = fileName(normalized);
  return `${parent}${separator}${repo}-${safeWorktreeSegment(branchOrRef)}`;
}

function inferCommitPrefix(files: GitFileStatus[], commits: GitCommit[]): string {
  const seen = new Map<string, number>();
  for (const commit of commits.slice(0, 16)) {
    const match = commit.subject.match(/^([a-z]+)(?:\([^)]+\))?:\s+/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const frequent = [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (frequent) return frequent;

  const paths = files.map((file) => file.path.toLowerCase());
  if (paths.every((path) => path.endsWith(".md") || path.includes("/docs/"))) return "docs";
  if (paths.some((path) => path.includes("test") || path.includes("spec"))) return "test";
  if (paths.some((path) => path.endsWith(".css") || path.includes("style"))) return "style";
  if (paths.some((path) => path.includes("package") || path.includes("config") || path.endsWith(".json"))) {
    return "chore";
  }
  return "feat";
}

function buildCommitMessage(files: GitFileStatus[], commits: GitCommit[]): string {
  const targetFiles = files.slice(0, 4);
  const prefix = inferCommitPrefix(targetFiles, commits);
  const primary = targetFiles[0];
  if (!primary) return "";

  const scope = fileName(primary.path).replace(/\.[^.]+$/, "");
  if (files.length === 1) {
    if (primary.untracked || primary.code.includes("A")) return `${prefix}: add ${scope}`;
    if (primary.code.includes("D")) return `${prefix}: remove ${scope}`;
    return `${prefix}: update ${scope}`;
  }

  const folders = new Set(
    targetFiles
      .map((file) => file.path.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2, -1)[0])
      .filter(Boolean)
  );
  const area = folders.size === 1 ? [...folders][0] : "workspace changes";
  return `${prefix}: update ${area}`;
}

function buildBranchName(files: GitFileStatus[], commits: GitCommit[], fallbackBranch: string): string {
  const prefix = inferCommitPrefix(files, commits);
  const firstPath = files[0]?.path ?? commits[0]?.subject ?? fallbackBranch;
  const slug = firstPath
    .replace(/\.[^.\\/]+$/, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("-")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  const normalizedPrefix = prefix === "fix" ? "fix" : prefix === "docs" ? "docs" : "feat";
  return `${normalizedPrefix}/${slug || "workspace-update"}`;
}

function GitSectionHeader({
  title,
  expanded,
  onToggle,
  count,
  icon,
  actions,
  danger = false,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  count?: number;
  icon?: IconAction;
  actions?: ReactNode;
  danger?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`git-section-header${danger ? " git-section-danger" : ""}${draggable ? " is-draggable" : ""}${dragging ? " is-dragging" : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button
        type="button"
        className="git-section-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="tree-chevron">
          <Codicon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
        </span>
        {icon && <Codicon name={icon} size={13} />}
        <span>{title}</span>
      </button>
      <div className="git-section-actions">
        {actions}
        {typeof count === "number" && <span className="git-count">{count}</span>}
      </div>
    </div>
  );
}

export function GitPanel({
  rootPath,
  workspaceRoots = [],
  onOpenFile,
  onOpenChanges,
  onOpenRevision,
  onOpenRevisionDiff,
  historyFile = null,
  historyTarget = null,
  onClearHistoryFile,
  onOpenLocalFolderInCurrentWindow,
  onOpenLocalFolderInNewWindow,
  gitAssistant,
  gitAssistPreferences,
}: GitPanelProps) {
  const [hiddenRepoIds, setHiddenRepoIds] = useState<Set<string>>(
    readHiddenRepositoryIds
  );
  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(
    readCollapsedRepositoryIds
  );
  const [repoOptionsMenu, setRepoOptionsMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const localRoots = workspaceRoots.filter((root) => root.provider === "local");
  const sshRoots = workspaceRoots.filter((root) => root.provider === "ssh");
  const workspaceRepoRoots = [...localRoots, ...sshRoots];
  const workspaceRepoRootKey = workspaceRepoRoots.map((root) => root.id).join("\0");
  const visibleWorkspaceRoots = workspaceRepoRoots.filter((root) => !hiddenRepoIds.has(root.id));
  const hiddenCount = workspaceRepoRoots.length - visibleWorkspaceRoots.length;
  const localHiddenCount = localRoots.filter((root) => hiddenRepoIds.has(root.id)).length;
  const sshHiddenCount = sshRoots.filter((root) => hiddenRepoIds.has(root.id)).length;

  useEffect(() => {
    writeStringSet(GIT_HIDDEN_REPOSITORIES_STORAGE_KEY, hiddenRepoIds);
  }, [hiddenRepoIds]);

  useEffect(() => {
    writeStringSet(GIT_COLLAPSED_REPOSITORIES_STORAGE_KEY, collapsedRepoIds);
  }, [collapsedRepoIds]);

  useEffect(() => {
    const ids = new Set(workspaceRepoRoots.map((root) => root.id));
    setHiddenRepoIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setCollapsedRepoIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [workspaceRepoRootKey]);

  const setRepoHidden = (id: string, hidden: boolean) => {
    setHiddenRepoIds((prev) => {
      const next = new Set(prev);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const setRepositoriesHidden = (roots: GitWorkspaceRoot[], hidden: boolean) => {
    setHiddenRepoIds((prev) => {
      const next = new Set(prev);
      roots.forEach((root) => {
        if (hidden) next.add(root.id);
        else next.delete(root.id);
      });
      return next;
    });
  };
  const setRepoCollapsed = (id: string, collapsed: boolean) => {
    setCollapsedRepoIds((prev) => {
      const next = new Set(prev);
      if (collapsed) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const setRepositoriesCollapsed = (roots: GitWorkspaceRoot[], collapsed: boolean) => {
    setCollapsedRepoIds((prev) => {
      const next = new Set(prev);
      roots.forEach((root) => {
        if (collapsed) next.add(root.id);
        else next.delete(root.id);
      });
      return next;
    });
  };
  const openRepoOptions = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const items: ContextMenuItem[] = [
      {
        id: "expand-all",
        label: "Expandir todos os repositórios",
        icon: "chevronDown",
        enabled: collapsedRepoIds.size > 0,
        run: () => setRepositoriesCollapsed(workspaceRepoRoots, false),
      },
      {
        id: "collapse-all",
        label: "Recolher todos os repositórios",
        icon: "chevronRight",
        enabled: workspaceRepoRoots.some((root) => !collapsedRepoIds.has(root.id)),
        run: () => setRepositoriesCollapsed(workspaceRepoRoots, true),
      },
      { id: "sep-collapse-groups", label: "", separator: true },
      {
        id: "expand-local",
        label: "Expandir repositórios locais",
        icon: "folderOpened",
        enabled: localRoots.some((root) => collapsedRepoIds.has(root.id)),
        run: () => setRepositoriesCollapsed(localRoots, false),
      },
      {
        id: "collapse-local",
        label: "Recolher repositórios locais",
        icon: "folder",
        enabled: localRoots.some((root) => !collapsedRepoIds.has(root.id)),
        run: () => setRepositoriesCollapsed(localRoots, true),
      },
      {
        id: "expand-ssh",
        label: "Expandir repositórios SSH",
        icon: "remote",
        enabled: sshRoots.some((root) => collapsedRepoIds.has(root.id)),
        run: () => setRepositoriesCollapsed(sshRoots, false),
      },
      {
        id: "collapse-ssh",
        label: "Recolher repositórios SSH",
        icon: "remote",
        enabled: sshRoots.some((root) => !collapsedRepoIds.has(root.id)),
        run: () => setRepositoriesCollapsed(sshRoots, true),
      },
      { id: "sep-collapse-repos", label: "", separator: true },
      ...workspaceRepoRoots.map((root) => {
        const hidden = hiddenRepoIds.has(root.id);
        const collapsed = collapsedRepoIds.has(root.id);
        return {
          id: `collapse-repo-${root.id}`,
          label: `${collapsed ? "Expandir" : "Recolher"} ${root.name}`,
          icon: collapsed ? "chevronDown" : "chevronRight",
          enabled: !hidden,
          run: () => setRepoCollapsed(root.id, !collapsed),
        } satisfies ContextMenuItem;
      }),
      { id: "sep-visibility", label: "", separator: true },
      {
        id: "show-all",
        label: "Mostrar todos os repositórios",
        icon: "success",
        enabled: hiddenRepoIds.size > 0,
        run: () => setHiddenRepoIds(new Set()),
      },
      {
        id: "hide-all",
        label: "Ocultar todos os repositórios",
        icon: "close",
        enabled: visibleWorkspaceRoots.length > 0,
        run: () => setRepositoriesHidden(workspaceRepoRoots, true),
      },
      { id: "sep-groups", label: "", separator: true },
      {
        id: "show-local",
        label: "Mostrar repositórios locais",
        icon: "folder",
        enabled: localHiddenCount > 0,
        run: () => setRepositoriesHidden(localRoots, false),
      },
      {
        id: "hide-local",
        label: "Ocultar repositórios locais",
        icon: "folder",
        enabled: localRoots.some((root) => !hiddenRepoIds.has(root.id)),
        run: () => setRepositoriesHidden(localRoots, true),
      },
      {
        id: "show-ssh",
        label: "Mostrar repositórios SSH",
        icon: "remote",
        enabled: sshHiddenCount > 0,
        run: () => setRepositoriesHidden(sshRoots, false),
      },
      {
        id: "hide-ssh",
        label: "Ocultar repositórios SSH",
        icon: "remote",
        enabled: sshRoots.some((root) => !hiddenRepoIds.has(root.id)),
        run: () => setRepositoriesHidden(sshRoots, true),
      },
      { id: "sep-repos", label: "", separator: true },
      ...workspaceRepoRoots.map((root) => {
        const hidden = hiddenRepoIds.has(root.id);
        return {
          id: `repo-${root.id}`,
          label: `${hidden ? "Mostrar" : "Ocultar"} ${root.name}`,
          icon: hidden ? "success" : "close",
          run: () => setRepoHidden(root.id, !hidden),
        } satisfies ContextMenuItem;
      }),
    ];
    setRepoOptionsMenu({ x: event.clientX, y: event.clientY, items });
  };
  if (localRoots.length > 1 || sshRoots.length > 0) {
    return (
      <div className="git-panel">
        <div className="explorer-header git-header">
          <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
          <div className="git-actions">
            {hiddenCount > 0 && <span className="git-hidden-count">{hiddenCount} oculto{hiddenCount === 1 ? "" : "s"}</span>}
            <Tooltip label="Opções de repositórios">
              <button
                className="git-icon-btn"
                aria-label="Opções de repositórios"
                onClick={openRepoOptions}
              >
                <Codicon name="filterFiles" />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="git-workspace-list">
          {visibleWorkspaceRoots.length === 0 && (
            <div className="panel-empty">Todos os repositórios estão ocultos.</div>
          )}
          {visibleWorkspaceRoots.filter((root) => root.provider === "local").map((root) => (
            <section className="git-workspace-root" key={root.id}>
              <GitRepositoryPanel
                rootPath={root.path}
                rootName={root.name}
                embedded
                provider={root.provider}
                collapsed={collapsedRepoIds.has(root.id)}
                onCollapsedChange={(collapsed) => setRepoCollapsed(root.id, collapsed)}
                onHideRepository={() => setRepoHidden(root.id, true)}
                onOpenFile={onOpenFile}
                onOpenChanges={onOpenChanges}
                onOpenRevision={onOpenRevision}
                onOpenRevisionDiff={onOpenRevisionDiff}
                historyFile={historyFile}
                historyTarget={historyTarget}
                onClearHistoryFile={onClearHistoryFile}
                onOpenLocalFolderInCurrentWindow={onOpenLocalFolderInCurrentWindow}
                onOpenLocalFolderInNewWindow={onOpenLocalFolderInNewWindow}
                gitAssistant={gitAssistant}
                gitAssistPreferences={gitAssistPreferences}
              />
            </section>
          ))}
          {visibleWorkspaceRoots.filter((root) => root.provider === "ssh").map((root) => (
            <section className="git-workspace-root remote" key={root.id}>
              {root.connId ? (
                <GitRepositoryPanel
                  rootPath={root.path}
                  rootName={root.name}
                  connId={root.connId}
                  embedded
                  provider={root.provider}
                  collapsed={collapsedRepoIds.has(root.id)}
                  onCollapsedChange={(collapsed) => setRepoCollapsed(root.id, collapsed)}
                  onHideRepository={() => setRepoHidden(root.id, true)}
                  onOpenFile={onOpenFile}
                  onOpenChanges={onOpenChanges}
                  onOpenRevision={onOpenRevision}
                  onOpenRevisionDiff={onOpenRevisionDiff}
                  historyFile={historyFile}
                  historyTarget={historyTarget}
                  onClearHistoryFile={onClearHistoryFile}
                  onOpenLocalFolderInCurrentWindow={onOpenLocalFolderInCurrentWindow}
                  onOpenLocalFolderInNewWindow={onOpenLocalFolderInNewWindow}
                  gitAssistant={gitAssistant}
                  gitAssistPreferences={gitAssistPreferences}
                />
              ) : (
                <div className="git-root-header is-collapsed" title={root.path}>
                  <div className="git-root-main">
                    <span className="git-root-spacer" aria-hidden="true" />
                    <Codicon name="remote" size={13} />
                    <span className="git-root-name">{root.name}</span>
                  </div>
                  <div className="git-root-meta">
                    <span
                      className="git-root-chip git-root-chip-muted"
                      title={
                        root.status === "error"
                          ? `Erro SSH: ${root.error ?? "erro desconhecido"}`
                          : `SSH · ${root.path}`
                      }
                    >
                      <Codicon name="remote" size={12} />
                      SSH
                    </span>
                  </div>
                  <div className="git-root-actions">
                    <Tooltip label="Ocultar repositório">
                      <button
                        className="git-icon-btn"
                        aria-label="Ocultar repositório"
                        onClick={() => setRepoHidden(root.id, true)}
                      >
                        <Codicon name="close" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
        {repoOptionsMenu && (
          <TreeContextMenu
            x={repoOptionsMenu.x}
            y={repoOptionsMenu.y}
            items={repoOptionsMenu.items}
            onClose={() => setRepoOptionsMenu(null)}
          />
        )}
      </div>
    );
  }

  return (
    <GitRepositoryPanel
      rootPath={rootPath}
      onOpenFile={onOpenFile}
      onOpenChanges={onOpenChanges}
      onOpenRevision={onOpenRevision}
      onOpenRevisionDiff={onOpenRevisionDiff}
      historyFile={historyFile}
      historyTarget={historyTarget}
      onClearHistoryFile={onClearHistoryFile}
      onOpenLocalFolderInCurrentWindow={onOpenLocalFolderInCurrentWindow}
      onOpenLocalFolderInNewWindow={onOpenLocalFolderInNewWindow}
      gitAssistant={gitAssistant}
      gitAssistPreferences={gitAssistPreferences}
    />
  );
}

function GitRepositoryPanel({
  rootPath,
  rootName,
  embedded = false,
  connId,
  provider = "local",
  collapsed,
  onCollapsedChange,
  onHideRepository,
  onOpenFile,
  onOpenChanges,
  onOpenRevision,
  onOpenRevisionDiff,
  historyFile = null,
  historyTarget = null,
  onClearHistoryFile,
  onOpenLocalFolderInCurrentWindow,
  onOpenLocalFolderInNewWindow,
  gitAssistant,
  gitAssistPreferences,
}: GitRepositoryPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [assistSource, setAssistSource] = useState<"agent" | "heuristic" | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [localShowRepositoryBody, setLocalShowRepositoryBody] = useState(true);
  const [showSourceControlRoot, setShowSourceControlRoot] = useState(true);
  const [showConflicts, setShowConflicts] = useState(true);
  const [showStaged, setShowStaged] = useState(true);
  const [showChanges, setShowChanges] = useState(true);
  const [panelViewOrder, setPanelViewOrder] = useState<GitPanelViewId[]>(readGitPanelViewOrder);
  const [draggingPanelView, setDraggingPanelView] = useState<GitPanelViewId | null>(null);
  const [showGitFluentOverview, setShowGitFluentOverview] = useState(() =>
    !readBooleanPreference(GIT_FLUENT_COLLAPSED_STORAGE_KEY, false)
  );
  const [activeGitFluentTab, setActiveGitFluentTab] = useState<GitFluentTab>(() => readGitFluentActiveTab());
  const [gitFluentBranchLayout, setGitFluentBranchLayout] = useState<GitFluentRefLayout>(() =>
    readGitFluentRefLayout(GIT_FLUENT_BRANCH_LAYOUT_STORAGE_KEY)
  );
  const [gitFluentRemoteBranchLayout, setGitFluentRemoteBranchLayout] = useState<GitFluentRefLayout>(() =>
    readGitFluentRefLayout(GIT_FLUENT_REMOTE_BRANCH_LAYOUT_STORAGE_KEY)
  );
  const [gitFluentToolbarDensity, setGitFluentToolbarDensity] = useState<GitFluentToolbarDensity>(
    readGitFluentToolbarDensity
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [expandedStashes, setExpandedStashes] = useState<Set<number>>(() => new Set());
  const [stashFiles, setStashFiles] = useState<Record<number, GitStashFile[]>>({});
  const [stashFilesLoading, setStashFilesLoading] = useState<Record<number, boolean>>({});
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<GitBranchInfo[]>([]);
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([]);
  const [graphCommits, setGraphCommits] = useState<GitGraphCommit[]>([]);
  const [upstreamComparison, setUpstreamComparison] = useState<GitUpstreamComparison | null>(null);
  const [collapsedGitFluentGroups, setCollapsedGitFluentGroups] = useState<Set<string>>(() =>
    readStringSet(GIT_FLUENT_COLLAPSED_GROUPS_STORAGE_KEY)
  );
  // Commits for the file under "File History" (ISSUE-71). Separate from the
  // repo-wide `commits` so switching back doesn't refetch the whole log.
  const [fileCommits, setFileCommits] = useState<GitCommit[]>([]);
  const [selectedGraphHash, setSelectedGraphHash] = useState<string | null>(null);
  // Right-click context menu over a changed file (issue #9), VS Code-style.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const historyBelongsHere =
    !historyTarget?.rootPath ||
    (historyTarget.rootPath === rootPath && (historyTarget.connId ?? null) === (connId ?? null));
  const resolvedHistoryFile = historyBelongsHere
    ? historyTarget?.file ?? historyFile
    : null;
  const resolvedHistoryLine = historyBelongsHere ? historyTarget?.line : undefined;

  useEffect(() => {
    writeBooleanPreference(GIT_FLUENT_COLLAPSED_STORAGE_KEY, !showGitFluentOverview);
  }, [showGitFluentOverview]);

  useEffect(() => {
    writeGitPanelViewOrder(panelViewOrder);
  }, [panelViewOrder]);

  useEffect(() => {
    writeStringPreference(GIT_FLUENT_ACTIVE_TAB_STORAGE_KEY, activeGitFluentTab);
  }, [activeGitFluentTab]);

  useEffect(() => {
    writeStringPreference(GIT_FLUENT_BRANCH_LAYOUT_STORAGE_KEY, gitFluentBranchLayout);
  }, [gitFluentBranchLayout]);

  useEffect(() => {
    writeStringPreference(GIT_FLUENT_REMOTE_BRANCH_LAYOUT_STORAGE_KEY, gitFluentRemoteBranchLayout);
  }, [gitFluentRemoteBranchLayout]);

  useEffect(() => {
    writeStringPreference(GIT_FLUENT_TOOLBAR_DENSITY_STORAGE_KEY, gitFluentToolbarDensity);
  }, [gitFluentToolbarDensity]);

  useEffect(() => {
    writeStringSet(GIT_FLUENT_COLLAPSED_GROUPS_STORAGE_KEY, collapsedGitFluentGroups);
  }, [collapsedGitFluentGroups]);

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setStatus(null);
      return;
    }
    try {
      const s = await gitStatus(rootPath, connId);
      setStatus(s);
      setError(null);
      gitStashList(rootPath, connId).then(setStashes).catch(() => {});
      gitWorktrees(rootPath, connId).then(setWorktrees).catch(() => setWorktrees([]));
    } catch (err) {
      setError(String(err));
    }
  }, [connId, rootPath]);

  // Load status when the folder changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setExpandedStashes(new Set());
    setStashFiles({});
    setStashFilesLoading({});
  }, [connId, rootPath]);

  /** Wraps an action with busy state, error capture, and a status refresh. */
  async function act(fn: () => Promise<unknown>) {
    if (!rootPath) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory() {
    if (!rootPath) return;
    try {
      setCommits(await gitLog(rootPath, 30, connId));
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadBranches() {
    if (!rootPath) return;
    try {
      const [local, remote] = await Promise.all([
        gitBranches(rootPath, connId),
        gitRemoteBranches(rootPath, connId),
      ]);
      setBranches(local);
      setRemoteBranches(remote);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadRemotes() {
    if (!rootPath) return;
    try {
      const [remoteList, remoteBranchList] = await Promise.all([
        gitRemotes(rootPath, connId),
        remoteBranches.length > 0 ? Promise.resolve(remoteBranches) : gitRemoteBranches(rootPath, connId),
      ]);
      setRemotes(remoteList);
      setRemoteBranches(remoteBranchList);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadStashes() {
    if (!rootPath) return;
    try {
      setStashes(await gitStashList(rootPath, connId));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadWorktrees() {
    if (!rootPath) return;
    try {
      setWorktrees(await gitWorktrees(rootPath, connId));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadStashFiles(index: number) {
    if (!rootPath) return;
    setStashFilesLoading((current) => ({ ...current, [index]: true }));
    try {
      const files = await gitStashFiles(rootPath, index, connId);
      setStashFiles((current) => ({ ...current, [index]: files }));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setStashFilesLoading((current) => ({ ...current, [index]: false }));
    }
  }

  function toggleStash(index: number) {
    setExpandedStashes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else {
        next.add(index);
        if (!stashFiles[index] && !stashFilesLoading[index]) void loadStashFiles(index);
      }
      return next;
    });
  }

  async function loadCommitGraph() {
    if (!rootPath) return;
    try {
      setGraphCommits(await gitGraph(rootPath, 80, connId));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadUpstreamComparison() {
    if (!rootPath) return;
    try {
      setUpstreamComparison(await gitCompareUpstream(rootPath, 40, connId));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    if (!rootPath || !showGitFluentOverview) return;
    if (activeGitFluentTab === "compare" && status?.hasUpstream && !upstreamComparison) {
      void loadUpstreamComparison();
    } else if (activeGitFluentTab === "graph" && graphCommits.length === 0) {
      void loadCommitGraph();
    } else if (activeGitFluentTab === "history" && commits.length === 0) {
      void loadHistory();
    } else if (
      activeGitFluentTab === "branches" &&
      branches.length === 0 &&
      remoteBranches.length === 0
    ) {
      void loadBranches();
    } else if (
      (activeGitFluentTab === "tags" || activeGitFluentTab === "contributors") &&
      graphCommits.length === 0
    ) {
      void loadCommitGraph();
    } else if (activeGitFluentTab === "remotes" && remotes.length === 0) {
      void loadRemotes();
    }
  }, [activeGitFluentTab, rootPath, showGitFluentOverview, status?.hasUpstream]);

  // File/Line History (ISSUE-71 + Git Fluent parity): when App sets a history
  // target, expand the History section and fetch either file commits or the
  // selected line's evolution via `git log -L`.
  useEffect(() => {
    if (!rootPath || !resolvedHistoryFile) {
      setFileCommits([]);
      return;
    }
    setActiveGitFluentTab("history");
    let cancelled = false;
    const request = resolvedHistoryLine
      ? gitLogLine(rootPath, resolvedHistoryFile, resolvedHistoryLine, 50, connId)
      : gitLogFile(rootPath, resolvedHistoryFile, 50, connId);
    request
      .then((c) => {
        if (!cancelled) setFileCommits(c);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [connId, rootPath, resolvedHistoryFile, resolvedHistoryLine]);

  const activeHistoryCommits = resolvedHistoryFile ? fileCommits : commits;
  const showRepositoryBody =
    embedded && typeof collapsed === "boolean" ? !collapsed : localShowRepositoryBody;
  const { conflicts, staged, changes } = useMemo(() => {
    const files = status?.files ?? [];
    return {
      conflicts: files.filter((file) => file.conflicted),
      staged: files.filter((file) => file.staged && !file.conflicted),
      changes: files.filter((file) => !file.staged && !file.conflicted),
    };
  }, [status?.files]);
  const totalChanges = conflicts.length + staged.length + changes.length;
  const stagedSummaryText = useMemo(() => {
    const stagedSummary = staged.reduce(
      (acc, file) => {
        const kind = badge(file).kind;
        if (kind === "added" || kind === "untracked") acc.added += 1;
        else if (kind === "deleted") acc.deleted += 1;
        else if (kind === "renamed") acc.renamed += 1;
        else acc.modified += 1;
        return acc;
      },
      { modified: 0, added: 0, deleted: 0, renamed: 0 }
    );
    return [
      stagedSummary.modified > 0
        ? `${stagedSummary.modified} modificado${stagedSummary.modified === 1 ? "" : "s"}`
        : "",
      stagedSummary.added > 0
        ? `${stagedSummary.added} novo${stagedSummary.added === 1 ? "" : "s"}`
        : "",
      stagedSummary.deleted > 0
        ? `${stagedSummary.deleted} removido${stagedSummary.deleted === 1 ? "" : "s"}`
        : "",
      stagedSummary.renamed > 0
        ? `${stagedSummary.renamed} renomeado${stagedSummary.renamed === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean).join(" · ");
  }, [staged]);
  const { gitFluentTags, gitFluentContributors } = useMemo(() => {
    const tags: GitFluentTagRef[] = [];
    const contributorMap = new Map<string, GitFluentContributor>();
    for (const commit of graphCommits) {
      for (const ref of commit.refs) {
        if (graphRefKind(ref) !== "tag") continue;
        tags.push({ name: graphRefLabel(ref), commit });
      }
      const contributorKey = `${commit.authorEmail || commit.author}`.toLowerCase();
      const current = contributorMap.get(contributorKey);
      if (current) {
        current.commits += 1;
      } else {
        contributorMap.set(contributorKey, {
          name: commit.author,
          email: commit.authorEmail ?? "",
          commits: 1,
          latestDate: commit.date,
          latestCommit: commit,
        });
      }
    }
    return {
      gitFluentTags: tags,
      gitFluentContributors: [...contributorMap.values()].sort(
        (a, b) => b.commits - a.commits || a.name.localeCompare(b.name)
      ),
    };
  }, [graphCommits]);
  const gitFluentGraphRows = useMemo(
    () => buildGitFluentGraphRows(graphCommits, status?.branch),
    [graphCommits, status?.branch]
  );
  const localBranchGroups = useMemo(() => buildGitFluentBranchGroups(branches, "local"), [branches]);
  const remoteBranchGroups = useMemo(
    () => buildGitFluentBranchGroups(remoteBranches, "remote"),
    [remoteBranches]
  );

  function toggleRepositoryBody() {
    const next = !showRepositoryBody;
    if (embedded && onCollapsedChange) {
      onCollapsedChange(!next);
    } else {
      setLocalShowRepositoryBody(next);
    }
  }

  if (!rootPath) {
    return (
      <div className={embedded ? "git-panel git-panel-embedded" : "git-panel"}>
        {!embedded && (
          <div className="explorer-header">
            <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
          </div>
        )}
        <div className="panel-empty">Abra uma pasta para usar o Git.</div>
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className={embedded ? "git-panel git-panel-embedded" : "git-panel"}>
        {!embedded && (
          <div className="explorer-header">
            <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
          </div>
        )}
        <div className="panel-empty">
          {rootName ? `${rootName} não é um repositório Git.` : "Esta pasta não é um repositório Git."}
        </div>
      </div>
    );
  }

  const repoRootPath = rootPath;
  const assistLabel =
    assistSource === "agent"
      ? "Última sugestão gerada pelo agente"
      : assistSource === "heuristic"
        ? "Última sugestão gerada pelo fallback local"
        : "Gerar sugestão usando agente; se indisponível, usa fallback local";

  function toggleGitFluentGroup(key: string) {
    setCollapsedGitFluentGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function gitFluentCollapsibleKeys(): string[] {
    switch (activeGitFluentTab) {
      case "branches":
        if (gitFluentBranchLayout === "list") return [];
        return [...localBranchGroups, ...remoteBranchGroups]
          .filter((group) => group.grouped)
          .map((group) => group.key);
      case "remotes":
        return buildGitFluentRemoteTree(remotes, remoteBranches).map((remote) => remote.key);
      case "repositories":
        return [];
      default:
        return [];
    }
  }

  function setGitFluentGroupsCollapsed(keys: string[], collapsed: boolean) {
    setCollapsedGitFluentGroups((current) => {
      const next = new Set(current);
      keys.forEach((key) => {
        if (collapsed) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  }

  function loadGitFluentRepositorySnapshot() {
    void Promise.all([
      refresh(),
      loadHistory(),
      loadBranches(),
      loadRemotes(),
      loadStashes(),
      loadWorktrees(),
      loadCommitGraph(),
    ]);
  }

  function selectGitFluentTab(tab: GitFluentTab) {
    setActiveGitFluentTab(tab);
    setShowGitFluentOverview(true);
    if (tab === "compare") {
      if (!upstreamComparison) void loadUpstreamComparison();
      return;
    }
    if (tab === "graph") {
      if (graphCommits.length === 0) void loadCommitGraph();
      return;
    }
    if (tab === "history") {
      if (commits.length === 0) void loadHistory();
      return;
    }
    if (tab === "branches") {
      if (branches.length === 0 && remoteBranches.length === 0) void loadBranches();
      return;
    }
    if (tab === "tags" || tab === "contributors") {
      if (graphCommits.length === 0) void loadCommitGraph();
      return;
    }
    if (tab === "remotes") {
      if (remotes.length === 0) void loadRemotes();
      return;
    }
    if (tab === "repositories") {
      loadGitFluentRepositorySnapshot();
      return;
    }
    if (tab === "stashes") {
      if (stashes.length === 0) void loadStashes();
      return;
    }
    if (tab === "worktrees") {
      if (worktrees.length === 0) void loadWorktrees();
      return;
    }
  }

  function openGitFluentWorkspace() {
    setShowGitFluentOverview(true);
    setActiveGitFluentTab("graph");
    if (graphCommits.length === 0) void loadCommitGraph();
    if (commits.length === 0) void loadHistory();
  }

  function showCommitInGraph(commit: GitCommit | GitGraphCommit) {
    setShowGitFluentOverview(true);
    setActiveGitFluentTab("graph");
    setSelectedGraphHash(commit.hash);
    if (graphCommits.length === 0) void loadCommitGraph();
  }

  function showBranchTipInGraph(branch: GitBranchInfo) {
    const tip =
      graphCommits.find((commit) => commit.hash.startsWith(branch.short) || commit.short === branch.short) ??
      ({
        hash: branch.short,
        short: branch.short,
        parents: [],
        refs: [branch.name],
        author: branch.author,
        date: branch.date,
        subject: branch.subject,
      } satisfies GitGraphCommit);
    showCommitInGraph(tip);
  }

  const copyToClipboard = (value: string | undefined) => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
  };

  const commitDetailsText = (commit: GitCommit | GitGraphCommit) =>
    `${commit.short} ${commit.subject}\n${commit.author} - ${commit.date}\n${commit.hash}`;

  const branchDetailsText = (branch: GitBranchInfo) => {
    const sync =
      branch.hasUpstream && (branch.ahead > 0 || branch.behind > 0)
        ? `\nSync: ${branch.ahead} ahead, ${branch.behind} behind`
        : "";
    return `${branch.name}\nTip: ${branch.short}\n${branch.subject}\n${branch.author} - ${branch.date}${sync}`;
  };

  const remoteDetailsText = (remote: GitRemoteInfo) =>
    `${remote.name}\nFetch: ${remote.fetchUrl}\nPush: ${remote.pushUrl}`;

  const tagDetailsText = (tag: GitFluentTagRef) =>
    `${tag.name}\n${commitDetailsText(tag.commit)}`;

  const contributorDetailsText = (contributor: GitFluentContributor) =>
    `${contributor.name}${contributor.email ? ` <${contributor.email}>` : ""}\nCommits: ${contributor.commits}\nUltimo commit: ${commitDetailsText(contributor.latestCommit)}`;

  const worktreeDetailsText = (worktree: GitWorktreeInfo) =>
    [
      `Path: ${worktree.path}`,
      worktree.branch ? `Branch: ${worktree.branch}` : null,
      worktree.head ? `HEAD: ${worktree.head}` : null,
      worktree.current ? "Atual: sim" : "Atual: nao",
      worktree.detached ? "Detached: sim" : null,
    ]
      .filter(Boolean)
      .join("\n");

  const generateCommitMessage = async () => {
    const sourceFiles = staged.length > 0 ? staged : changes;
    if (sourceFiles.length === 0) return;
    const fallback = buildCommitMessage(sourceFiles, commits);
    try {
      const recentCommits =
        commits.length > 0 ? commits : await gitLog(rootPath, 16, connId);
      if (commits.length === 0) setCommits(recentCommits);
      const result = await suggestWithGitAssistant(
        {
          kind: "commitMessage",
          repoName: rootName || fileName(rootPath),
          rootPath,
          branch: status?.branch || "workspace",
          provider,
          files: sourceFiles,
          recentCommits,
          fallback: buildCommitMessage(sourceFiles, recentCommits),
          preferences: gitAssistPreferences,
        },
        gitAssistant
      );
      setMessage(result.value);
      setAssistSource(result.source);
      setError(null);
    } catch (err) {
      setMessage(fallback || buildCommitMessage(sourceFiles, []));
      setAssistSource("heuristic");
      setError(String(err));
    }
  };

  const createSuggestedBranch = async () => {
    const sourceFiles = [...staged, ...changes];
    let recentCommits = commits;
    try {
      if (recentCommits.length === 0) {
        recentCommits = await gitLog(rootPath, 12, connId);
        setCommits(recentCommits);
      }
    } catch {
      recentCommits = [];
    }
    const fallback = buildBranchName(sourceFiles, recentCommits, status?.branch || "workspace");
    const result = await suggestWithGitAssistant(
      {
        kind: "branchName",
        repoName: rootName || fileName(rootPath),
        rootPath,
        branch: status?.branch || "workspace",
        provider,
        files: sourceFiles,
        recentCommits,
        fallback,
        preferences: gitAssistPreferences,
      },
      gitAssistant
    );
    const suggested = result.value;
    setAssistSource(result.source);
    const raw = window.prompt("Nome da nova branch", suggested);
    if (raw === null) return;
    const name = raw.trim();
    if (!name) return;
    await act(async () => {
      await gitCreateBranch(rootPath, name, connId);
      await loadBranches();
    });
  };

  const checkoutRemoteBranch = (branch: GitBranchInfo) =>
    act(async () => {
      const suggested = localNameFromRemoteBranch(branch.name);
      const raw = window.prompt(`Criar branch local rastreando ${branch.name}`, suggested);
      if (raw === null) return;
      const localName = raw.trim();
      if (!localName) return;
      await gitCheckoutRemoteBranch(rootPath, branch.name, localName, connId);
      await loadBranches();
    });

  const deleteRemoteBranch = (branch: GitBranchInfo) =>
    act(async () => {
      const parts = remoteBranchParts(branch.name, remotes);
      if (!parts) {
        setError(`Nao foi possivel identificar o remoto de ${branch.name}.`);
        return;
      }
      if (
        !window.confirm(
          `Excluir a branch remota "${parts.remote}/${parts.branch}"?\n\nIsso executa git push ${parts.remote} --delete ${parts.branch}.`
        )
      )
        return;
      await gitDeleteRemoteBranch(rootPath, parts.remote, parts.branch, connId);
      await Promise.all([loadBranches(), loadRemotes(), loadCommitGraph()]);
    });

  const fetchRemoteBranch = (branch: GitBranchInfo) =>
    act(async () => {
      const parts = remoteBranchParts(branch.name, remotes);
      if (!parts) {
        setError(`Nao foi possivel identificar o remoto de ${branch.name}.`);
        return;
      }
      await gitFetchRemote(rootPath, parts.remote, connId);
      await Promise.all([loadBranches(), loadRemotes(), loadCommitGraph()]);
    });

  const renameBranch = (branch: GitBranchInfo) =>
    act(async () => {
      const raw = window.prompt("Novo nome da branch", branch.name);
      if (raw === null) return;
      const nextName = raw.trim();
      if (!nextName || nextName === branch.name) return;
      await gitRenameBranch(rootPath, branch.name, nextName, connId);
      await loadBranches();
    });

  const deleteBranch = (branch: GitBranchInfo) =>
    act(async () => {
      if (branch.current) return;
      if (!window.confirm(`Excluir a branch "${branch.name}"?`)) return;
      const force = window.confirm(
        `Forçar exclusão de "${branch.name}"?\n\nOK usa git branch -D. Cancelar usa git branch -d.`
      );
      await gitDeleteBranch(rootPath, branch.name, force, connId);
      await loadBranches();
    });

  const addRemote = () =>
    act(async () => {
      const rawName = window.prompt("Nome do remoto", remotes.some((remote) => remote.name === "origin") ? "" : "origin");
      if (rawName === null) return;
      const name = rawName.trim();
      if (!name) return;
      const rawUrl = window.prompt(`URL do remoto ${name}`);
      if (rawUrl === null) return;
      const url = rawUrl.trim();
      if (!url) return;
      await gitRemoteAdd(rootPath, name, url, connId);
      await loadRemotes();
    });

  const fetchRemote = (remote: GitRemoteInfo) =>
    act(async () => {
      await gitFetchRemote(rootPath, remote.name, connId);
      await Promise.all([loadRemotes(), loadBranches(), loadCommitGraph()]);
    });

  const editRemote = (remote: GitRemoteInfo) =>
    act(async () => {
      const rawName = window.prompt("Nome do remoto", remote.name);
      if (rawName === null) return;
      const nextName = rawName.trim();
      if (!nextName) return;
      const rawUrl = window.prompt(`URL de fetch para ${nextName}`, remote.fetchUrl);
      if (rawUrl === null) return;
      const nextUrl = rawUrl.trim();
      if (!nextUrl) return;
      if (nextName !== remote.name) {
        await gitRemoteRename(rootPath, remote.name, nextName, connId);
      }
      if (nextUrl !== remote.fetchUrl) {
        await gitRemoteSetUrl(rootPath, nextName, nextUrl, connId);
      }
      await Promise.all([loadRemotes(), loadBranches()]);
    });

  const removeRemote = (remote: GitRemoteInfo) =>
    act(async () => {
      if (!window.confirm(`Remover o remoto "${remote.name}"?`)) return;
      await gitRemoteRemove(rootPath, remote.name, connId);
      await Promise.all([loadRemotes(), loadBranches()]);
    });

  const createWorktree = async () => {
    const sourceFiles = [...staged, ...changes];
    let recentCommits = commits;
    try {
      if (recentCommits.length === 0) {
        recentCommits = await gitLog(rootPath, 12, connId);
        setCommits(recentCommits);
      }
    } catch {
      recentCommits = [];
    }
    const suggestedBranch = buildBranchName(sourceFiles, recentCommits, status?.branch || "workspace");
    const rawBranch = window.prompt(
      "Branch ou ref da worktree. Deixe vazio para o Git escolher.",
      suggestedBranch,
    );
    if (rawBranch === null) return;
    const branchOrRef = rawBranch.trim();
    const createBranch = branchOrRef
      ? window.confirm(
          `Criar a branch "${branchOrRef}" a partir de HEAD?\n\nCancelar usa uma branch/ref já existente.`,
        )
      : false;
    const rawTarget = window.prompt(
      "Pasta da nova worktree",
      siblingWorktreePath(rootPath, branchOrRef || "worktree"),
    );
    if (rawTarget === null) return;
    const target = rawTarget.trim();
    if (!target) return;
    await act(async () => {
      await gitWorktreeAdd(rootPath, target, branchOrRef || undefined, createBranch, connId);
      setActiveGitFluentTab("worktrees");
    });
  };

  const createWorktreeFromRef = (ref: string) =>
    act(async () => {
      const rawRef = window.prompt("Branch ou ref da worktree", ref);
      if (rawRef === null) return;
      const branchOrRef = rawRef.trim();
      if (!branchOrRef) return;
      const rawTarget = window.prompt(
        "Pasta da nova worktree",
        siblingWorktreePath(rootPath, branchOrRef),
      );
      if (rawTarget === null) return;
      const target = rawTarget.trim();
      if (!target) return;
      await gitWorktreeAdd(rootPath, target, branchOrRef, false, connId);
      setActiveGitFluentTab("worktrees");
    });

  const removeWorktree = (worktree: GitWorktreeInfo) =>
    act(async () => {
      if (worktree.current) return;
      if (!window.confirm(`Remover a worktree "${shortPath(worktree.path)}"?`)) return;
      await gitWorktreeRemove(rootPath, worktree.path, false, connId);
      setActiveGitFluentTab("worktrees");
    });

  const revealWorktree = (worktree: GitWorktreeInfo) =>
    act(async () => {
      if (provider === "ssh") {
        setError("Revelar no Explorer ainda esta disponivel apenas para worktrees locais.");
        return;
      }
      await revealInExplorer(worktree.path, worktree.path);
    });

  const openWorktreeInCurrentWindow = (worktree: GitWorktreeInfo) => {
    if (provider === "ssh" || !onOpenLocalFolderInCurrentWindow) return;
    onOpenLocalFolderInCurrentWindow(worktree.path);
  };

  const openWorktreeInNewWindow = (worktree: GitWorktreeInfo) => {
    if (provider === "ssh" || !onOpenLocalFolderInNewWindow) return;
    onOpenLocalFolderInNewWindow(worktree.path);
  };

  const discardFile = (f: GitFileStatus) =>
    act(async () => {
      if (
        !window.confirm(
          `Descartar as alterações de "${fileName(f.path)}"? Esta ação não pode ser desfeita.`
        )
      )
        return;
      await gitDiscardFile(rootPath, f.path, f.untracked, connId);
    });

  const openSourceControlItem = (f: GitFileStatus, view: GitChangeView = "working") => {
    const absolutePath = `${rootPath}/${f.path}`;
    if (onOpenChanges) onOpenChanges(absolutePath, rootPath, connId, view);
    else onOpenFile(absolutePath, fileName(f.path));
  };

  const openStashFile = (stash: GitStashEntry, file: GitStashFile) => {
    const absolutePath = joinRepoPath(rootPath, file.path);
    const ref = `stash@{${stash.index}}`;
    if (onOpenRevisionDiff) {
      onOpenRevisionDiff(absolutePath, ref, ref, "previous", rootPath, connId);
    } else if (onOpenRevision) {
      onOpenRevision(absolutePath, ref, ref, rootPath, connId);
    } else {
      onOpenFile(absolutePath, fileName(file.path));
    }
  };

  const openFirstStagedChange = () => {
    const first = staged[0];
    if (!first) return;
    openSourceControlItem(first, "staged");
  };

  // Right-click menu for a changed file (issue #9). The row's primary click
  // opens Changes, like VS Code Source Control; "Abrir Arquivo" remains here.
  const openFileMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const menuSeparator = (id: string): ContextMenuItem => ({
    id,
    label: "",
    separator: true,
  });

  const gitFluentTabMenuItem = (prefix: string, tab: (typeof GIT_FLUENT_TABS)[number]): ContextMenuItem => ({
    id: `${prefix}-view-${tab.id}`,
    label: tab.label,
    icon: activeGitFluentTab === tab.id ? "success" : tab.icon,
    run: () => selectGitFluentTab(tab.id),
  });

  const gitFluentTabById = (tabId: GitFluentTab) => {
    const tab = GIT_FLUENT_TABS.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Git Fluent tab not registered: ${tabId}`);
    return tab;
  };

  const gitFluentTabMenuSection = (
    prefix: string,
    id: string,
    label: string,
    icon: IconAction,
    tabs: GitFluentTab[]
  ): ContextMenuItem => ({
    id: `${prefix}-${id}`,
    label,
    icon,
    submenu: tabs.map((tabId) => gitFluentTabMenuItem(prefix, gitFluentTabById(tabId))),
  });

  const gitFluentViewNavigationMenu = (prefix: string): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      gitFluentTabMenuSection(prefix, "timeline", "Grafo", "graph", ["graph"]),
      gitFluentTabMenuSection(prefix, "refs", "Branches e remotos", "gitBranch", [
        "branches",
        "remotes",
        "tags",
      ]),
      gitFluentTabMenuSection(prefix, "work", "Trabalho local", "folderOpened", [
        "worktrees",
        "stashes",
      ]),
      gitFluentTabMenuItem(prefix, gitFluentTabById("contributors")),
    ];

    return items;
  };

  const gitFluentViewOptionsMenu = (): ContextMenuItem[] => {
    const collapsibleKeys = gitFluentCollapsibleKeys();
    const hasCollapsibleGroups = collapsibleKeys.length > 0;
    const hasExpandedGroups = collapsibleKeys.some((key) => !collapsedGitFluentGroups.has(key));
    const hasCollapsedGroups = collapsibleKeys.some((key) => collapsedGitFluentGroups.has(key));

    return [
      {
        id: "git-fluent-expand-current-view",
        label: "Expandir grupos desta view",
        icon: "chevronDown",
        enabled: hasCollapsibleGroups && hasCollapsedGroups,
        run: () => setGitFluentGroupsCollapsed(collapsibleKeys, false),
      },
      {
        id: "git-fluent-collapse-current-view",
        label: "Recolher grupos desta view",
        icon: "chevronRight",
        enabled: hasCollapsibleGroups && hasExpandedGroups,
        run: () => setGitFluentGroupsCollapsed(collapsibleKeys, true),
      },
      menuSeparator("git-fluent-view-options-sep-collapse"),
      {
        id: "git-fluent-branch-layout",
        label: "Branches como",
        icon: "gitBranch",
        submenu: [
          {
            id: "git-fluent-branch-layout-tree",
            label: "Árvore",
            icon: gitFluentBranchLayout === "tree" ? "success" : "organizeImports",
            run: () => setGitFluentBranchLayout("tree"),
          },
          {
            id: "git-fluent-branch-layout-list",
            label: "Lista",
            icon: gitFluentBranchLayout === "list" ? "success" : "formatDocument",
            run: () => setGitFluentBranchLayout("list"),
          },
        ],
      },
      {
        id: "git-fluent-remote-branch-layout",
        label: "Branches remotas como",
        icon: "remote",
        submenu: [
          {
            id: "git-fluent-remote-branch-layout-tree",
            label: "Árvore",
            icon: gitFluentRemoteBranchLayout === "tree" ? "success" : "organizeImports",
            run: () => setGitFluentRemoteBranchLayout("tree"),
          },
          {
            id: "git-fluent-remote-branch-layout-list",
            label: "Lista",
            icon: gitFluentRemoteBranchLayout === "list" ? "success" : "formatDocument",
            run: () => setGitFluentRemoteBranchLayout("list"),
          },
        ],
      },
      {
        id: "git-fluent-toolbar-density",
        label: "Toolbar",
        icon: "commandPalette",
        submenu: [
          {
            id: "git-fluent-toolbar-density-compact",
            label: "Compacta",
            icon: gitFluentToolbarDensity === "compact" ? "success" : "collapseAll",
            run: () => setGitFluentToolbarDensity("compact"),
          },
          {
            id: "git-fluent-toolbar-density-comfortable",
            label: "Confortável",
            icon: gitFluentToolbarDensity === "comfortable" ? "success" : "organizeImports",
            run: () => setGitFluentToolbarDensity("comfortable"),
          },
        ],
      },
    ];
  };

  const commitContextMenu = (commit: GitCommit | GitGraphCommit): ContextMenuItem[] => [
    {
      id: "show-commit-graph",
      label: "Mostrar no grafo",
      icon: "graph",
      run: () => showCommitInGraph(commit),
    },
    {
      id: "show-commit-files",
      label: "Mostrar arquivos do commit",
      icon: "openChanges",
      run: () => showCommitInGraph(commit),
    },
    menuSeparator("sep-commit-navigation"),
    {
      id: "copy-hash",
      label: "Copiar hash",
      icon: "copy",
      run: () => copyToClipboard(commit.hash),
    },
    {
      id: "copy-subject",
      label: "Copiar mensagem",
      icon: "copyPath",
      run: () => copyToClipboard(commit.subject),
    },
    {
      id: "copy-details",
      label: "Copiar detalhes",
      icon: "gitCommit",
      run: () => copyToClipboard(commitDetailsText(commit)),
    },
    {
      id: "copy-markdown",
      label: "Copiar Markdown",
      icon: "file",
      run: () => copyToClipboard(`- \`${commit.short}\` ${commit.subject} (${commit.author}, ${commit.date})`),
    },
    {
      id: "copy-remote-url",
      label: "Copiar URL remota",
      icon: "copyPath",
      enabled: Boolean(commit.remoteUrl),
      title: commit.remoteUrl ? undefined : "Sem URL remota.",
      run: () => copyToClipboard(commit.remoteUrl),
    },
    {
      id: "open-remote",
      label: "Abrir commit remoto",
      icon: "remote",
      enabled: Boolean(commit.remoteUrl),
      title: commit.remoteUrl ? undefined : "Sem URL remota.",
      run: () => openExternal(commit.remoteUrl),
    },
    menuSeparator("sep-commit-actions"),
    {
      id: "revert",
      label: "Reverter commit",
      icon: "discard",
      run: () =>
        act(async () => {
          if (!window.confirm(`Reverter o commit ${commit.short}?`)) return;
          await gitRevertCommit(rootPath, commit.hash, connId);
          await Promise.all([loadCommitGraph(), loadHistory()]);
        }),
    },
  ];

  const branchContextMenu = (branch: GitBranchInfo): ContextMenuItem[] => [
    {
      id: "checkout",
      label: branch.current ? "Branch atual" : "Checkout",
      icon: "arrowLeft",
      enabled: !branch.current,
      run: () => act(() => gitCheckout(rootPath, branch.name, connId).then(loadBranches)),
    },
    {
      id: "show-tip",
      label: "Mostrar último commit no grafo",
      icon: "graph",
      run: () => showBranchTipInGraph(branch),
    },
    {
      id: "new-worktree",
      label: "Nova worktree desta branch",
      icon: "folderOpened",
      enabled: !branch.current,
      title: branch.current ? "Crie uma nova branch para abrir outra worktree a partir da branch atual." : undefined,
      run: () => createWorktreeFromRef(branch.name),
    },
    menuSeparator("sep-branch-copy"),
    {
      id: "copy-name",
      label: "Copiar nome",
      icon: "copy",
      run: () => copyToClipboard(branch.name),
    },
    {
      id: "copy-tip",
      label: "Copiar hash do último commit",
      icon: "gitCommit",
      run: () => copyToClipboard(branch.short),
    },
    {
      id: "copy-branch-details",
      label: "Copiar detalhes da branch",
      icon: "copyPath",
      run: () => copyToClipboard(branchDetailsText(branch)),
    },
    menuSeparator("sep-branch-actions"),
    {
      id: "rename",
      label: "Renomear",
      icon: "rename",
      run: () => renameBranch(branch),
    },
    {
      id: "delete",
      label: branch.current ? "Não é possível excluir a branch atual" : "Excluir branch",
      icon: "trash",
      enabled: !branch.current,
      run: () => deleteBranch(branch),
    },
  ];

  const remoteBranchContextMenu = (branch: GitBranchInfo): ContextMenuItem[] => [
    {
      id: "checkout-local",
      label: "Criar branch local rastreada",
      icon: "arrowLeft",
      run: () => checkoutRemoteBranch(branch),
    },
    {
      id: "show-tip",
      label: "Mostrar último commit no grafo",
      icon: "graph",
      run: () => showBranchTipInGraph(branch),
    },
    {
      id: "fetch-remote",
      label: "Fetch do remoto",
      icon: "sync",
      run: () => fetchRemoteBranch(branch),
    },
    {
      id: "new-worktree",
      label: "Nova worktree desta branch remota",
      icon: "folderOpened",
      run: () => createWorktreeFromRef(branch.name),
    },
    menuSeparator("sep-remote-branch-copy"),
    {
      id: "copy-name",
      label: "Copiar nome",
      icon: "copy",
      run: () => copyToClipboard(branch.name),
    },
    {
      id: "copy-tip",
      label: "Copiar hash do último commit",
      icon: "gitCommit",
      run: () => copyToClipboard(branch.short),
    },
    {
      id: "copy-remote-branch-details",
      label: "Copiar detalhes da branch",
      icon: "copyPath",
      run: () => copyToClipboard(branchDetailsText(branch)),
    },
    menuSeparator("sep-remote-branch-actions"),
    {
      id: "delete-remote-branch",
      label: "Excluir branch remota",
      icon: "trash",
      run: () => deleteRemoteBranch(branch),
    },
  ];

  const remoteContextMenu = (remote: GitRemoteInfo): ContextMenuItem[] => [
    {
      id: "fetch",
      label: `Fetch ${remote.name}`,
      icon: "refresh",
      run: () => fetchRemote(remote),
    },
    {
      id: "copy-fetch-url",
      label: "Copiar URL de fetch",
      icon: "copy",
      run: () => copyToClipboard(remote.fetchUrl),
    },
    {
      id: "copy-push-url",
      label: "Copiar URL de push",
      icon: "copyPath",
      run: () => copyToClipboard(remote.pushUrl),
    },
    {
      id: "copy-remote-details",
      label: "Copiar detalhes do remoto",
      icon: "remote",
      run: () => copyToClipboard(remoteDetailsText(remote)),
    },
    {
      id: "open-remote-url",
      label: "Abrir remoto no navegador",
      icon: "remote",
      enabled: /^https?:\/\//i.test(remote.fetchUrl),
      run: () => openExternal(remote.fetchUrl.replace(/\.git$/i, "")),
    },
    menuSeparator("sep-remote-actions"),
    {
      id: "edit",
      label: "Editar remoto",
      icon: "rename",
      run: () => editRemote(remote),
    },
    {
      id: "remove",
      label: "Remover remoto",
      icon: "trash",
      run: () => removeRemote(remote),
    },
  ];

  const stashContextMenu = (stash: GitStashEntry): ContextMenuItem[] => [
    {
      id: "expand",
      label: expandedStashes.has(stash.index) ? "Recolher stash" : "Expandir stash",
      icon: expandedStashes.has(stash.index) ? "chevronRight" : "chevronDown",
      run: () => toggleStash(stash.index),
    },
    {
      id: "apply",
      label: "Aplicar",
      icon: "add",
      run: () => act(() => gitStashApply(rootPath, stash.index, connId)),
    },
    {
      id: "pop",
      label: "Pop",
      icon: "gitPull",
      run: () => act(() => gitStashPop(rootPath, stash.index, connId)),
    },
    menuSeparator("sep-stash-actions"),
    {
      id: "drop",
      label: "Descartar stash",
      icon: "trash",
      run: () =>
        act(async () => {
          if (!window.confirm("Descartar este stash?")) return;
          await gitStashDrop(rootPath, stash.index, connId);
        }),
    },
  ];

  const worktreeContextMenu = (worktree: GitWorktreeInfo): ContextMenuItem[] => [
    {
      id: "open-worktree-current-window",
      label: provider === "ssh" ? "Abrir indisponível em SSH" : "Abrir nesta janela",
      icon: "openWith",
      enabled: provider !== "ssh" && Boolean(onOpenLocalFolderInCurrentWindow),
      title: provider === "ssh" ? "Abrir worktrees em janela ainda está disponível apenas para repositórios locais." : undefined,
      run: () => openWorktreeInCurrentWindow(worktree),
    },
    {
      id: "open-worktree-new-window",
      label: provider === "ssh" ? "Nova janela indisponível em SSH" : "Abrir em nova janela",
      icon: "splitEditor",
      enabled: provider !== "ssh" && Boolean(onOpenLocalFolderInNewWindow),
      title: provider === "ssh" ? "Abrir worktrees em janela ainda está disponível apenas para repositórios locais." : undefined,
      run: () => openWorktreeInNewWindow(worktree),
    },
    menuSeparator("sep-worktree-open"),
    {
      id: "reveal-worktree",
      label: provider === "ssh" ? "Revelar indisponível em SSH" : "Revelar no Explorer",
      icon: "revealExplorer",
      enabled: provider !== "ssh",
      title: provider === "ssh" ? "Revelar no Explorer ainda está disponível apenas para worktrees locais." : undefined,
      run: () => revealWorktree(worktree),
    },
    menuSeparator("sep-worktree-navigation"),
    {
      id: "copy-path",
      label: "Copiar caminho",
      icon: "copyPath",
      run: () => copyToClipboard(worktree.path),
    },
    {
      id: "copy-branch",
      label: "Copiar branch",
      icon: "gitBranch",
      enabled: Boolean(worktree.branch),
      run: () => copyToClipboard(worktree.branch),
    },
    {
      id: "copy-head",
      label: "Copiar HEAD",
      icon: "gitCommit",
      enabled: Boolean(worktree.head),
      run: () => copyToClipboard(worktree.head),
    },
    {
      id: "copy-worktree-details",
      label: "Copiar detalhes da worktree",
      icon: "copy",
      run: () => copyToClipboard(worktreeDetailsText(worktree)),
    },
    menuSeparator("sep-worktree-actions"),
    {
      id: "remove",
      label: worktree.current ? "Worktree atual" : "Remover worktree",
      icon: "trash",
      enabled: !worktree.current,
      run: () => removeWorktree(worktree),
    },
  ];

  const tagContextMenu = (tag: GitFluentTagRef): ContextMenuItem[] => [
    {
      id: "copy-tag",
      label: "Copiar tag",
      icon: "copy",
      run: () => copyToClipboard(tag.name),
    },
    {
      id: "copy-hash",
      label: "Copiar hash do commit",
      icon: "gitCommit",
      run: () => copyToClipboard(tag.commit.hash),
    },
    {
      id: "copy-tag-details",
      label: "Copiar detalhes da tag",
      icon: "copyPath",
      run: () => copyToClipboard(tagDetailsText(tag)),
    },
    menuSeparator("sep-tag-actions"),
    {
      id: "show-commit",
      label: "Mostrar no grafo",
      icon: "graph",
      run: () => {
        setSelectedGraphHash(tag.commit.hash);
        selectGitFluentTab("graph");
      },
    },
    {
      id: "open-remote",
      label: "Abrir commit remoto",
      icon: "remote",
      enabled: Boolean(tag.commit.remoteUrl),
      title: tag.commit.remoteUrl ? undefined : "Sem URL remota.",
      run: () => openExternal(tag.commit.remoteUrl),
    },
    {
      id: "new-worktree",
      label: "Nova worktree desta tag",
      icon: "folderOpened",
      run: () => createWorktreeFromRef(tag.name),
    },
  ];

  const contributorContextMenu = (contributor: GitFluentContributor): ContextMenuItem[] => [
    {
      id: "copy-author",
      label: "Copiar autor",
      icon: "copy",
      run: () => copyToClipboard(contributor.name),
    },
    {
      id: "copy-email",
      label: "Copiar email",
      icon: "copyPath",
      enabled: Boolean(contributor.email),
      run: () => copyToClipboard(contributor.email),
    },
    {
      id: "copy-contributor-details",
      label: "Copiar detalhes da pessoa",
      icon: "account",
      run: () => copyToClipboard(contributorDetailsText(contributor)),
    },
    menuSeparator("sep-contributor-actions"),
    {
      id: "show-latest",
      label: "Mostrar último commit no grafo",
      icon: "graph",
      run: () => {
        setSelectedGraphHash(contributor.latestCommit.hash);
        selectGitFluentTab("graph");
      },
    },
  ];

  const gitFluentViewMenu = (): ContextMenuItem[] => [
    {
      id: "refresh-view",
      label: "Atualizar view atual",
      icon: "refresh",
      run: () => {
        if (activeGitFluentTab === "graph") void loadCommitGraph();
        else if (activeGitFluentTab === "history") void loadHistory();
        else if (activeGitFluentTab === "branches") void loadBranches();
        else if (activeGitFluentTab === "remotes") void loadRemotes();
        else if (activeGitFluentTab === "tags" || activeGitFluentTab === "contributors") void loadCommitGraph();
        else if (activeGitFluentTab === "stashes") void loadStashes();
        else if (activeGitFluentTab === "worktrees") void loadWorktrees();
        else if (activeGitFluentTab === "repositories") loadGitFluentRepositorySnapshot();
        else if (activeGitFluentTab === "compare") void loadUpstreamComparison();
      },
    },
    {
      id: "open-git-fluent-workspace",
      label: "Abrir Git Fluent em aba",
      icon: "openWith",
      run: openGitFluentWorkspace,
    },
    menuSeparator("sep-git-fluent-commands"),
    {
      id: "git-fluent-fetch",
      label: "Fetch",
      icon: "sync",
      enabled: !busy,
      run: () => act(() => gitFetch(rootPath, connId)),
    },
    {
      id: "git-fluent-pull",
      label: "Pull",
      icon: "gitPull",
      enabled: !busy && Boolean(status?.hasUpstream),
      title: status?.hasUpstream ? undefined : "A branch atual não tem upstream configurado.",
      run: () => act(() => gitPull(rootPath, connId)),
    },
    {
      id: "git-fluent-push",
      label: "Push",
      icon: "gitPush",
      enabled: !busy && Boolean(status?.hasUpstream),
      title: status?.hasUpstream ? undefined : "A branch atual não tem upstream configurado.",
      run: () => act(() => gitPush(rootPath, connId)),
    },
    {
      id: "git-fluent-stash",
      label: "Guardar alterações (stash)",
      icon: "bookmark",
      enabled: !busy && (status?.files.length ?? 0) > 0,
      run: stashGitFluentChanges,
    },
    menuSeparator("sep-git-fluent-views"),
    ...gitFluentViewNavigationMenu("git-fluent"),
    menuSeparator("sep-git-fluent-view-options"),
    {
      id: "git-fluent-view-options",
      label: "Opções da view",
      icon: "settings",
      submenu: gitFluentViewOptionsMenu(),
    },
    menuSeparator("sep-git-fluent-data"),
    {
      id: "load-all",
      label: "Carregar dados do Git Fluent",
      icon: "sync",
      run: () => {
        void Promise.all([
          loadCommitGraph(),
          loadHistory(),
          loadBranches(),
          loadRemotes(),
          loadStashes(),
          loadWorktrees(),
          loadUpstreamComparison(),
        ]);
      },
    },
  ];

  const fileMenu = (
    f: GitFileStatus,
    group: "conflict" | "staged" | "changes"
  ): ContextMenuItem[] => {
    const open: ContextMenuItem = {
      id: "open",
      label: "Abrir Arquivo",
      icon: "file",
      run: () => onOpenFile(`${rootPath}/${f.path}`, fileName(f.path)),
    };
    const openChanges: ContextMenuItem = {
      id: "openChanges",
      label: "Abrir Alterações",
      icon: "openChanges",
      enabled: Boolean(onOpenChanges),
      title: onOpenChanges ? undefined : "Visualização de diff indisponível.",
      run: onOpenChanges
        ? () =>
            onOpenChanges(
              `${rootPath}/${f.path}`,
              rootPath,
              connId,
              group === "staged" ? "staged" : "working"
            )
        : undefined,
    };
    const sep: ContextMenuItem = { id: "sep", label: "", separator: true };
    if (group === "conflict") {
      return [
        open,
        sep,
        {
          id: "resolve",
          label: "Marcar como resolvido",
          icon: "success",
          run: () => act(() => gitStage(rootPath, f.path, connId)),
        },
      ];
    }
    if (group === "staged") {
      return [
        open,
        openChanges,
        sep,
        {
          id: "unstage",
          label: "Remover do stage",
          icon: "remove",
          run: () => act(() => gitUnstage(rootPath, f.path, connId)),
        },
      ];
    }
    return [
      open,
      openChanges,
      sep,
      {
        id: "stage",
        label: "Preparar (stage)",
        icon: "add",
        run: () => act(() => gitStage(rootPath, f.path, connId)),
      },
      {
        id: "discard",
        label: "Descartar Alterações",
        icon: "discard",
        run: () => discardFile(f),
      },
    ];
  };

  const actionButtons = (
    <div className="git-actions">
      <Tooltip label="Atualizar status">
        <button
          className="git-icon-btn"
          aria-label="Atualizar status"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <Codicon name="refresh" />
        </button>
      </Tooltip>
      {embedded && onHideRepository && (
        <Tooltip label="Ocultar repositório">
          <button
            className="git-icon-btn"
            aria-label="Ocultar repositório"
            onClick={onHideRepository}
          >
            <Codicon name="close" />
          </button>
        </Tooltip>
      )}
    </div>
  );

  const gitFluentTabCounts: Record<GitFluentTab, number | undefined> = {
    compare: (status?.ahead ?? 0) + (status?.behind ?? 0) || undefined,
    graph: graphCommits.length || undefined,
    history: resolvedHistoryFile ? activeHistoryCommits.length || undefined : undefined,
    branches: branches.length + remoteBranches.length || undefined,
    remotes: remotes.length || undefined,
    tags: gitFluentTags.length || undefined,
    contributors: gitFluentContributors.length || undefined,
    stashes: stashes.length || undefined,
    worktrees: worktrees.length || undefined,
    repositories: undefined,
  };

  function stashGitFluentChanges() {
    if (!rootPath) return;
    const raw = window.prompt("Mensagem do stash (opcional):");
    if (raw === null) return;
    void act(() => gitStashPush(rootPath, raw || undefined, connId));
  }

  const historyScope = resolvedHistoryFile
    ? {
        type: resolvedHistoryLine ? "line" : "file",
        label: resolvedHistoryLine
          ? `Linha ${resolvedHistoryLine} · ${fileName(resolvedHistoryFile)}`
          : fileName(resolvedHistoryFile),
        detail: shortPath(resolvedHistoryFile),
        onClear: onClearHistoryFile,
      } as const
    : {
        type: "repository",
        label: "Histórico do repositório",
        detail: status?.branch ? `Branch ${status.branch}` : rootName || fileName(rootPath),
      } as const;
  const gitFluentViewActions = (
    <GitFluentViewActions
      activeTab={activeGitFluentTab}
      busy={busy}
      hasUpstream={Boolean(status?.hasUpstream)}
      onCreateSuggestedBranch={() => void createSuggestedBranch()}
      onRefreshBranches={() => void loadBranches()}
      onAddRemote={addRemote}
      onRefreshRemotes={() => void loadRemotes()}
      onRefreshGraph={() => void loadCommitGraph()}
      onRefreshStashes={() => void loadStashes()}
      onCreateWorktree={() => void createWorktree()}
      onPruneWorktrees={() => act(() => gitWorktreePrune(rootPath, connId))}
      onRefreshCompare={() => void loadUpstreamComparison()}
      onRefreshHistory={() => void loadHistory()}
      onRefreshRepository={loadGitFluentRepositorySnapshot}
    />
  );
  const gitFluentHeaderActions = (
    <GitFluentToolbar
      activeTab={activeGitFluentTab}
      counts={gitFluentTabCounts}
      density={gitFluentToolbarDensity}
      viewActions={gitFluentViewActions}
      onSelectTab={selectGitFluentTab}
      onOpenMenu={(event) => openFileMenu(event, gitFluentViewMenu())}
    />
  );

  const sourceControlCount = totalChanges || undefined;

  function movePanelView(from: GitPanelViewId, to: GitPanelViewId) {
    if (from === to) return;
    setPanelViewOrder((current) => {
      const next = current.filter((view) => view !== from);
      const targetIndex = next.indexOf(to);
      next.splice(targetIndex === -1 ? next.length : targetIndex, 0, from);
      return next;
    });
  }

  function panelViewDragProps(view: GitPanelViewId) {
    return {
      draggable: true,
      dragging: draggingPanelView === view,
      onDragStart: (event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", view);
        setDraggingPanelView(view);
      },
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const dragged = event.dataTransfer.getData("text/plain") as GitPanelViewId;
        if (GIT_PANEL_VIEW_ORDER.includes(dragged)) movePanelView(dragged, view);
        setDraggingPanelView(null);
      },
      onDragEnd: () => setDraggingPanelView(null),
    };
  }

  function renderCommitBox() {
    return (
      <div className="git-commit-box git-commit-box-inline">
        <div className="git-message-wrap">
          <textarea
            className="git-message"
            placeholder={`Mensagem (Ctrl+Enter para fazer commit em "${status?.branch || "branch"}")`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={1}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                if (message.trim() && staged.length > 0 && !busy) {
                  void act(async () => {
                    await gitCommit(repoRootPath, message, connId);
                    setMessage("");
                  });
                }
              }
            }}
          />
          <Tooltip label={assistLabel}>
            <button
              type="button"
              className="git-message-assist-btn"
              disabled={busy || totalChanges === 0}
              aria-label="Gerar mensagem de commit"
              onClick={() => void generateCommitMessage()}
            >
              <Codicon name="model" size={13} />
            </button>
          </Tooltip>
        </div>
        <div className="git-commit-actions-row">
          <button
            className="git-commit-btn"
            disabled={busy || !message.trim() || staged.length === 0}
            title={
              staged.length === 0
                ? "Prepare (stage) arquivos antes de commitar"
                : "Commit dos arquivos preparados"
            }
            onClick={() =>
              act(async () => {
                await gitCommit(repoRootPath, message, connId);
                setMessage("");
              })
            }
          >
            <Codicon name="success" /> Confirmação
            {staged.length ? ` (${staged.length})` : ""}
          </button>
        </div>
      </div>
    );
  }

  function renderConflictRows() {
    if (conflicts.length === 0) {
      return <div className="panel-empty git-panel-empty-compact">Nenhum conflito de merge.</div>;
    }
    return conflicts.map((f) => (
      <GitFileRow
        key={`x-${f.path}`}
        file={f}
        actionIcon="success"
        actionTitle="Marcar como resolvido (stage)"
        onAction={() => act(() => gitStage(repoRootPath, f.path, connId))}
        onOpen={() => openSourceControlItem(f, "working")}
        onContextMenu={(e) => openFileMenu(e, fileMenu(f, "conflict"))}
        disabled={busy}
      />
    ));
  }

  function renderChangeRows() {
    if (changes.length === 0) {
      return (
        <div className="panel-empty git-panel-empty-compact">
          {totalChanges === 0 ? "Nenhuma alteração." : "Nenhuma alteração pendente."}
        </div>
      );
    }
    return changes.map((f) => (
      <GitFileRow
        key={`c-${f.path}`}
        file={f}
        actionIcon="add"
        actionTitle="Preparar (stage)"
        onAction={() => act(() => gitStage(repoRootPath, f.path, connId))}
        onDiscard={() => discardFile(f)}
        onOpen={() => openSourceControlItem(f, "working")}
        onContextMenu={(e) => openFileMenu(e, fileMenu(f, "changes"))}
        disabled={busy}
      />
    ));
  }

  function renderStagedRows() {
    if (staged.length === 0) {
      return <div className="panel-empty git-panel-empty-compact">Nenhum arquivo preparado.</div>;
    }
    return (
      <>
        <div className="git-staged-preview-bar">
          <div>
            <span>Index preparado</span>
            <small>{stagedSummaryText || `${staged.length} arquivo${staged.length === 1 ? "" : "s"}`}</small>
          </div>
          <button
            type="button"
            disabled={busy || staged.length === 0}
            onClick={openFirstStagedChange}
            title="Abrir diff staged do primeiro arquivo"
          >
            <Codicon name="openChanges" size={12} />
            Preview
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => gitUnstageAll(repoRootPath, connId))}
            title="Remover todos os arquivos do stage"
          >
            <Codicon name="remove" size={12} />
            Unstage
          </button>
        </div>
        {staged.map((f) => (
          <GitFileRow
            key={`s-${f.path}`}
            file={f}
            actionIcon="remove"
            actionTitle="Remover do stage"
            onAction={() => act(() => gitUnstage(repoRootPath, f.path, connId))}
            onOpen={() => openSourceControlItem(f, "staged")}
            onContextMenu={(e) => openFileMenu(e, fileMenu(f, "staged"))}
            disabled={busy}
          />
        ))}
      </>
    );
  }

  function renderChangesActions() {
    if (changes.length === 0) return null;
    return (
      <>
        <Tooltip label="Descartar todas as alterações">
          <button
            className="git-link-btn"
            disabled={busy}
            aria-label="Descartar todas as alterações"
            onClick={() =>
              act(async () => {
                if (
                  !window.confirm(
                    "Descartar TODAS as alterações do diretório de trabalho? Esta ação não pode ser desfeita."
                  )
                )
                  return;
                await gitDiscardAll(repoRootPath, connId);
              })
            }
          >
            <Codicon name="discard" />
          </button>
        </Tooltip>
        <Tooltip label="Preparar tudo">
          <button
            className="git-link-btn"
            disabled={busy}
            aria-label="Preparar tudo"
            onClick={() => act(() => gitStageAll(repoRootPath, connId))}
          >
            <Codicon name="add" />
          </button>
        </Tooltip>
      </>
    );
  }

  function renderStagedActions() {
    if (staged.length === 0) return null;
    return (
      <>
        <Tooltip label="Visualizar primeiro arquivo preparado">
          <button
            className="git-link-btn"
            disabled={busy || staged.length === 0}
            aria-label="Visualizar primeiro arquivo preparado"
            onClick={openFirstStagedChange}
          >
            <Codicon name="openChanges" />
          </button>
        </Tooltip>
        <Tooltip label="Remover tudo do stage">
          <button
            className="git-link-btn"
            disabled={busy}
            aria-label="Remover tudo do stage"
            onClick={() => act(() => gitUnstageAll(repoRootPath, connId))}
          >
            <Codicon name="remove" />
          </button>
        </Tooltip>
      </>
    );
  }

  function renderSourceControlView() {
    return (
      <section
        key="changes"
        className={`git-view-section git-source-views${draggingPanelView === "changes" ? " is-dragging" : ""}`}
      >
        <GitSectionHeader
          title="Alterações"
          icon="openChanges"
          expanded={showSourceControlRoot}
          onToggle={() => setShowSourceControlRoot((value) => !value)}
          count={sourceControlCount}
          {...panelViewDragProps("changes")}
        />
        {showSourceControlRoot && (
          <div className="git-source-view-body">
            {renderCommitBox()}

            {conflicts.length > 0 && (
              <section className="git-source-subsection">
                <GitSectionHeader
                  title="Conflitos"
                  icon="warning"
                  expanded={showConflicts}
                  onToggle={() => setShowConflicts((value) => !value)}
                  count={conflicts.length}
                  danger
                />
                {showConflicts && <div className="git-source-subsection-body">{renderConflictRows()}</div>}
              </section>
            )}

            <section className="git-source-subsection">
              <GitSectionHeader
                title="Alterações"
                icon="openChanges"
                expanded={showChanges}
                onToggle={() => setShowChanges((value) => !value)}
                count={changes.length || undefined}
                actions={renderChangesActions()}
              />
              {showChanges && <div className="git-source-subsection-body">{renderChangeRows()}</div>}
            </section>

            {staged.length > 0 && (
              <section className="git-source-subsection">
                <GitSectionHeader
                  title="Preparadas"
                  icon="success"
                  expanded={showStaged}
                  onToggle={() => setShowStaged((value) => !value)}
                  count={staged.length}
                  actions={renderStagedActions()}
                />
                {showStaged && <div className="git-source-subsection-body">{renderStagedRows()}</div>}
              </section>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderGitFluentView() {
    return (
      <section
        key="gitFluent"
        className={`git-view-section git-group git-group-fluent${draggingPanelView === "gitFluent" ? " is-dragging" : ""}`}
      >
        <GitSectionHeader
          title="Git Fluent"
          icon="graph"
          expanded={showGitFluentOverview}
          onToggle={() => setShowGitFluentOverview((value) => !value)}
          actions={gitFluentHeaderActions}
          {...panelViewDragProps("gitFluent")}
        />
        {showGitFluentOverview && (
          <div className="git-fluent-board">
            {activeGitFluentTab === "compare" && (
              <GitFluentCompareView
                status={status}
                comparison={upstreamComparison}
                busy={busy}
                onPull={() => act(() => gitPull(repoRootPath, connId).then(loadUpstreamComparison))}
                onPush={() => act(() => gitPush(repoRootPath, connId).then(loadUpstreamComparison))}
                onOpenCommitMenu={(event, commit) => openFileMenu(event, commitContextMenu(commit))}
                onCopyHash={(hash) => void navigator.clipboard?.writeText(hash)}
                onOpenRemote={openExternal}
              />
            )}
            {activeGitFluentTab === "graph" && (
              <GitFluentGraphView
                rows={gitFluentGraphRows}
                selectedHash={selectedGraphHash}
                rootPath={repoRootPath}
                connId={connId}
                onToggleCommit={(hash) =>
                  setSelectedGraphHash((current) => (current === hash ? null : hash))
                }
                onOpenCommitMenu={(event, commit) => openFileMenu(event, commitContextMenu(commit))}
                onOpenFile={onOpenFile}
                onOpenRevisionDiff={onOpenRevisionDiff}
              />
            )}
            {activeGitFluentTab === "history" && (
              <GitFluentHistoryView
                commits={activeHistoryCommits}
                scope={historyScope}
                onSelectCommit={(commit) => {
                  setSelectedGraphHash(commit.hash);
                  setActiveGitFluentTab("graph");
                }}
                onOpenCommitMenu={(event, commit) => openFileMenu(event, commitContextMenu(commit))}
                onOpenGraph={() => selectGitFluentTab("graph")}
              />
            )}
            {activeGitFluentTab === "branches" && (
              <GitFluentBranchesView
                localGroups={localBranchGroups}
                remoteGroups={remoteBranchGroups}
                collapsedGroups={collapsedGitFluentGroups}
                layout={gitFluentBranchLayout}
                busy={busy}
                onToggleGroup={toggleGitFluentGroup}
                onOpenBranchMenu={(event, branch) => openFileMenu(event, branchContextMenu(branch))}
                onOpenRemoteBranchMenu={(event, branch) => openFileMenu(event, remoteBranchContextMenu(branch))}
                onCheckoutBranch={(branch) => act(() => gitCheckout(repoRootPath, branch.name, connId).then(loadBranches))}
                onCheckoutRemoteBranch={checkoutRemoteBranch}
              />
            )}
            {activeGitFluentTab === "remotes" && (
              <GitFluentRemotesView
                remotes={remotes}
                remoteBranches={remoteBranches}
                collapsedGroups={collapsedGitFluentGroups}
                branchLayout={gitFluentRemoteBranchLayout}
                busy={busy}
                onToggleGroup={toggleGitFluentGroup}
                onOpenRemoteMenu={(event, remote) => openFileMenu(event, remoteContextMenu(remote))}
                onOpenRemoteBranchMenu={(event, branch) => openFileMenu(event, remoteBranchContextMenu(branch))}
                onFetchRemote={fetchRemote}
                onCheckoutRemoteBranch={checkoutRemoteBranch}
              />
            )}
            {activeGitFluentTab === "tags" && (
              <GitFluentTagsView
                tags={gitFluentTags}
                onSelectTag={(tag) => {
                  setSelectedGraphHash(tag.commit.hash);
                  selectGitFluentTab("graph");
                }}
                onOpenTagMenu={(event, tag) => openFileMenu(event, tagContextMenu(tag))}
              />
            )}
            {activeGitFluentTab === "contributors" && (
              <GitFluentContributorsView
                contributors={gitFluentContributors}
                onSelectContributor={(contributor) => {
                  setSelectedGraphHash(contributor.latestCommit.hash);
                  selectGitFluentTab("graph");
                }}
                onOpenContributorMenu={(event, contributor) => openFileMenu(event, contributorContextMenu(contributor))}
              />
            )}
            {activeGitFluentTab === "stashes" && (
              <GitFluentStashesView
                stashes={stashes}
                expandedStashes={expandedStashes}
                stashFiles={stashFiles}
                stashFilesLoading={stashFilesLoading}
                busy={busy}
                onToggleStash={toggleStash}
                onOpenStashMenu={(event, stash) => openFileMenu(event, stashContextMenu(stash))}
                onApplyStash={(stash) => act(() => gitStashApply(repoRootPath, stash.index, connId))}
                onOpenStashFile={openStashFile}
              />
            )}
            {activeGitFluentTab === "worktrees" && (
              <GitFluentWorktreesView
                worktrees={worktrees}
                busy={busy}
                canOpenWorktreeInCurrentWindow={provider !== "ssh" && Boolean(onOpenLocalFolderInCurrentWindow)}
                formatPath={shortPath}
                onOpenWorktreeMenu={(event, worktree) => openFileMenu(event, worktreeContextMenu(worktree))}
                onOpenWorktreeInCurrentWindow={openWorktreeInCurrentWindow}
              />
            )}
            {activeGitFluentTab === "repositories" && (
              <GitFluentRepositoryOverviewView
                repositoryPath={repoRootPath}
                repositoryName={rootName || fileName(repoRootPath)}
                repositoryPathLabel={shortPath(repoRootPath)}
                provider={provider}
                status={status}
                commits={activeHistoryCommits}
                branches={branches}
                remoteBranches={remoteBranches}
                remotes={remotes}
                stashes={stashes}
                tags={gitFluentTags}
                contributors={gitFluentContributors}
                worktrees={worktrees}
                onSelectTab={selectGitFluentTab}
                onCopyRepositoryPath={() => void navigator.clipboard?.writeText(repoRootPath)}
                onOpenRepositoryMenu={(event) =>
                  openFileMenu(event, [
                    {
                      id: "copy-repository-path",
                      label: "Copiar caminho do repositório",
                      icon: "copyPath",
                      run: () => void navigator.clipboard?.writeText(repoRootPath),
                    },
                    {
                      id: "copy-current-branch",
                      label: "Copiar branch atual",
                      icon: "gitBranch",
                      enabled: Boolean(status?.branch),
                      run: () => void navigator.clipboard?.writeText(status?.branch ?? ""),
                    },
                    menuSeparator("sep-repository-navigation"),
                    ...gitFluentViewNavigationMenu("repository"),
                    menuSeparator("sep-repository-actions"),
                    {
                      id: "refresh-repository-snapshot",
                      label: "Atualizar snapshot",
                      icon: "refresh",
                      run: loadGitFluentRepositorySnapshot,
                    },
                    {
                      id: "open-repository-git-fluent",
                      label: "Abrir Git Fluent em aba",
                      icon: "openWith",
                      run: openGitFluentWorkspace,
                    },
                  ])
                }
              />
            )}
          </div>
        )}
      </section>
    );
  }

  function renderPanelView(view: GitPanelViewId) {
    return view === "changes" ? renderSourceControlView() : renderGitFluentView();
  }

  return (
    <div className={embedded ? "git-panel git-panel-embedded" : "git-panel"}>
      {embedded ? (
        <div
          className={`git-root-header${showRepositoryBody ? "" : " is-collapsed"}`}
          title={rootPath}
        >
          <button
            type="button"
            className="git-root-main"
            aria-expanded={showRepositoryBody}
            onClick={toggleRepositoryBody}
          >
            <Codicon name={showRepositoryBody ? "chevronDown" : "chevronRight"} size={12} />
            <Codicon name={provider === "ssh" ? "remote" : "folder"} size={13} />
            <span className="git-root-name">{rootName || fileName(rootPath)}</span>
          </button>
          <div className="git-root-meta">
            <span className="git-root-branch" title="Branch atual">
              <Codicon name="gitBranch" size={12} />
              <span className="git-root-branch-text">{status?.branch || "—"}</span>
            </span>
            {totalChanges > 0 && (
              <span className="git-root-chip" title="Alterações neste repositório">
                <Codicon name="openChanges" size={12} />
                {totalChanges}
              </span>
            )}
          </div>
          <div className="git-root-actions">
            {actionButtons}
          </div>
        </div>
      ) : (
        <div className="explorer-header git-header">
          <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
          {actionButtons}
        </div>
      )}

      {(!embedded || showRepositoryBody) && (
        <div className="git-panel-flow">
          {error && <div className="git-error">{error}</div>}
          {panelViewOrder.map(renderPanelView)}
      </div>
      )}

      {contextMenu && (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

interface GitFileRowProps {
  file: GitFileStatus;
  actionIcon: IconAction;
  actionTitle: string;
  onAction: () => void;
  onOpen: () => void;
  /** Optional "discard changes" action (shown before the primary action). */
  onDiscard?: () => void;
  /** Right-click handler (issue #9): opens the Git context menu for this file. */
  onContextMenu?: (e: React.MouseEvent) => void;
  disabled: boolean;
}

function GitFileRow({
  file,
  actionIcon,
  actionTitle,
  onAction,
  onOpen,
  onDiscard,
  onContextMenu,
  disabled,
}: GitFileRowProps) {
  const b = badge(file);
  return (
    <div className="git-file-row" title={file.path} onContextMenu={onContextMenu}>
      <FileIcon path={file.path} className="git-file-icon" />
      <span className="git-file-name" onClick={onOpen}>
        {fileName(file.path)}
      </span>
      <span className="git-file-spacer" />
      {onDiscard && (
        <Tooltip label="Descartar alterações">
          <button
            className="git-file-action"
            aria-label="Descartar alterações"
            disabled={disabled}
            onClick={onDiscard}
          >
            <Codicon name="discard" />
          </button>
        </Tooltip>
      )}
      <Tooltip label={actionTitle}>
        <button
          className="git-file-action"
          aria-label={actionTitle}
          disabled={disabled}
          onClick={onAction}
        >
          <Codicon name={actionIcon} />
        </button>
      </Tooltip>
      <span className={`git-file-badge git-badge-${b.kind}`}>{b.letter}</span>
    </div>
  );
}
