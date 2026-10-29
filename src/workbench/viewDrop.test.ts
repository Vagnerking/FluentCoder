import assert from "node:assert/strict";
import test from "node:test";
import { dropTargetAt, virtualZones, type DropZone } from "./viewDrop.ts";

const tab = (id: string, left: number) => ({ id, rect: { left, top: 40, width: 80, height: 28 } });

const ZONES: DropZone[] = [
  { region: "primarySidebar", rect: { left: 0, top: 40, width: 260, height: 800 }, virtual: false, tabs: [] },
  {
    region: "secondarySidebar",
    rect: { left: 1100, top: 40, width: 340, height: 800 },
    virtual: false,
    tabs: [tab("fluentChat", 1100), tab("ext:anthropic.claude-code", 1180), tab("ext:openai.chatgpt", 1260)],
  },
];

test("solta na região sob o ponteiro; fora de qualquer zona = nada", () => {
  assert.deepEqual(dropTargetAt(ZONES, 100, 300, "terminal"), { region: "primarySidebar" });
  assert.equal(dropTargetAt(ZONES, 600, 300, "terminal"), null);
});

test("índice de inserção pela metade das abas, ignorando a arrastada", () => {
  // Antes do Fluent Chat.
  assert.deepEqual(dropTargetAt(ZONES, 1110, 50, "terminal"), { region: "secondarySidebar", index: 0 });
  // Entre Claude e Codex.
  assert.deepEqual(dropTargetAt(ZONES, 1250, 50, "terminal"), { region: "secondarySidebar", index: 2 });
  // Depois de todas.
  assert.deepEqual(dropTargetAt(ZONES, 1430, 50, "terminal"), { region: "secondarySidebar", index: 3 });
  // Arrastando o Claude para depois do Codex (o Claude não conta).
  assert.deepEqual(dropTargetAt(ZONES, 1330, 50, "ext:anthropic.claude-code"), { region: "secondarySidebar", index: 2 });
  // No corpo da região (fora da faixa das abas) = fim.
  assert.deepEqual(dropTargetAt(ZONES, 1200, 500, "terminal"), { region: "secondarySidebar" });
});

test("zona menor vence quando faixas virtuais se sobrepõem", () => {
  const zones: DropZone[] = [
    { region: "primarySidebar", rect: { left: 0, top: 0, width: 1000, height: 800 }, virtual: false, tabs: [] },
    { region: "panel", rect: { left: 0, top: 728, width: 1000, height: 72 }, virtual: true, tabs: [] },
  ];
  assert.deepEqual(dropTargetAt(zones, 500, 760, "x"), { region: "panel" });
});

test("faixas virtuais só para regiões fechadas, nas bordas certas", () => {
  const body = { left: 0, top: 40, width: 1440, height: 820 };
  const editor = { left: 300, top: 40, width: 800, height: 820 };
  const open = { primarySidebar: true, secondarySidebar: false, panel: false };
  const zones = virtualZones({ body, editor, open, sidebarSide: "left", panelPos: "bottom" });
  assert.deepEqual(
    zones.map((z) => [z.region, z.rect.left, z.rect.top]),
    [
      ["secondarySidebar", 1368, 40],
      ["panel", 300, 788],
    ],
  );
  const right = virtualZones({ body, editor, open: { primarySidebar: false, secondarySidebar: false, panel: false }, sidebarSide: "right", panelPos: "left" });
  assert.deepEqual(right.map((z) => [z.region, z.rect.left]), [["primarySidebar", 1368], ["secondarySidebar", 0], ["panel", 300]]);
  assert.ok(zones.every((z) => z.virtual));
});
