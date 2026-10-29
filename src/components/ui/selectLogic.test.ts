import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePopupPlacement,
  firstEnabledIndex,
  isTypeaheadKey,
  lastEnabledIndex,
  moveEnabledIndex,
  normalizeForTypeahead,
  PAGE_STEP,
  selectKeyAction,
  typeaheadIndex,
  type NavOption,
} from "./selectLogic.ts";

const opts = (...labels: string[]): NavOption[] => labels.map((label) => ({ label }));

// [Alpha, (Beta disabled), Gamma, Delta, (Epsilon disabled)]
const MIXED: NavOption[] = [
  { label: "Alpha" },
  { label: "Beta", disabled: true },
  { label: "Gamma" },
  { label: "Delta" },
  { label: "Epsilon", disabled: true },
];

test("first/last enabled pulam opções desabilitadas", () => {
  assert.equal(firstEnabledIndex(MIXED), 0);
  assert.equal(lastEnabledIndex(MIXED), 3);
  assert.equal(firstEnabledIndex([{ label: "x", disabled: true }]), -1);
  assert.equal(lastEnabledIndex([]), -1);
});

test("moveEnabledIndex pula desabilitadas e trava nas pontas (sem wrap)", () => {
  assert.equal(moveEnabledIndex(MIXED, 0, 1), 2, "pula Beta");
  assert.equal(moveEnabledIndex(MIXED, 2, -1), 0, "volta pulando Beta");
  assert.equal(moveEnabledIndex(MIXED, 3, 1), 3, "Epsilon desabilitada: fica em Delta");
  assert.equal(moveEnabledIndex(MIXED, 0, -1), 0, "não dá a volta pelo topo");
  assert.equal(moveEnabledIndex(MIXED, 0, PAGE_STEP), 3, "PageDown para na última habilitada");
});

test("moveEnabledIndex sem início válido cai na primeira/última habilitada", () => {
  assert.equal(moveEnabledIndex(MIXED, -1, 1), 0);
  assert.equal(moveEnabledIndex(MIXED, -1, -1), 3);
});

test("typeahead casa prefixo sem diferenciar caixa nem acento", () => {
  const list = opts("Debug", "Ação", "Release");
  assert.equal(typeaheadIndex(list, "r", 0), 2);
  assert.equal(typeaheadIndex(list, "ac", 0), 1, "'ac' casa 'Ação'");
  assert.equal(typeaheadIndex(list, "z", 0), -1);
  assert.equal(normalizeForTypeahead("Solução"), "solucao");
});

test("typeahead com a mesma tecla repetida cicla entre as opções", () => {
  const list = opts("App.csproj", "Api.csproj", "Core.csproj", "Auth.csproj");
  assert.equal(typeaheadIndex(list, "a", 0), 1, "a partir de App → Api");
  assert.equal(typeaheadIndex(list, "aa", 1), 3, "aa → próxima com 'a' (Auth)");
  assert.equal(typeaheadIndex(list, "aaa", 3), 0, "dá a volta para App");
});

test("typeahead de várias letras mantém a opção atual se ainda casar", () => {
  const list = opts("Api", "App", "Apple");
  assert.equal(typeaheadIndex(list, "app", 1), 1, "fica em App (não pula para Apple)");
  assert.equal(typeaheadIndex(list, "appl", 1), 2);
});

test("typeahead ignora opções desabilitadas", () => {
  assert.equal(typeaheadIndex(MIXED, "b", 0), -1);
  assert.equal(typeaheadIndex(MIXED, "e", 0), -1);
  assert.equal(typeaheadIndex(MIXED, "d", 0), 3);
});

test("isTypeaheadKey aceita só um caractere imprimível sem modificador", () => {
  assert.equal(isTypeaheadKey("a"), true);
  assert.equal(isTypeaheadKey("ç"), true);
  assert.equal(isTypeaheadKey(" "), false, "Espaço abre/escolhe, não é typeahead");
  assert.equal(isTypeaheadKey("ArrowDown"), false);
  assert.equal(isTypeaheadKey("a", { ctrlKey: true }), false, "Ctrl+A não vira busca");
  assert.equal(isTypeaheadKey("a", { metaKey: true }), false);
});

test("fechado: setas/Enter/Espaço abrem no valor atual; Home/End nas pontas", () => {
  const state = { open: false, activeIndex: -1, selectedIndex: 2 };
  for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
    assert.deepEqual(selectKeyAction(key, state, MIXED), { type: "open", activeIndex: 2 }, key);
  }
  assert.deepEqual(selectKeyAction("Home", state, MIXED), { type: "open", activeIndex: 0 });
  assert.deepEqual(selectKeyAction("End", state, MIXED), { type: "open", activeIndex: 3 });
  assert.deepEqual(selectKeyAction("Escape", state, MIXED), { type: "none" }, "Esc fechado propaga (fecha o modal)");
  assert.deepEqual(selectKeyAction("Tab", state, MIXED), { type: "none" });
});

test("fechado sem valor válido abre na primeira opção habilitada", () => {
  const state = { open: false, activeIndex: -1, selectedIndex: -1 };
  assert.deepEqual(selectKeyAction("ArrowDown", state, MIXED), { type: "open", activeIndex: 0 });
  const onDisabled = { open: false, activeIndex: -1, selectedIndex: 1 };
  assert.deepEqual(selectKeyAction("Enter", onDisabled, MIXED), { type: "open", activeIndex: 0 });
});

test("aberto: setas, Home/End e PageUp/PageDown movem o destaque", () => {
  const state = { open: true, activeIndex: 2, selectedIndex: 0 };
  assert.deepEqual(selectKeyAction("ArrowDown", state, MIXED), { type: "move", activeIndex: 3 });
  assert.deepEqual(selectKeyAction("ArrowUp", state, MIXED), { type: "move", activeIndex: 0 });
  assert.deepEqual(selectKeyAction("Home", state, MIXED), { type: "move", activeIndex: 0 });
  assert.deepEqual(selectKeyAction("End", state, MIXED), { type: "move", activeIndex: 3 });
  assert.deepEqual(selectKeyAction("PageDown", state, MIXED), { type: "move", activeIndex: 3 });
  assert.deepEqual(selectKeyAction("PageUp", state, MIXED), { type: "move", activeIndex: 0 });
});

test("aberto: Enter/Espaço/Alt+↑ escolhem; Tab escolhe e deixa o foco seguir; Esc fecha", () => {
  const state = { open: true, activeIndex: 3, selectedIndex: 0 };
  assert.deepEqual(selectKeyAction("Enter", state, MIXED), { type: "commit", index: 3 });
  assert.deepEqual(selectKeyAction(" ", state, MIXED), { type: "commit", index: 3 });
  assert.deepEqual(selectKeyAction("ArrowUp", state, MIXED, { altKey: true }), {
    type: "commit",
    index: 3,
  });
  assert.deepEqual(selectKeyAction("Tab", state, MIXED), {
    type: "commit",
    index: 3,
    keepDefault: true,
  });
  assert.deepEqual(selectKeyAction("Escape", state, MIXED), { type: "close" });
});

test("aberto sem destaque válido: Enter só fecha, sem escolher", () => {
  const state = { open: true, activeIndex: -1, selectedIndex: -1 };
  assert.deepEqual(selectKeyAction("Enter", state, MIXED), { type: "close" });
  const onDisabled = { open: true, activeIndex: 1, selectedIndex: 0 };
  assert.deepEqual(selectKeyAction("Enter", onDisabled, MIXED), { type: "close" });
});

test("popup abre abaixo quando cabe, com a largura do gatilho", () => {
  const p = computePopupPlacement(
    { left: 100, top: 100, bottom: 132, width: 200 },
    { width: 1200, height: 800 },
    200,
  );
  assert.equal(p.side, "below");
  assert.equal(p.top, 136, "4px abaixo do gatilho");
  assert.equal(p.bottom, undefined);
  assert.equal(p.left, 100);
  assert.equal(p.minWidth, 200);
  assert.equal(p.maxHeight, 320);
});

test("popup vira para cima quando não cabe embaixo e há mais espaço acima", () => {
  const p = computePopupPlacement(
    { left: 100, top: 700, bottom: 732, width: 200 },
    { width: 1200, height: 800 },
    300,
  );
  assert.equal(p.side, "above");
  assert.equal(p.bottom, 104, "ancorado 4px acima do topo do gatilho");
  assert.equal(p.top, undefined);
  assert.equal(p.maxHeight, 320, "limitado ao máximo (há 688px acima)");
});

test("popup limita a altura ao espaço disponível e não vaza da viewport", () => {
  const p = computePopupPlacement(
    { left: 1100, top: 300, bottom: 332, width: 200 },
    { width: 1200, height: 500 },
    1000,
  );
  assert.equal(p.side, "above", "acima (292px) > abaixo (156px)");
  assert.equal(p.maxHeight, 288, "300 - 4 de gap - 8 de margem");
  assert.equal(p.left, 992, "deslocado para caber: 1200 - 8 - 200");
});
