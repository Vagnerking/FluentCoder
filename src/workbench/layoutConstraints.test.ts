import assert from "node:assert/strict";
import test from "node:test";
import { resizeKeyValue, solveLayout, touchLru, type LayoutInput } from "./layoutConstraints.ts";

/** Mesmas constantes do app (useWorkbenchLayout): chrome, vãos e mínimos. */
function input(width: number, height: number, over: Partial<LayoutInput> = {}): LayoutInput {
  return {
    viewport: { width, height },
    chrome: { horizontal: 66, vertical: 68 },
    gap: 8,
    regions: {
      primarySidebar: { open: true, size: 260, min: 180, max: width * 0.6 },
      secondarySidebar: { open: true, size: 500, min: 320, max: width * 0.7 },
      panel: { open: true, size: 220, min: 80, max: height * 0.7 },
    },
    panelOrientation: "bottom",
    editorMin: { width: 400, height: 160 },
    lru: ["secondarySidebar", "panel", "primarySidebar"],
    ...over,
  };
}

test("1920×900: tudo cabe no tamanho preferido", () => {
  const r = solveLayout(input(1920, 900));
  assert.equal(r.primarySidebar.size, 260);
  assert.equal(r.secondarySidebar.size, 500);
  assert.equal(r.panel.size, 220);
  assert.ok(r.editor.width >= 400 && r.editor.height >= 160);
  assert.ok(!r.primarySidebar.collapsed && !r.secondarySidebar.collapsed && !r.panel.collapsed);
});

test("1366 e 1024: as laterais encolhem juntas e o editor mantém o mínimo", () => {
  for (const w of [1366, 1024]) {
    const r = solveLayout(input(w, 900));
    assert.ok(r.primarySidebar.visible && r.secondarySidebar.visible, `${w}: as duas visíveis`);
    assert.ok(r.editor.width >= 400 - 1, `${w}: editor ${r.editor.width}`);
    assert.ok(r.primarySidebar.size >= 180 && r.secondarySidebar.size >= 320);
    // A soma nunca passa da janela.
    assert.ok(66 + r.primarySidebar.size + r.secondarySidebar.size + 16 + r.editor.width <= w + 1);
  }
  const r1024 = solveLayout(input(1024, 900));
  assert.ok(r1024.secondarySidebar.size < 500 && r1024.primarySidebar.size < 260);
});

test("800: recolhe temporariamente a região menos usada, sem tocar a preferência", () => {
  const inp = input(800, 600);
  const r = solveLayout(inp);
  assert.equal(r.secondarySidebar.collapsed, true);
  assert.equal(r.secondarySidebar.visible, false);
  assert.equal(r.primarySidebar.visible, true);
  assert.ok(r.editor.width >= 400);
  assert.equal(inp.regions.secondarySidebar.open, true);
  assert.equal(inp.regions.secondarySidebar.size, 500);
  // Se a primária é a menos usada, é ela que sai.
  const other = solveLayout(input(800, 600, { lru: ["primarySidebar", "panel", "secondarySidebar"] }));
  assert.equal(other.primarySidebar.collapsed, true);
  assert.equal(other.secondarySidebar.visible, true);
});

test("altura 600: o painel respeita a altura mínima do editor; muito baixa recolhe o painel", () => {
  const r = solveLayout(input(1366, 600, { regions: { ...input(1366, 600).regions, panel: { open: true, size: 500, min: 80 } } }));
  assert.equal(r.panel.size, 600 - 68 - 160);
  assert.ok(r.editor.height >= 160);
  assert.equal(r.panel.max, 600 - 68 - 160);
  const tiny = solveLayout(input(1366, 300));
  assert.equal(tiny.panel.collapsed, true);
  assert.equal(tiny.panel.visible, false);
});

test("painel na lateral disputa a largura com as barras", () => {
  const r = solveLayout(input(1024, 900, { panelOrientation: "side", regions: { ...input(1024, 900).regions, panel: { open: true, size: 360, min: 180 } } }));
  const visible = (["primarySidebar", "secondarySidebar", "panel"] as const).filter((k) => r[k].visible);
  assert.ok(visible.length >= 2);
  assert.ok(r.editor.width >= 399);
  assert.ok(r.secondarySidebar.collapsed, "a menos usada sai primeiro");
});

test("máximo da alça deixa o mínimo do editor; regiões fechadas não contam", () => {
  const r = solveLayout(input(1920, 900));
  // 1920 - 66 - 400 - 16 - 500 = 938, limitado pelo teto de 60%.
  assert.equal(r.primarySidebar.max, Math.min(1920 * 0.6, 1920 - 66 - 400 - 16 - 500));
  const closed = solveLayout(input(800, 600, { regions: { ...input(800, 600).regions, secondarySidebar: { open: false, size: 500, min: 320 } } }));
  assert.equal(closed.secondarySidebar.collapsed, false);
  assert.equal(closed.secondarySidebar.visible, false);
  assert.equal(closed.primarySidebar.size, 260);
});

test("ordem LRU", () => {
  assert.deepEqual(touchLru(["a" as never, "b" as never], "a" as never), ["b", "a"]);
  const same = ["primarySidebar", "panel"] as const;
  assert.equal(touchLru(same, "panel"), same);
});

test("alça por teclado: setas no sentido da região, Shift = passo grande, Home/End", () => {
  // Barra à esquerda (direction +1): → aumenta.
  assert.equal(resizeKeyValue("ArrowRight", false, 260, 180, 600, "vertical", 1), 276);
  assert.equal(resizeKeyValue("ArrowLeft", true, 260, 180, 600, "vertical", 1), 196);
  // Barra à direita (direction -1): ← aumenta.
  assert.equal(resizeKeyValue("ArrowLeft", false, 400, 320, 700, "vertical", -1), 416);
  // Painel embaixo (alça acima dele, direction -1): ↑ aumenta.
  assert.equal(resizeKeyValue("ArrowUp", false, 220, 80, 400, "horizontal", -1), 236);
  assert.equal(resizeKeyValue("Home", false, 220, 80, 400, "horizontal", -1), 80);
  assert.equal(resizeKeyValue("End", false, 220, 80, 400, "horizontal", -1), 400);
  assert.equal(resizeKeyValue("ArrowDown", true, 100, 80, 400, "horizontal", -1), 80);
  assert.equal(resizeKeyValue("a", false, 1, 0, 2, "vertical", 1), null);
});

test("683 (meia tela): a secundária não cabe nem sozinha, mas a primária volta", () => {
  const inp = input(683, 768, { lru: ["panel", "primarySidebar", "secondarySidebar"], editorMin: { width: 304, height: 160 } });
  const r = solveLayout(inp);
  assert.equal(r.secondarySidebar.collapsed, true);
  assert.equal(r.primarySidebar.visible, true);
  assert.ok(r.editor.width >= 304);
});
