import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_PALETTE_SIZE,
  GraphLaneLayout,
  branchColor,
  branchColorKey,
  edgePath,
  hiddenLaneCount,
  isPathEdge,
  layoutGraph,
  mergedBranchFromSubject,
  projectLane,
  visibleLaneWidth,
  type LayoutCommit,
} from "./graphLayout.ts";

const c = (hash: string, parents: string[] = [], subject = hash): LayoutCommit => ({ hash, parents, subject });

test("linear: tudo na lane 0, sem bordas extras", () => {
  const rows = layoutGraph([c("c3", ["c2"]), c("c2", ["c1"]), c("c1")]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.equal(rows[0].isTip, true);
  assert.equal(rows[1].isTip, false);
  assert.deepEqual(rows[1].top, [{ lane: 0, color: rows[0].color }]);
  assert.equal(rows[2].bottom.length, 0, "raiz não tem aresta para baixo");
  assert.equal(rows[0].color, rows[2].color, "a lane mantém a cor");
});

test("merge abre lane para o 2º pai e fecha na convergência", () => {
  // m = merge(c2, f2); f2 ← f1 ← c1; c2 ← c1
  const rows = layoutGraph([
    c("m", ["c2", "f2"], "Merge pull request #7 from acme/feat/x"),
    c("f2", ["f1"]),
    c("c2", ["c1"]),
    c("f1", ["c1"]),
    c("c1"),
  ]);
  const [m, f2, c2, f1, c1] = rows;
  assert.equal(m.isMerge, true);
  assert.deepEqual(m.bottom.map((b) => [b.lane, b.merge]), [[0, false], [1, true]]);
  assert.equal(m.bottom[1].color, branchColor("feat/x"), "cor da branch vem do assunto do merge");
  assert.equal(f2.lane, 1);
  assert.equal(f2.color, branchColor("feat/x"));
  assert.equal(c2.lane, 0);
  assert.deepEqual(c2.pass.map((p) => p.lane), [1]);
  assert.equal(f1.lane, 1);
  // c1: as duas lanes convergem no nó da lane 0.
  assert.equal(c1.lane, 0);
  assert.deepEqual(c1.top.map((t) => t.lane).sort(), [0, 1]);
  assert.equal(c1.width, 2);
});

test("lanes são estáveis: um buraco não desloca as vizinhas e é reaproveitado", () => {
  // a e b: pontas paralelas; a termina cedo (raiz), b continua.
  const rows = layoutGraph([c("a", ["a0"]), c("b", ["b1"]), c("a0"), c("x"), c("b1", ["b0"]), c("b0")]);
  const lane = Object.fromEntries(rows.map((r) => [r.hash, r.lane]));
  assert.equal(lane.a, 0);
  assert.equal(lane.b, 1);
  assert.equal(lane.a0, 0);
  // x é uma nova ponta: reaproveita o buraco 0 sem mover b (lane 1).
  assert.equal(lane.x, 0);
  assert.equal(lane.b1, 1);
  assert.equal(lane.b0, 1);
});

test("continua entre páginas como se fosse uma lista só", () => {
  const all = [
    c("m", ["c2", "f2"], "Merge branch 'feat/y'"),
    c("f2", ["f1"]),
    c("c2", ["c1"]),
    c("f1", ["c1"]),
    c("c1", ["c0"]),
    c("c0"),
  ];
  const whole = layoutGraph(all);
  const paged = new GraphLaneLayout();
  const p1 = paged.append(all.slice(0, 2));
  const p2 = paged.append(all.slice(2));
  assert.deepEqual([...p1, ...p2], whole);
  assert.equal(paged.rows.length, 6);
  assert.equal(paged.maxWidth, 2);
});

test("cor por nome de branch é estável e a remota divide com a local", () => {
  assert.equal(branchColor("feat/x"), branchColor("feat/x"));
  assert.ok(branchColor("main") < GRAPH_PALETTE_SIZE);
  assert.equal(branchColorKey("origin/feat/x", "remote"), "feat/x");
  assert.equal(branchColorKey("feat/x", "branch"), "feat/x");
  assert.equal(branchColorKey("v1.0", "tag"), "v1.0");
  const keys: Record<string, string> = { tipA: "main", tipB: "feat/x" };
  const rows = layoutGraph([c("tipA", ["p"]), c("tipB", ["p"]), c("p")], { colorKeyOf: (h) => keys[h] });
  assert.equal(rows[0].color, branchColor("main"));
  assert.equal(rows[1].color, branchColor("feat/x"));
});

test("assunto de merge → branch", () => {
  assert.equal(mergedBranchFromSubject("Merge pull request #108 from Vagnerking/fix/csharp-hover"), "fix/csharp-hover");
  assert.equal(mergedBranchFromSubject("Merge branch 'feat/a' into main"), "feat/a");
  assert.equal(mergedBranchFromSubject("Merge remote-tracking branch 'origin/main'"), "main");
  assert.equal(mergedBranchFromSubject("fix: algo"), null);
});

test("merge cujo 2º pai já tem lane reaproveita a lane (sem lane nova)", () => {
  // t1 e m esperam ambos x; m = merge(a, x).
  const rows = layoutGraph([c("t1", ["x"]), c("m", ["a", "x"]), c("a", ["x"]), c("x")]);
  const m = rows[1];
  assert.deepEqual(
    m.bottom.map((b) => b.lane),
    [1, 0],
    "2º pai vai para a lane 0, que já espera x"
  );
  assert.equal(rows[3].top.length, 2);
});

test("octopus e transbordo de lanes", () => {
  const rows = layoutGraph([
    c("o", ["p1", "p2", "p3", "p4"]),
    c("p4", ["r"]),
    c("p3", ["r"]),
    c("p2", ["r"]),
    c("p1", ["r"]),
    c("r"),
  ]);
  assert.equal(rows[0].bottom.length, 4);
  assert.equal(rows[0].width, 4);
  assert.equal(projectLane(1, 2), 1);
  assert.equal(projectLane(5, 2), 2);
  assert.equal(hiddenLaneCount(rows[0], 2), 2);
  assert.equal(visibleLaneWidth(4, 2), 3);
  assert.equal(visibleLaneWidth(1, 12), 1);
});

test("caminhos SVG e destaque de linhagem", () => {
  assert.equal(edgePath(10, 0, 10, 11), "M10 0V11");
  assert.match(edgePath(10, 11, 22, 22), /^M10 11C10 16\.5 22 16\.5 22 22$/);
  const path = new Set(["b", "c"]);
  assert.equal(isPathEdge("c", "b", path), true);
  assert.equal(isPathEdge("c", "z", path), false);
  assert.equal(isPathEdge("c", null, path), true);
  assert.equal(isPathEdge("z", null, path), false);
});

test("50k commits com merges: layout em tempo de UI", () => {
  const commits: LayoutCommit[] = [];
  let main = 0;
  const id = (n: number) => `h${n}`;
  // Gera do mais novo para o mais antigo: blocos de merge + 5 commits de feature.
  let n = 0;
  const blocks = 50000 / 7;
  for (let b = 0; b < blocks; b++) {
    const base = n;
    const merge = id(base);
    const mainPrev = id(base + 1);
    const feat = [2, 3, 4, 5, 6].map((k) => id(base + k));
    const next = id(base + 7);
    commits.push(c(merge, [mainPrev, feat[0]], `Merge pull request #${b} from a/feat-${b % 9}`));
    commits.push(c(mainPrev, [next]));
    feat.forEach((f, i) => commits.push(c(f, [i < 4 ? feat[i + 1] : next])));
    n += 7;
    main++;
  }
  commits.push(c(id(n)));
  const layout = new GraphLaneLayout();
  const start = performance.now();
  for (let i = 0; i < commits.length; i += 200) layout.append(commits.slice(i, i + 200));
  const ms = performance.now() - start;
  assert.equal(layout.rows.length, commits.length);
  assert.ok(layout.maxWidth <= 3, `largura ${layout.maxWidth}`);
  assert.ok(ms < 1500, `layout de ${commits.length} commits levou ${ms.toFixed(0)} ms`);
});

test("janela virtual só renderiza o visível + overscan", async () => {
  const { virtualWindow, shouldLoadMore } = await import("./graphLayout.ts");
  assert.deepEqual(virtualWindow(0, 220, 22, 50000, 5), { start: 0, end: 16, total: 1_100_000 });
  const mid = virtualWindow(22 * 1000, 220, 22, 50000, 5);
  assert.equal(mid.start, 995);
  assert.equal(mid.end, 1016);
  // scrollTop além do fim é preso no último quadro.
  const end = virtualWindow(9e9, 220, 22, 100, 5);
  assert.equal(end.end, 100);
  assert.deepEqual(virtualWindow(0, 200, 22, 0), { start: 0, end: 0, total: 0 });
  assert.equal(shouldLoadMore(150, 200, true, false), true);
  assert.equal(shouldLoadMore(50, 200, true, false), false);
  assert.equal(shouldLoadMore(190, 200, false, false), false);
  assert.equal(shouldLoadMore(190, 200, true, true), false);
});
