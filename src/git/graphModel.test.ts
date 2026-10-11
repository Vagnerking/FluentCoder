import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRefIndex,
  commitWebUrl,
  firstParentChain,
  formatCommitStats,
  hostingFromRemote,
  parseInline,
  parseMessageBody,
  pickHostingRemote,
  pullRequestWebUrl,
  splitCommitMessage,
  summarizeLineage,
} from "./graphModel.ts";
import { branchColor } from "./graphLayout.ts";
import type { BranchLineage, GraphHead, GraphRef } from "./graphApi.ts";

const ref = (name: string, target: string, extra: Partial<GraphRef> = {}): GraphRef => {
  const kind = name.startsWith("refs/heads/") ? "branch" : name.startsWith("refs/remotes/") ? "remote" : "tag";
  const short = name.replace(/^refs\/(heads|remotes|tags)\//, "");
  return { name, short, kind, target, upstream: null, ahead: 0, behind: 0, gone: false, isHead: false, ...extra };
};
const head = (extra: Partial<GraphHead> = {}): GraphHead => ({
  hash: "a1",
  branch: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...extra,
});

test("pílulas: local + remota do mesmo nome viram uma; HEAD primeiro; tags por último", () => {
  const index = buildRefIndex({
    head: head(),
    remotes: [{ name: "origin", url: "git@github.com:a/b.git" }],
    refs: [
      ref("refs/tags/v1", "a1"),
      ref("refs/remotes/origin/main", "a1"),
      ref("refs/heads/main", "a1", { upstream: "origin/main" }),
      ref("refs/remotes/origin/feat/x", "b2"),
    ],
  });
  const pills = index.byHash.get("a1")!;
  assert.deepEqual(
    pills.map((p) => [p.kind, p.label, p.remote]),
    [
      ["head", "main", "origin/main"],
      ["tag", "v1", null],
    ]
  );
  assert.equal(index.colorKey.get("a1"), "main");
  assert.equal(index.colorKey.get("b2"), "feat/x", "remota sem o nome do remoto");
  assert.equal(index.byHash.get("b2")![0].color, branchColor("feat/x"));
});

test("HEAD destacado ganha pílula própria", () => {
  const index = buildRefIndex({ head: head({ hash: "z9", branch: null, detached: true }), remotes: [], refs: [] });
  assert.equal(index.byHash.get("z9")![0].label, "HEAD");
});

test("provedor de hospedagem a partir do remoto", () => {
  assert.deepEqual(hostingFromRemote("git@github.com:Vagnerking/FluentCoder.git"), {
    provider: "github",
    label: "GitHub",
    webBase: "https://github.com/Vagnerking/FluentCoder",
  });
  assert.equal(hostingFromRemote("https://user@gitlab.empresa.com/grp/sub/proj.git")?.webBase, "https://gitlab.empresa.com/grp/sub/proj");
  assert.equal(hostingFromRemote("ssh://git@bitbucket.org:7999/team/repo.git")?.provider, "bitbucket");
  assert.equal(
    hostingFromRemote("git@ssh.dev.azure.com:v3/org/proj/repo")?.webBase,
    "https://dev.azure.com/org/proj/_git/repo"
  );
  assert.equal(hostingFromRemote("/srv/repos/app.git"), null);
  assert.equal(hostingFromRemote(""), null);
  const gh = hostingFromRemote("https://github.com/a/b")!;
  assert.equal(commitWebUrl(gh, "abc"), "https://github.com/a/b/commit/abc");
  assert.equal(pullRequestWebUrl(gh, 108), "https://github.com/a/b/pull/108");
  const gl = hostingFromRemote("git@gitlab.com:a/b.git")!;
  assert.equal(commitWebUrl(gl, "abc"), "https://gitlab.com/a/b/-/commit/abc");
  assert.equal(pullRequestWebUrl(gl, 7), "https://gitlab.com/a/b/-/merge_requests/7");
  assert.equal(
    pickHostingRemote(
      [
        { name: "origin", url: "git@github.com:me/fork.git" },
        { name: "upstream", url: "git@github.com:org/app.git" },
      ],
      "upstream/main"
    )?.webBase,
    "https://github.com/org/app"
  );
});

test("mensagem: corpo sem trailers e markdown leve", () => {
  const msg = [
    "fix(editor): hover acima da linha",
    "",
    "Corrige o hover que cobria o símbolo.",
    "",
    "- `editorOptions.ts` novo",
    "- trava **regressão** (#108)",
    "  com teste",
    "",
    "Co-authored-by: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
    "Signed-off-by: Ana <a@x.com>",
  ].join("\n");
  const split = splitCommitMessage(msg);
  assert.equal(split.subject, "fix(editor): hover acima da linha");
  assert.equal(split.trailers.length, 2);
  assert.ok(!split.body.includes("Co-authored-by"));
  const blocks = parseMessageBody(split.body);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].kind, "list");
  if (blocks[1].kind !== "list") return;
  assert.deepEqual(blocks[1].items[0], [
    { kind: "code", text: "editorOptions.ts" },
    { kind: "text", text: " novo" },
  ]);
  assert.deepEqual(blocks[1].items[1], [
    { kind: "text", text: "trava " },
    { kind: "bold", text: "regressão" },
    { kind: "text", text: " (" },
    { kind: "issue", text: "#108", number: 108 },
    { kind: "text", text: ") com teste" },
  ]);
  // Corpo que termina com uma frase "Nota: x" no meio de um parágrafo não é trailer.
  assert.equal(splitCommitMessage("t\n\nLinha normal\nNota: algo").trailers.length, 0);
  assert.deepEqual(parseInline("ver https://x.dev/a e #3"), [
    { kind: "text", text: "ver " },
    { kind: "link", text: "https://x.dev/a", href: "https://x.dev/a" },
    { kind: "text", text: " e " },
    { kind: "issue", text: "#3", number: 3 },
  ]);
});

test("estatísticas por extenso (singular/plural)", () => {
  assert.equal(formatCommitStats(4, 93, 53), "4 arquivos alterados, 93 inserções(+), 53 exclusões(-)");
  assert.equal(formatCommitStats(1, 1, 1), "1 arquivo alterado, 1 inserção(+), 1 exclusão(-)");
  assert.equal(formatCommitStats(2, 0, 5), "2 arquivos alterados, 5 exclusões(-)");
});

test("resumo da linhagem: divergência, distância e PR", () => {
  const base: BranchLineage = {
    reference: "feat/x",
    base: "main",
    tip: "t",
    baseTip: "b",
    mergeBase: "abcdef1234",
    mergeBaseSubject: "c1",
    mergeBaseTime: 1000,
    ahead: 0,
    behind: 3,
    path: [],
    mergedInto: {
      hash: "c965a78968",
      subject: "Merge pull request #108",
      time: 2000,
      pr: 108,
      fastForward: false,
      firstParent: "5dc9009",
      commits: 2,
    },
    isBase: false,
  };
  const rel = () => "há 3 dias";
  const s = summarizeLineage(base, rel);
  assert.equal(s.divergence, "feat/x divergiu de main em abcdef1 (há 3 dias)");
  assert.equal(s.distance, "2 commits levados pelo merge");
  assert.equal(s.merged, "mesclada em main via PR #108 em c965a78 (há 3 dias)");
  assert.equal(s.pr, 108);
  const pending = summarizeLineage({ ...base, ahead: 1, mergedInto: null }, rel);
  assert.equal(pending.distance, "1 commit à frente, 3 atrás de main");
  assert.equal(pending.merged, null);
  assert.equal(summarizeLineage({ ...base, isBase: true }, rel).distance, "feat/x é a branch base");
});

test("árvore de arquivos com pastas comprimidas e recolhidas", async () => {
  const { buildFileTree } = await import("./graphModel.ts");
  const files = [
    { path: "src/components/git/A.tsx" },
    { path: "src/components/git/B.tsx" },
    { path: "src/styles/x.css" },
    { path: "README.md" },
  ];
  const tree = buildFileTree(files);
  assert.deepEqual(
    tree.map((e) => `${"  ".repeat(e.depth)}${e.kind === "folder" ? `${e.label}/ (${e.count})` : e.label}`),
    ["src/ (3)", "  components/git/ (2)", "    A.tsx", "    B.tsx", "  styles/ (1)", "    x.css", "README.md"]
  );
  const collapsed = buildFileTree(files, new Set(["src/components/git"]));
  assert.ok(!collapsed.some((e) => e.label === "A.tsx"));
});

test("cadeia de first-parent nas linhas carregadas", () => {
  const parents: Record<string, string[]> = { a: ["b", "x"], b: ["c"], c: [] };
  assert.deepEqual(firstParentChain("a", (h) => parents[h]), ["a", "b", "c"]);
});
