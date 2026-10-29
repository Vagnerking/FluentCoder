import assert from "node:assert/strict";
import test from "node:test";
import {
  activeViewIn,
  emptyViewLayout,
  loadViewLayout,
  migrateLegacyViewLayout,
  moveView,
  parseViewLayout,
  regionOfView,
  saveViewLayout,
  setActiveView,
  setViewHidden,
  viewsInRegion,
  VIEW_LAYOUT_KEY,
} from "./viewLayout.ts";
import { createViewRegistry, extensionIdOfView, extensionViewId, type ViewDescriptor } from "./viewRegistry.ts";

const D = (id: string, defaultRegion: ViewDescriptor["defaultRegion"], defaultOrder: number, extra: Partial<ViewDescriptor> = {}): ViewDescriptor => ({
  id,
  title: id,
  icon: { codicon: "file" },
  defaultRegion,
  defaultOrder,
  ...extra,
});

const DESCS = [
  D("explorer", "primarySidebar", 0, { activityBar: true }),
  D("search", "primarySidebar", 1, { activityBar: true }),
  D("fluentChat", "secondarySidebar", 0, { retainWhenHidden: true }),
  D("ext:anthropic.claude-code", "secondarySidebar", 10, { retainWhenHidden: true }),
  D("ext:openai.chatgpt", "secondarySidebar", 11, { retainWhenHidden: true }),
  D("problems", "panel", 0),
  D("output", "panel", 1),
  D("terminal", "panel", 2, { retainWhenHidden: true }),
  D("pinned", "panel", 3, { allowedRegions: ["panel"] }),
];
const ids = (list: { id: string }[]) => list.map((d) => d.id);

test("sem estado salvo, cada view fica na região/ordem padrão", () => {
  const s = emptyViewLayout();
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "secondarySidebar")), ["fluentChat", "ext:anthropic.claude-code", "ext:openai.chatgpt"]);
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "panel")), ["problems", "output", "terminal", "pinned"]);
  assert.equal(activeViewIn(s, DESCS, "secondarySidebar"), "fluentChat");
  assert.equal(activeViewIn(s, DESCS, "primarySidebar"), "explorer");
});

test("mover uma view para outra região a torna ativa lá e a origem recai na vizinha", () => {
  let s = setActiveView(emptyViewLayout(), "secondarySidebar", "ext:anthropic.claude-code");
  s = moveView(s, DESCS, "ext:anthropic.claude-code", "panel", 1);
  assert.equal(regionOfView(s, DESCS, "ext:anthropic.claude-code"), "panel");
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "panel")), ["problems", "ext:anthropic.claude-code", "output", "terminal", "pinned"]);
  assert.equal(activeViewIn(s, DESCS, "panel"), "ext:anthropic.claude-code");
  assert.equal(activeViewIn(s, DESCS, "secondarySidebar"), "fluentChat");
  // As demais da secundária não mudaram.
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "secondarySidebar")), ["fluentChat", "ext:openai.chatgpt"]);
});

test("cada view se move de forma independente (Claude e Codex)", () => {
  let s = moveView(emptyViewLayout(), DESCS, "ext:openai.chatgpt", "primarySidebar");
  s = moveView(s, DESCS, "ext:anthropic.claude-code", "panel");
  assert.equal(regionOfView(s, DESCS, "ext:openai.chatgpt"), "primarySidebar");
  assert.equal(regionOfView(s, DESCS, "ext:anthropic.claude-code"), "panel");
  assert.equal(regionOfView(s, DESCS, "fluentChat"), "secondarySidebar");
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "primarySidebar")), ["explorer", "search", "ext:openai.chatgpt"]);
});

test("reordenar dentro da mesma região e índice fora dos limites", () => {
  let s = moveView(emptyViewLayout(), DESCS, "terminal", "panel", 0);
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "panel")), ["terminal", "problems", "output", "pinned"]);
  s = moveView(s, DESCS, "terminal", "panel", 99);
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "panel")), ["problems", "output", "pinned", "terminal"]);
  s = moveView(s, DESCS, "terminal", "panel", -5);
  assert.equal(ids(viewsInRegion(s, DESCS, "panel"))[0], "terminal");
});

test("região não permitida e view desconhecida são no-op", () => {
  const s = emptyViewLayout();
  assert.equal(moveView(s, DESCS, "pinned", "secondarySidebar"), s);
  assert.equal(moveView(s, DESCS, "nao-existe", "panel"), s);
  // Placement salvo numa região que deixou de ser permitida cai no padrão.
  const bad = { ...s, placements: { pinned: { region: "primarySidebar" as const, order: 0 } } };
  assert.equal(regionOfView(bad, DESCS, "pinned"), "panel");
});

test("ocultar tira da lista e da ativa; mover reexibe", () => {
  let s = setViewHidden(emptyViewLayout(), DESCS, "fluentChat", true);
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "secondarySidebar")), ["ext:anthropic.claude-code", "ext:openai.chatgpt"]);
  assert.equal(activeViewIn(s, DESCS, "secondarySidebar"), "ext:anthropic.claude-code");
  assert.equal(ids(viewsInRegion(s, DESCS, "secondarySidebar", { includeHidden: true })).length, 3);
  s = moveView(s, DESCS, "fluentChat", "panel");
  assert.ok(ids(viewsInRegion(s, DESCS, "panel")).includes("fluentChat"));
  assert.equal(setViewHidden(s, DESCS, "fluentChat", false), s);
});

test("placements de views ausentes são preservados", () => {
  let s = moveView(emptyViewLayout(), DESCS, "ext:openai.chatgpt", "panel");
  const without = DESCS.filter((d) => d.id !== "ext:openai.chatgpt");
  s = moveView(s, without, "terminal", "primarySidebar");
  assert.equal(s.placements["ext:openai.chatgpt"].region, "panel");
  assert.equal(regionOfView(s, DESCS, "ext:openai.chatgpt"), "panel");
});

test("parse descarta entradas inválidas e versões desconhecidas", () => {
  assert.equal(parseViewLayout(null), null);
  assert.equal(parseViewLayout({ version: 99 }), null);
  const p = parseViewLayout({
    version: 1,
    placements: { a: { region: "panel", order: 2 }, b: { region: "lua", order: 1 }, c: { region: "panel", order: "x" }, d: { region: "panel", order: 0, hidden: true } },
    active: { panel: "a", lua: "b", secondarySidebar: 3 },
  });
  assert.deepEqual(p, { version: 1, placements: { a: { region: "panel", order: 2 }, d: { region: "panel", order: 0, hidden: true } }, active: { panel: "a" } });
});

test("migração: ordem antiga do painel e aba lembrada do Fluent Chat", () => {
  const legacy: Record<string, string> = { "ui.panelTabOrder": JSON.stringify(["terminal", "output", "problems"]), "ui.agentsDockTab": "fluent-agents" };
  const s = migrateLegacyViewLayout((k) => legacy[k] ?? null);
  assert.deepEqual(ids(viewsInRegion(s, DESCS, "panel")).slice(0, 3), ["terminal", "output", "problems"]);
  // A aba "Agentes" não existe mais: vira o Fluent Chat.
  assert.equal(activeViewIn(s, DESCS, "secondarySidebar"), "fluentChat");
  const ext = migrateLegacyViewLayout((k) => (k === "ui.agentsDockTab" ? "openai.chatgpt" : k === "ui.panelTabOrder" ? "lixo{" : null));
  assert.equal(activeViewIn(ext, DESCS, "secondarySidebar"), "ext:openai.chatgpt");
  assert.deepEqual(ext.placements, {});
});

test("load prefere o estado novo; sem ele migra; save/load fazem round trip", () => {
  const mem = new Map<string, string>([["ui.agentsDockTab", "anthropic.claude-code"]]);
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const migrated = loadViewLayout(storage);
  assert.equal(migrated.active.secondarySidebar, "ext:anthropic.claude-code");
  const moved = moveView(migrated, DESCS, "fluentChat", "panel");
  saveViewLayout(storage, moved);
  assert.ok(mem.has(VIEW_LAYOUT_KEY));
  mem.set("ui.agentsDockTab", "fluent-chat"); // legado não sobrescreve o novo
  assert.deepEqual(loadViewLayout(storage), moved);
  mem.set(VIEW_LAYOUT_KEY, "{corrompido");
  assert.deepEqual(loadViewLayout(storage), emptyViewLayout());
  assert.deepEqual(loadViewLayout(null), emptyViewLayout());
});

test("registro: snapshot estável, substituição e remoção segura", () => {
  const reg = createViewRegistry();
  let calls = 0;
  reg.subscribe(() => calls++);
  const off1 = reg.register(D("b", "panel", 2));
  reg.register(D("a", "panel", 1));
  assert.deepEqual(ids([...reg.list()]), ["a", "b"]);
  const snap = reg.list();
  const same = reg.register(D("a", "panel", 1)); // idêntico: sem publicar
  assert.equal(reg.list(), snap);
  const replaced = reg.register(D("b", "panel", 0, { title: "B" }));
  assert.equal(reg.get("b")?.title, "B");
  off1(); // remoção antiga não derruba a substituição
  assert.ok(reg.get("b"));
  replaced();
  assert.equal(reg.get("b"), undefined);
  same();
  assert.equal(reg.list().length, 0);
  assert.ok(calls >= 4);
  assert.equal(extensionViewId("Anthropic.Claude-Code"), "ext:anthropic.claude-code");
  assert.equal(extensionIdOfView("ext:openai.chatgpt"), "openai.chatgpt");
  assert.equal(extensionIdOfView("fluentChat"), null);
});
