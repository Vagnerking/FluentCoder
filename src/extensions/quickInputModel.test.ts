import assert from "node:assert/strict";
import test from "node:test";
import {
  filterQuickPickItems,
  hideQuickInput,
  moveActive,
  quickInputSnapshot,
  quickInputTitle,
  setQuickInput,
  type QuickInputState,
  type QuickPickItemInfo,
} from "./quickInputModel.ts";

const item = (index: number, label: string, over: Partial<QuickPickItemInfo> = {}): QuickPickItemInfo => ({
  index,
  label,
  kind: 0,
  alwaysShow: false,
  buttons: [],
  ...over,
});

const items = [
  item(0, "Recentes", { kind: -1 }),
  item(1, "alpha", { description: "primeiro", detail: "linha a" }),
  item(2, "beta"),
  item(3, "Outros", { kind: -1 }),
  item(4, "gama", { alwaysShow: true }),
  item(5, "delta", { detail: "contém beta" }),
];

test("filtro: rótulo; descrição/detalhe só com matchOn*; alwaysShow; separadores só com itens", () => {
  assert.deepEqual(filterQuickPickItems(items, "").map((i) => i.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(filterQuickPickItems(items, "bet").map((i) => i.index), [0, 2, 3, 4]);
  assert.deepEqual(filterQuickPickItems(items, "bet", { matchOnDetail: true }).map((i) => i.index), [0, 2, 3, 4, 5]);
  assert.deepEqual(filterQuickPickItems(items, "primeiro").map((i) => i.index), [3, 4]);
  assert.deepEqual(filterQuickPickItems(items, "primeiro", { matchOnDescription: true }).map((i) => i.index), [0, 1, 3, 4]);
});

test("moveActive pula separadores e é circular", () => {
  const visible = filterQuickPickItems(items, "");
  assert.equal(moveActive(visible, -1, 1), 1);
  assert.equal(moveActive(visible, 2, 1), 4);
  assert.equal(moveActive(visible, 5, 1), 1);
  assert.equal(moveActive(visible, 1, -1), 5);
  assert.equal(moveActive([], 0, 1), -1);
});

test("título com passo e store de um quick input por vez", () => {
  assert.equal(quickInputTitle({ title: "Criar", step: 2, totalSteps: 3 }), "Criar (2/3)");
  assert.equal(quickInputTitle({ step: 1 }), "(1)");
  assert.equal(quickInputTitle({}), undefined);
  const s = { id: "qi1", kind: "input", extensionId: "x", enabled: true, busy: false, ignoreFocusOut: false, value: "", buttons: [] } as QuickInputState;
  setQuickInput(s);
  hideQuickInput("qi9");
  assert.equal(quickInputSnapshot(), s);
  hideQuickInput("qi1");
  assert.equal(quickInputSnapshot(), null);
});
