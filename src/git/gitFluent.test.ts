import assert from "node:assert/strict";
import test from "node:test";
import type { GitBranchInfo, GitGraphCommit } from "../types.ts";
import {
  buildGitFluentBranchGroups,
  buildGitFluentRemoteTree,
  GIT_FLUENT_PRIMARY_TABS,
  GIT_FLUENT_TABS,
  filterGitFluentBranchGroups,
  filterGitFluentGraphRows,
  filterGitFluentRemoteTree,
  gitFluentBranchDisplayName,
  gitFluentRemoteBranchDisplayName,
  buildGitFluentGraphRows,
  graphRefIcon,
  graphRefKind,
  graphRefLabel,
  shouldSeparateGitFluentTab,
  sortGitFluentGraphRefs,
  visibleGitFluentGraphRefs,
} from "./gitFluent.ts";

function branch(name: string, current = false): GitBranchInfo {
  return {
    name,
    current,
    short: "abc123",
    date: "agora",
    author: "Rafael",
    subject: `commit em ${name}`,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
  };
}

function commit(hash: string, parents: string[], refs: string[] = []): GitGraphCommit {
  return {
    hash,
    short: hash.slice(0, 7),
    parents,
    refs,
    author: "Rafael",
    date: "agora",
    subject: `commit ${hash}`,
  };
}

function remote(name: string, fetchUrl = `https://example.com/${name}.git`) {
  return {
    name,
    fetchUrl,
    pushUrl: fetchUrl,
  };
}

test("agrupa branches locais como árvore compacta do Git Fluent", () => {
  const groups = buildGitFluentBranchGroups(
    [branch("main", true), branch("feat/git-fluent"), branch("feat/worktrees"), branch("fix/statusbar")],
    "local"
  );

  assert.deepEqual(
    groups.map((group) => ({
      key: group.key,
      label: group.label,
      grouped: group.grouped,
      branches: group.branches.map((item) => item.name),
    })),
    [
      {
        key: "local:feat",
        label: "feat",
        grouped: true,
        branches: ["feat/git-fluent", "feat/worktrees"],
      },
      {
        key: "local:fix",
        label: "fix",
        grouped: true,
        branches: ["fix/statusbar"],
      },
      {
        key: "local:__root",
        label: "Branches",
        grouped: false,
        branches: ["main"],
      },
    ]
  );
});

test("nomeia grupo raiz remoto como Remotas", () => {
  const groups = buildGitFluentBranchGroups([branch("origin/main"), branch("upstream")], "remote");

  assert.equal(groups[0].label, "origin");
  assert.equal(groups[0].grouped, true);
  assert.equal(groups[1].label, "Remotas");
  assert.equal(groups[1].grouped, false);
});

test("remove o prefixo visual de branches dentro de grupos", () => {
  const [localGroup] = buildGitFluentBranchGroups([branch("feat/git-fluent")], "local");
  const [remoteGroup] = buildGitFluentBranchGroups([branch("origin/main")], "remote");
  const [rootGroup] = buildGitFluentBranchGroups([branch("main")], "local");

  assert.equal(gitFluentBranchDisplayName(localGroup, localGroup.branches[0]), "git-fluent");
  assert.equal(gitFluentBranchDisplayName(remoteGroup, remoteGroup.branches[0]), "main");
  assert.equal(gitFluentBranchDisplayName(rootGroup, rootGroup.branches[0]), "main");
});

test("monta árvore de remotos com branches remotas como filhos", () => {
  const tree = buildGitFluentRemoteTree(
    [remote("origin"), remote("upstream")],
    [branch("origin/main"), branch("origin/feat/git-fluent"), branch("fork/preview")]
  );

  assert.deepEqual(
    tree.map((item) => ({
      name: item.name,
      configured: item.configured,
      branches: item.branches.map((child) => child.name),
    })),
    [
      {
        name: "origin",
        configured: true,
        branches: ["origin/main", "origin/feat/git-fluent"],
      },
      {
        name: "upstream",
        configured: true,
        branches: [],
      },
      {
        name: "fork",
        configured: false,
        branches: ["fork/preview"],
      },
    ]
  );
  assert.equal(gitFluentRemoteBranchDisplayName(tree[0], tree[0].branches[0]), "main");
  assert.equal(gitFluentRemoteBranchDisplayName(tree[2], tree[2].branches[0]), "preview");
});

test("classifica e limpa refs do grafo", () => {
  assert.equal(graphRefKind("HEAD -> main"), "head");
  assert.equal(graphRefKind("tag: v1.0.0"), "tag");
  assert.equal(graphRefKind("origin/main"), "remote");
  assert.equal(graphRefKind("main"), "branch");

  assert.equal(graphRefLabel("HEAD -> main"), "main");
  assert.equal(graphRefLabel("tag: v1.0.0"), "v1.0.0");

  assert.equal(graphRefIcon("HEAD -> main"), "gitBranch");
  assert.equal(graphRefIcon("tag: v1.0.0"), "tag");
  assert.equal(graphRefIcon("origin/main"), "gitRemote");
});

test("prioriza refs importantes no grafo", () => {
  assert.deepEqual(
    sortGitFluentGraphRefs(["tag: v1.0.0", "origin/main", "HEAD -> main", "develop"]),
    ["HEAD -> main", "develop", "origin/main", "tag: v1.0.0"]
  );
  assert.deepEqual(
    visibleGitFluentGraphRefs(["tag: v1.0.0", "origin/main", "HEAD -> main", "develop"]),
    ["HEAD -> main", "develop"]
  );
});

test("organiza abas do Git Fluent em grupos estáveis", () => {
  assert.deepEqual(
    GIT_FLUENT_TABS.map((tab) => [tab.id, tab.group]),
    [
      ["graph", "timeline"],
      ["history", "timeline"],
      ["compare", "timeline"],
      ["branches", "refs"],
      ["remotes", "refs"],
      ["tags", "refs"],
      ["stashes", "storage"],
      ["worktrees", "storage"],
      ["contributors", "people"],
      ["repositories", "overview"],
    ]
  );

  assert.equal(shouldSeparateGitFluentTab(null, GIT_FLUENT_TABS[0]), false);
  assert.equal(shouldSeparateGitFluentTab(GIT_FLUENT_TABS[1], GIT_FLUENT_TABS[2]), false);
  assert.equal(shouldSeparateGitFluentTab(GIT_FLUENT_TABS[2], GIT_FLUENT_TABS[3]), true);
  assert.deepEqual(
    GIT_FLUENT_PRIMARY_TABS.map((tab) => tab.id),
    ["graph", "branches", "remotes", "tags", "stashes", "worktrees", "contributors"]
  );
});

test("monta linhas do grafo com HEAD sintético e lanes por pais", () => {
  const rows = buildGitFluentGraphRows(
    [
      commit("m1", ["a1", "b1"]),
      commit("a1", ["a0"]),
      commit("b1", ["b0"]),
      commit("a0", []),
      commit("b0", []),
    ],
    "main"
  );

  assert.deepEqual(
    rows.map((row) => ({
      hash: row.commit.hash,
      laneIndex: row.laneIndex,
      isHead: row.isHead,
      isMerge: row.isMerge,
      refs: row.refs,
    })),
    [
      { hash: "m1", laneIndex: 0, isHead: true, isMerge: true, refs: ["HEAD -> main"] },
      { hash: "a1", laneIndex: 0, isHead: false, isMerge: false, refs: [] },
      { hash: "b1", laneIndex: 1, isHead: false, isMerge: false, refs: [] },
      { hash: "a0", laneIndex: 0, isHead: false, isMerge: false, refs: [] },
      { hash: "b0", laneIndex: 1, isHead: false, isMerge: false, refs: [] },
    ]
  );
  assert.ok(rows[0].color.startsWith("#"));
  assert.equal(rows[2].visualLane, 1);
  assert.deepEqual(
    rows[0].lanes.map((lane) => ({
      index: lane.index,
      above: lane.above,
      below: lane.below,
    })),
    [
      { index: 0, above: true, below: true },
      { index: 1, above: false, below: true },
    ]
  );
  assert.deepEqual(
    rows[0].connectors.map((connector) => ({
      fromX: connector.fromX,
      toX: connector.toX,
      kind: connector.kind,
    })),
    [{ fromX: 10, toX: 20, kind: "merge" }]
  );
});

test("converge branch quando o pai ja esta vivo em outra lane", () => {
  const rows = buildGitFluentGraphRows(
    [
      commit("m1", ["a1", "b1"]),
      commit("a1", ["base"]),
      commit("b1", ["base"]),
      commit("base", []),
    ],
    "main"
  );

  assert.deepEqual(
    rows.map((row) => ({
      hash: row.commit.hash,
      laneIndex: row.laneIndex,
      connectors: row.connectors.map((connector) => ({
        fromX: connector.fromX,
        toX: connector.toX,
        kind: connector.kind,
      })),
      lanes: row.lanes.map((lane) => ({
        index: lane.index,
        above: lane.above,
        below: lane.below,
      })),
    })),
    [
      {
        hash: "m1",
        laneIndex: 0,
        connectors: [{ fromX: 10, toX: 20, kind: "merge" }],
        lanes: [
          { index: 0, above: true, below: true },
          { index: 1, above: false, below: true },
        ],
      },
      {
        hash: "a1",
        laneIndex: 0,
        connectors: [],
        lanes: [
          { index: 0, above: true, below: true },
          { index: 1, above: true, below: true },
        ],
      },
      {
        hash: "b1",
        laneIndex: 1,
        connectors: [{ fromX: 20, toX: 10, kind: "branch" }],
        lanes: [
          { index: 0, above: true, below: true },
          { index: 1, above: true, below: false },
        ],
      },
      {
        hash: "base",
        laneIndex: 0,
        connectors: [],
        lanes: [{ index: 0, above: true, below: false }],
      },
    ]
  );
});

test("filtra linhas do grafo por mensagem, hash, autor e refs", () => {
  const rows = buildGitFluentGraphRows(
    [
      {
        ...commit("abc123456", []),
        author: "Rafael",
        authorEmail: "rafael@example.com",
        subject: "feat: melhorar painel Git Fluent",
        refs: ["HEAD -> main", "origin/main"],
      },
      {
        ...commit("def789000", []),
        author: "Ana",
        authorEmail: "ana@example.com",
        subject: "fix: ajustar workspace remoto",
        refs: ["tag: v1.2.0"],
      },
    ],
    "main"
  );

  assert.equal(filterGitFluentGraphRows(rows, "").length, 2);
  assert.equal(filterGitFluentGraphRows(rows, "fluent")[0].commit.hash, "abc123456");
  assert.equal(filterGitFluentGraphRows(rows, "789")[0].commit.hash, "def789000");
  assert.equal(filterGitFluentGraphRows(rows, "ana@example").length, 1);
  assert.equal(filterGitFluentGraphRows(rows, "v1.2.0")[0].commit.hash, "def789000");
  assert.equal(filterGitFluentGraphRows(rows, "sem resultado").length, 0);
});

test("filtra grupos de branches preservando a árvore", () => {
  const groups = buildGitFluentBranchGroups(
    [branch("main", true), branch("feat/git-fluent"), branch("feat/worktrees"), branch("fix/statusbar")],
    "local"
  );

  assert.deepEqual(
    filterGitFluentBranchGroups(groups, "worktree").map((group) => ({
      label: group.label,
      branches: group.branches.map((item) => item.name),
    })),
    [{ label: "feat", branches: ["feat/worktrees"] }]
  );

  assert.deepEqual(
    filterGitFluentBranchGroups(groups, "feat").map((group) => ({
      label: group.label,
      branches: group.branches.map((item) => item.name),
    })),
    [{ label: "feat", branches: ["feat/git-fluent", "feat/worktrees"] }]
  );
  assert.equal(filterGitFluentBranchGroups(groups, "sem resultado").length, 0);
});

test("filtra remotos por nome, url e branches sem perder o agrupamento", () => {
  const tree = buildGitFluentRemoteTree(
    [remote("origin", "https://github.com/acme/app.git"), remote("upstream")],
    [branch("origin/main"), branch("origin/feat/git-fluent"), branch("fork/preview")]
  );

  assert.deepEqual(
    filterGitFluentRemoteTree(tree, "github").map((remoteNode) => ({
      name: remoteNode.name,
      branches: remoteNode.branches.map((item) => item.name),
    })),
    [{ name: "origin", branches: ["origin/main", "origin/feat/git-fluent"] }]
  );

  assert.deepEqual(
    filterGitFluentRemoteTree(tree, "preview").map((remoteNode) => ({
      name: remoteNode.name,
      configured: remoteNode.configured,
      branches: remoteNode.branches.map((item) => item.name),
    })),
    [{ name: "fork", configured: false, branches: ["fork/preview"] }]
  );
  assert.equal(filterGitFluentRemoteTree(tree, "sem resultado").length, 0);
});
