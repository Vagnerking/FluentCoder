import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitActions,
  headerKeyTarget,
  nextExpandedIndex,
  parseViewPaneState,
  resizeViewPanePair,
  sashKeyDelta,
  sizesToWeights,
  solveViewPaneLayout,
  type ViewPaneLayoutItem,
} from "./viewPaneLayout.ts";

const pane = (id: string, expanded = true, weight = 1, minBody = 50): ViewPaneLayoutItem => ({
  id,
  expanded,
  weight,
  minBody,
});
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test("um expandido sozinho ocupa toda a altura menos os cabeçalhos", () => {
  const items = [pane("a", false), pane("b"), pane("c", false)];
  const sizes = solveViewPaneLayout(items, 600, 24);
  assert.deepEqual(sizes, [0, 600 - 3 * 24, 0]);
});

test("todos recolhidos: só cabeçalhos, corpos zerados", () => {
  assert.deepEqual(solveViewPaneLayout([pane("a", false), pane("b", false)], 500, 24), [0, 0]);
});

test("expandidos dividem proporcionalmente aos pesos e a soma bate com o disponível", () => {
  const items = [pane("a", true, 1), pane("b", true, 3)];
  const sizes = solveViewPaneLayout(items, 448, 24); // espaço = 400
  assert.deepEqual(sizes, [100, 300]);
  assert.equal(sum(sizes) + 2 * 24, 448);
});

test("o arredondamento sobra para o último expandido", () => {
  const items = [pane("a", true, 1, 0), pane("b", true, 1, 0), pane("c", true, 1, 0), pane("d", false)];
  const sizes = solveViewPaneLayout(items, 4 * 24 + 100, 24);
  assert.deepEqual(sizes, [33, 33, 34, 0]);
});

test("mínimo respeitado: quem ficaria abaixo é fixado e o resto se divide", () => {
  const items = [pane("a", true, 1, 120), pane("b", true, 9, 50)];
  const sizes = solveViewPaneLayout(items, 2 * 24 + 400, 24);
  assert.equal(sizes[0], 120);
  assert.equal(sizes[1], 280);
});

test("sem espaço nem para os mínimos: cada expandido fica no mínimo", () => {
  const items = [pane("a", true, 1, 80), pane("b", true, 1, 80)];
  assert.deepEqual(solveViewPaneLayout(items, 100, 24), [80, 80]);
});

test("pesos inválidos contam como 1", () => {
  const items = [pane("a", true, Number.NaN), pane("b", true, 0)];
  assert.deepEqual(solveViewPaneLayout(items, 48 + 200, 24), [100, 100]);
});

test("a sash ajusta só o par e preserva a soma", () => {
  const sizes = [200, 100, 300];
  const next = resizeViewPanePair(sizes, 0, 2, 50, [50, 50, 50]);
  assert.deepEqual(next, [250, 100, 250]);
  assert.equal(sum(next), sum(sizes));
});

test("a sash para no mínimo dos dois lados", () => {
  assert.deepEqual(resizeViewPanePair([200, 300], 0, 1, 1000, [50, 80]), [420, 80]);
  assert.deepEqual(resizeViewPanePair([200, 300], 0, 1, -1000, [50, 80]), [50, 450]);
});

test("a sash com índices inválidos não muda nada", () => {
  assert.deepEqual(resizeViewPanePair([200, 300], 0, 0, 20, [0, 0]), [200, 300]);
  assert.deepEqual(resizeViewPanePair([200, 300], 0, 5, 20, [0, 0]), [200, 300]);
});

test("próximo expandido pula os recolhidos", () => {
  const items = [pane("a"), pane("b", false), pane("c"), pane("d", false)];
  assert.equal(nextExpandedIndex(items, 0), 2);
  assert.equal(nextExpandedIndex(items, 2), -1);
});

test("tamanhos viram proporções normalizadas (só expandidos)", () => {
  const items = [pane("a"), pane("b", false), pane("c")];
  assert.deepEqual(sizesToWeights(items, [100, 0, 300]), { a: 0.25, c: 0.75 });
  assert.deepEqual(sizesToWeights(items, [0, 0, 0]), {});
});

test("proporções persistidas reproduzem o layout em outra altura", () => {
  const items = [pane("a"), pane("c")];
  const w = sizesToWeights(items, [100, 300]);
  const again = solveViewPaneLayout(
    items.map((it) => ({ ...it, weight: w[it.id] })),
    48 + 800,
    24
  );
  assert.deepEqual(again, [200, 600]);
});

test("estado persistido inválido vira o vazio; o válido é filtrado", () => {
  assert.deepEqual(parseViewPaneState("{"), { version: 1, expanded: {}, weights: {} });
  assert.deepEqual(parseViewPaneState(JSON.stringify({ version: 2 })), { version: 1, expanded: {}, weights: {} });
  assert.deepEqual(
    parseViewPaneState(JSON.stringify({ version: 1, expanded: { a: true, b: "x" }, weights: { a: 0.5, b: -1, c: "y" } })),
    { version: 1, expanded: { a: true }, weights: { a: 0.5 } }
  );
});

test("teclado da sash e dos cabeçalhos", () => {
  assert.equal(sashKeyDelta("ArrowUp", false), -16);
  assert.equal(sashKeyDelta("ArrowDown", true), 64);
  assert.equal(sashKeyDelta("Enter", false), null);
  assert.equal(headerKeyTarget("ArrowDown", 2, 3), 0);
  assert.equal(headerKeyTarget("ArrowUp", 0, 3), 2);
  assert.equal(headerKeyTarget("Home", 1, 3), 0);
  assert.equal(headerKeyTarget("End", 1, 3), 2);
  assert.equal(headerKeyTarget("x", 1, 3), null);
});

test("ações: cabem todas sem menu; senão sobra sempre o '…'", () => {
  assert.deepEqual(fitActions(3, 3 * 26, 26), { inline: 3, menu: false });
  assert.deepEqual(fitActions(3, 2 * 26, 26), { inline: 1, menu: true });
  assert.deepEqual(fitActions(5, 10, 26), { inline: 0, menu: true });
  assert.deepEqual(fitActions(2, 200, 26, true), { inline: 2, menu: true });
  assert.deepEqual(fitActions(0, 200, 26), { inline: 0, menu: false });
  assert.deepEqual(fitActions(0, 200, 26, true), { inline: 0, menu: true });
});
