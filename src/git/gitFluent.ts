import type { IconAction } from "../icons/codicons/codicon-map";
import type { GitBranchInfo, GitGraphCommit, GitRemoteInfo } from "../types";

export interface GitFluentBranchGroup {
  key: string;
  label: string;
  grouped: boolean;
  branches: GitBranchInfo[];
}

export interface GitFluentTagRef {
  name: string;
  commit: GitGraphCommit;
}

export interface GitFluentContributor {
  name: string;
  email: string;
  commits: number;
  latestDate: string;
  latestCommit: GitGraphCommit;
}

export interface GitFluentGraphRow {
  commit: GitGraphCommit;
  refs: string[];
  laneIndex: number;
  visualLane: number;
  laneOffset: number;
  graphWidth: number;
  nodeX: number;
  lanes: GitFluentGraphLane[];
  connectors: GitFluentGraphConnector[];
  color: string;
  isHead: boolean;
  isMerge: boolean;
}

export interface GitFluentGraphLane {
  index: number;
  x: number;
  color: string;
  active: boolean;
  above: boolean;
  below: boolean;
}

export interface GitFluentGraphConnector {
  fromX: number;
  toX: number;
  color: string;
  kind: "branch" | "merge";
}

export interface GitFluentRemoteTree {
  key: string;
  name: string;
  configured: boolean;
  remote?: GitRemoteInfo;
  fetchUrl?: string;
  pushUrl?: string;
  branches: GitBranchInfo[];
}

export type GitFluentTab =
  | "compare"
  | "graph"
  | "history"
  | "branches"
  | "remotes"
  | "tags"
  | "contributors"
  | "stashes"
  | "worktrees"
  | "repositories";

export type GitFluentTabGroup = "overview" | "timeline" | "refs" | "storage" | "people";
export type GitFluentRefLayout = "tree" | "list";
export type GitFluentToolbarDensity = "compact" | "comfortable";

export interface GitFluentTabDefinition {
  id: GitFluentTab;
  label: string;
  icon: IconAction;
  group: GitFluentTabGroup;
}

export const GIT_FLUENT_TABS: GitFluentTabDefinition[] = [
  { id: "graph", label: "Grafo", icon: "gitGraph", group: "timeline" },
  { id: "history", label: "Timeline", icon: "timeline", group: "timeline" },
  { id: "compare", label: "Comparar", icon: "compareWithSelected", group: "timeline" },
  { id: "branches", label: "Branches", icon: "gitBranch", group: "refs" },
  { id: "remotes", label: "Remotos", icon: "gitRemote", group: "refs" },
  { id: "tags", label: "Tags", icon: "tag", group: "refs" },
  { id: "stashes", label: "Stashes", icon: "gitStash", group: "storage" },
  { id: "worktrees", label: "Worktrees", icon: "gitWorktree", group: "storage" },
  { id: "contributors", label: "Contribuidores", icon: "gitContributor", group: "people" },
  { id: "repositories", label: "Git Fluent", icon: "gitRepo", group: "overview" },
];

export const GIT_FLUENT_PRIMARY_TABS: GitFluentTabDefinition[] = GIT_FLUENT_TABS.filter((tab) =>
  ["graph", "worktrees", "branches", "remotes", "tags", "stashes", "contributors"].includes(tab.id)
);

export function shouldSeparateGitFluentTab(previous: GitFluentTabDefinition | null, next: GitFluentTabDefinition): boolean {
  return previous !== null && previous.group !== next.group;
}

export function graphRefKind(ref: string): "head" | "tag" | "remote" | "branch" {
  if (ref.startsWith("HEAD")) return "head";
  if (ref.startsWith("tag: ")) return "tag";
  if (ref.includes("/") && !ref.startsWith("HEAD -> ")) return "remote";
  return "branch";
}

export function graphRefLabel(ref: string): string {
  return ref.replace(/^HEAD ->\s*/, "").replace(/^tag:\s*/, "");
}

export function graphRefIcon(ref: string): IconAction {
  switch (graphRefKind(ref)) {
    case "tag":
      return "tag";
    case "remote":
      return "gitRemote";
    case "head":
    case "branch":
    default:
      return "gitBranch";
  }
}

function graphRefPriority(ref: string): number {
  switch (graphRefKind(ref)) {
    case "head":
      return 0;
    case "branch":
      return 1;
    case "remote":
      return 2;
    case "tag":
      return 3;
    default:
      return 4;
  }
}

export function sortGitFluentGraphRefs(refs: string[]): string[] {
  return [...refs].sort((a, b) => {
    const priority = graphRefPriority(a) - graphRefPriority(b);
    if (priority !== 0) return priority;
    return graphRefLabel(a).localeCompare(graphRefLabel(b));
  });
}

export function visibleGitFluentGraphRefs(refs: string[], limit = 2): string[] {
  return sortGitFluentGraphRefs(refs)
    .filter((ref) => graphRefKind(ref) !== "tag")
    .slice(0, limit);
}

function normalizedGitFluentQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matchesGitFluentQuery(query: string, parts: Array<string | number | null | undefined>): boolean {
  if (!query) return true;
  return parts.some((part) => String(part ?? "").toLowerCase().includes(query));
}

const GRAPH_LANE_COLORS = ["#ff9f43", "#c586f7", "#60cdff", "#f7c948", "#73c991", "#ff6b8a"];
const GRAPH_LANE_BASE_X = 10;
const GRAPH_LANE_STEP = 10;
const GRAPH_LANE_MAX_VISIBLE = 8;

function graphLaneColor(laneIndex: number): string {
  return GRAPH_LANE_COLORS[laneIndex % GRAPH_LANE_COLORS.length];
}

function graphLaneX(laneIndex: number): number {
  return GRAPH_LANE_BASE_X + Math.min(laneIndex, GRAPH_LANE_MAX_VISIBLE - 1) * GRAPH_LANE_STEP;
}

export function buildGitFluentGraphRows(
  commits: GitGraphCommit[],
  currentBranch?: string | null
): GitFluentGraphRow[] {
  const activeLanes: Array<string | null> = [];

  return commits.map((commit, index) => {
    let laneIndex = activeLanes.indexOf(commit.hash);
    if (laneIndex === -1) {
      laneIndex = activeLanes.findIndex((lane) => lane === null);
      if (laneIndex === -1) {
        laneIndex = activeLanes.length;
        activeLanes.push(commit.hash);
      } else {
        activeLanes[laneIndex] = commit.hash;
      }
    }

    const parents = commit.parents.filter(Boolean);
    const lanesBefore = [...activeLanes];
    const nodeX = graphLaneX(laneIndex);
    const parentLaneIndexes: number[] = [];
    const connectors: GitFluentGraphConnector[] = [];

    if (parents.length === 0) {
      activeLanes[laneIndex] = null;
    } else {
      const primaryParent = parents[0];
      const existingPrimaryLane = activeLanes.findIndex(
        (lane, candidateLane) => lane === primaryParent && candidateLane !== laneIndex
      );

      if (existingPrimaryLane === -1) {
        activeLanes[laneIndex] = primaryParent;
        parentLaneIndexes.push(laneIndex);
      } else {
        activeLanes[laneIndex] = null;
        parentLaneIndexes.push(existingPrimaryLane);
        connectors.push({
          fromX: nodeX,
          toX: graphLaneX(existingPrimaryLane),
          color: graphLaneColor(laneIndex),
          kind: "branch",
        });
      }

      let insertionLane = laneIndex + 1;
      for (const parent of parents.slice(1)) {
        let parentLane = activeLanes.findIndex((lane) => lane === parent);
        if (parentLane === -1) {
          activeLanes.splice(insertionLane, 0, parent);
          parentLane = insertionLane;
          insertionLane += 1;
        } else if (parentLane >= insertionLane) {
          insertionLane = parentLane + 1;
        }
        parentLaneIndexes.push(parentLane);
        connectors.push({
          fromX: nodeX,
          toX: graphLaneX(parentLane),
          color: graphLaneColor(parentLane),
          kind: parents.length > 1 ? "merge" : "branch",
        });
      }
    }

    while (activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
    const lanesAfter = [...activeLanes];

    const refs =
      index === 0 && currentBranch && !commit.refs.some((ref) => ref.includes(currentBranch))
        ? [`HEAD -> ${currentBranch}`, ...commit.refs]
        : commit.refs;
    const sortedRefs = sortGitFluentGraphRefs(refs);
    const visualLane = Math.min(laneIndex, 5);
    const visibleIndexes = new Set<number>();
    lanesBefore.forEach((value, lane) => {
      if (value != null && lane < GRAPH_LANE_MAX_VISIBLE) visibleIndexes.add(lane);
    });
    lanesAfter.forEach((value, lane) => {
      if (value != null && lane < GRAPH_LANE_MAX_VISIBLE) visibleIndexes.add(lane);
    });
    visibleIndexes.add(Math.min(laneIndex, GRAPH_LANE_MAX_VISIBLE - 1));
    parentLaneIndexes.forEach((lane) => {
      if (lane < GRAPH_LANE_MAX_VISIBLE) visibleIndexes.add(lane);
    });
    const lanes = [...visibleIndexes]
      .sort((a, b) => a - b)
      .map((lane) => ({
        index: lane,
        x: graphLaneX(lane),
        color: graphLaneColor(lane),
        active: lanesBefore[lane] != null || lanesAfter[lane] != null || lane === laneIndex,
        above: lanesBefore[lane] != null || lane === laneIndex,
        below: lanesAfter[lane] != null,
      }));
    const maxVisibleLane = Math.max(
      0,
      laneIndex,
      ...lanes.map((lane) => lane.index),
      ...parentLaneIndexes
    );
    const graphWidth = Math.max(
      30,
      GRAPH_LANE_BASE_X * 2 +
        Math.min(maxVisibleLane, GRAPH_LANE_MAX_VISIBLE - 1) * GRAPH_LANE_STEP
    );

    return {
      commit,
      refs: sortedRefs,
      laneIndex,
      visualLane,
      laneOffset: nodeX,
      graphWidth,
      nodeX,
      lanes,
      connectors,
      color: graphLaneColor(laneIndex),
      isHead: index === 0,
      isMerge: parents.length > 1,
    };
  });
}

export function filterGitFluentGraphRows(rows: GitFluentGraphRow[], query: string): GitFluentGraphRow[] {
  const normalizedQuery = normalizedGitFluentQuery(query);
  if (!normalizedQuery) return rows;

  return rows.filter((row) => {
    const { commit } = row;
    return matchesGitFluentQuery(normalizedQuery, [
      commit.hash,
      commit.short,
      commit.subject,
      commit.author,
      commit.authorEmail ?? "",
      commit.date,
      ...row.refs,
      ...row.refs.map(graphRefLabel),
    ]);
  });
}

function gitFluentBranchMatchesQuery(branch: GitBranchInfo, normalizedQuery: string): boolean {
  return matchesGitFluentQuery(normalizedQuery, [
    branch.name,
    branch.short,
    branch.date,
    branch.author,
    branch.subject,
    branch.current ? "atual current checked out" : "",
    branch.hasUpstream ? "upstream remoto remote" : "",
    branch.ahead,
    branch.behind,
  ]);
}

export function filterGitFluentBranchGroups(
  groups: GitFluentBranchGroup[],
  query: string
): GitFluentBranchGroup[] {
  const normalizedQuery = normalizedGitFluentQuery(query);
  if (!normalizedQuery) return groups;

  return groups.flatMap((group) => {
    const groupMatches = matchesGitFluentQuery(normalizedQuery, [group.label, group.key]);
    const branches = groupMatches
      ? group.branches
      : group.branches.filter((branch) => gitFluentBranchMatchesQuery(branch, normalizedQuery));
    return branches.length > 0 ? [{ ...group, branches }] : [];
  });
}

export function filterGitFluentRemoteTree(
  tree: GitFluentRemoteTree[],
  query: string
): GitFluentRemoteTree[] {
  const normalizedQuery = normalizedGitFluentQuery(query);
  if (!normalizedQuery) return tree;

  return tree.flatMap((remote) => {
    const remoteMatches = matchesGitFluentQuery(normalizedQuery, [
      remote.name,
      remote.key,
      remote.fetchUrl,
      remote.pushUrl,
      remote.configured ? "configurado configured" : "descoberto discovered",
    ]);
    const branches = remoteMatches
      ? remote.branches
      : remote.branches.filter((branch) => gitFluentBranchMatchesQuery(branch, normalizedQuery));
    return remoteMatches || branches.length > 0 ? [{ ...remote, branches }] : [];
  });
}

export function buildGitFluentBranchGroups(
  branches: GitBranchInfo[],
  scope: "local" | "remote"
): GitFluentBranchGroup[] {
  const groups = new Map<string, GitFluentBranchGroup>();
  for (const branch of branches) {
    const segments = branch.name.split("/").filter(Boolean);
    const grouped = segments.length > 1;
    const label = grouped ? segments[0] : scope === "remote" ? "Remotas" : "Branches";
    const key = `${scope}:${grouped ? label : "__root"}`;
    const group = groups.get(key) ?? {
      key,
      label,
      grouped,
      branches: [],
    };
    group.branches.push(branch);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.grouped !== b.grouped) return a.grouped ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function gitFluentBranchDisplayName(
  group: GitFluentBranchGroup,
  branch: GitBranchInfo
): string {
  if (!group.grouped) return branch.name;
  const prefix = `${group.label}/`;
  return branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}

function remoteBranchParts(
  branchName: string,
  remotes: GitRemoteInfo[]
): { remote: string; branch: string } | null {
  const sortedRemotes = [...remotes].sort((a, b) => b.name.length - a.name.length);
  for (const remote of sortedRemotes) {
    const prefix = `${remote.name}/`;
    if (branchName.startsWith(prefix)) {
      const branch = branchName.slice(prefix.length);
      return branch ? { remote: remote.name, branch } : null;
    }
  }

  const slash = branchName.indexOf("/");
  if (slash <= 0 || slash === branchName.length - 1) return null;
  return {
    remote: branchName.slice(0, slash),
    branch: branchName.slice(slash + 1),
  };
}

export function buildGitFluentRemoteTree(
  remotes: GitRemoteInfo[],
  remoteBranches: GitBranchInfo[]
): GitFluentRemoteTree[] {
  const byName = new Map<string, GitFluentRemoteTree>();

  for (const remote of remotes) {
    byName.set(remote.name, {
      key: `remote:${remote.name}`,
      name: remote.name,
      configured: true,
      remote,
      fetchUrl: remote.fetchUrl,
      pushUrl: remote.pushUrl,
      branches: [],
    });
  }

  for (const branch of remoteBranches) {
    const parts = remoteBranchParts(branch.name, remotes);
    if (!parts) continue;
    const group =
      byName.get(parts.remote) ??
      {
        key: `remote:${parts.remote}`,
        name: parts.remote,
        configured: false,
        branches: [],
      };
    group.branches.push(branch);
    byName.set(parts.remote, group);
  }

  return [...byName.values()].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function gitFluentRemoteBranchDisplayName(
  remote: GitFluentRemoteTree,
  branch: GitBranchInfo
): string {
  const prefix = `${remote.name}/`;
  return branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}
