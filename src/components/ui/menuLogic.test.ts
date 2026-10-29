import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstActionable,
  isTypeaheadKey,
  lastActionable,
  menuKeyAction,
  nextActionable,
  placeMenu,
  typeaheadMatch,
  type MenuNavItem,
} from "./menuLogic.ts";

const items: MenuNavItem[] = [
  { label: "Abrir" },
  { separator: true },
  { label: "Renomear", disabled: true },
  { label: "Copiar" },
  { label: "Abrir com", submenu: [{ label: "Editor" }] },
  { label: "Excluir" },
];
const root = (activeIndex: number) => ({ activeIndex, isSubmenu: false });
const sub = (activeIndex: number) => ({ activeIndex, isSubmenu: true });

test("↑/↓ andam com volta e pulam separador e desabilitado", () => {
  assert.deepEqual(menuKeyAction("ArrowDown", items, root(0)), { type: "move", index: 3 });
  assert.deepEqual(menuKeyAction("ArrowDown", items, root(5)), { type: "move", index: 0 });
  assert.deepEqual(menuKeyAction("ArrowUp", items, root(3)), { type: "move", index: 0 });
  assert.deepEqual(menuKeyAction("ArrowUp", items, root(0)), { type: "move", index: 5 });
  // Nothing active yet: ↓ goes to the first item, ↑ to the last.
  assert.deepEqual(menuKeyAction("ArrowDown", items, root(-1)), { type: "move", index: 0 });
  assert.deepEqual(menuKeyAction("ArrowUp", items, root(-1)), { type: "move", index: 5 });
});

test("Home/End vão para o primeiro/último acionável", () => {
  assert.deepEqual(menuKeyAction("Home", items, root(4)), { type: "move", index: 0 });
  assert.deepEqual(menuKeyAction("End", items, root(0)), { type: "move", index: 5 });
  assert.equal(firstActionable([{ separator: true }, { label: "a" }]), 1);
  assert.equal(lastActionable([{ label: "a" }, { label: "b", disabled: true }]), 0);
});

test("Enter/Espaço ativam; em item com submenu, abrem o submenu", () => {
  assert.deepEqual(menuKeyAction("Enter", items, root(0)), { type: "activate", index: 0 });
  assert.deepEqual(menuKeyAction(" ", items, root(3)), { type: "activate", index: 3 });
  assert.deepEqual(menuKeyAction("Enter", items, root(4)), { type: "openSubmenu", index: 4 });
  assert.deepEqual(menuKeyAction("Enter", items, root(2)), { type: "none" });
  assert.deepEqual(menuKeyAction("Enter", items, root(-1)), { type: "none" });
});

test("→ abre submenu; sem submenu, na raiz, pede o menu vizinho (menu bar)", () => {
  assert.deepEqual(menuKeyAction("ArrowRight", items, root(4)), { type: "openSubmenu", index: 4 });
  assert.deepEqual(menuKeyAction("ArrowRight", items, root(0)), { type: "arrowOut", dir: 1 });
  assert.deepEqual(menuKeyAction("ArrowRight", items, sub(0)), { type: "none" });
});

test("← e Esc fecham o submenu; na raiz, ← troca de menu e Esc fecha", () => {
  assert.deepEqual(menuKeyAction("ArrowLeft", items, sub(0)), { type: "closeSubmenu" });
  assert.deepEqual(menuKeyAction("Escape", items, sub(0)), { type: "closeSubmenu" });
  assert.deepEqual(menuKeyAction("ArrowLeft", items, root(0)), { type: "arrowOut", dir: -1 });
  assert.deepEqual(menuKeyAction("Escape", items, root(0)), { type: "close", reason: "escape" });
  assert.deepEqual(menuKeyAction("Tab", items, sub(0)), { type: "close", reason: "tab" });
  assert.deepEqual(menuKeyAction("x", items, root(0)), { type: "none" });
});

test("menu vazio ou todo desabilitado não navega", () => {
  assert.equal(nextActionable([], 0, 1), -1);
  const off = [{ label: "a", disabled: true }, { separator: true }];
  assert.deepEqual(menuKeyAction("ArrowDown", off, root(-1)), { type: "none" });
  assert.deepEqual(menuKeyAction("Home", off, root(-1)), { type: "none" });
});

test("type-ahead casa o próximo rótulo (sem acento/caixa) e pula desabilitados", () => {
  assert.equal(typeaheadMatch(items, "c", 0), 3);
  assert.equal(typeaheadMatch(items, "a", 0), 4); // next "A…" after index 0
  assert.equal(typeaheadMatch(items, "a", 4), 0); // wraps
  assert.equal(typeaheadMatch(items, "r", 0), -1); // "Renomear" is disabled
  assert.equal(typeaheadMatch([{ label: "Édito" }], "edi", -1), 0);
  assert.equal(typeaheadMatch(items, "", 0), -1);
  assert.equal(isTypeaheadKey("a", {}), true);
  assert.equal(isTypeaheadKey("a", { ctrlKey: true }), false);
  assert.equal(isTypeaheadKey(" ", {}), false);
  assert.equal(isTypeaheadKey("ArrowDown", {}), false);
});

const vp = { width: 1000, height: 800 };
const size = { width: 200, height: 300 };
const rect = (left: number, top: number, w = 40, h = 24) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

test("posição no ponto: abre à direita/abaixo e vira nas bordas", () => {
  const at = (x: number, y: number) => ({ left: x, top: y, right: x, bottom: y });
  assert.deepEqual(placeMenu(at(100, 100), "point", size, vp), { left: 100, top: 100 });
  assert.deepEqual(placeMenu(at(900, 700), "point", size, vp), { left: 700, top: 400 });
});

test("dropdown abaixo do gatilho; sem espaço, abre acima", () => {
  assert.deepEqual(placeMenu(rect(10, 0), "bottom-start", size, vp), { left: 10, top: 26 });
  assert.deepEqual(placeMenu(rect(10, 700), "bottom-start", size, vp), { left: 10, top: 398 });
});

test("menu da status bar abre acima; sem espaço, abaixo", () => {
  assert.deepEqual(placeMenu(rect(10, 770), "top-start", size, vp), { left: 10, top: 468 });
  assert.deepEqual(placeMenu(rect(10, 20), "top-start", size, vp), { left: 10, top: 46 });
});

test("submenu ao lado; sem espaço à direita, vai para a esquerda; sempre dentro da tela", () => {
  assert.deepEqual(placeMenu(rect(100, 100, 200), "right-start", size, vp), { left: 298, top: 96 });
  assert.deepEqual(placeMenu(rect(700, 100, 200), "right-start", size, vp), { left: 502, top: 96 });
  const tall = { width: 200, height: 2000 };
  assert.equal(placeMenu(rect(10, 10), "point", tall, vp).top, 4);
});
