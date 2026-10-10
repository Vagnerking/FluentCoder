import assert from "node:assert/strict";
import test from "node:test";
import { loadPersistedPanels, panelsKey, restoreOrder, sanitizePersistedPanels, savePersistedPanels } from "./panelRestore.ts";

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

test("sanitizePersistedPanels: só registros válidos (dados não confiáveis do armazenamento)", () => {
  const out = sanitizePersistedPanels([
    { viewType: "claudeVSCodePanel", extensionId: "anthropic.claude-code", title: "Sessão", viewColumn: 2, state: { sessionID: "x" }, options: { enableScripts: true, bad: "x" } },
    { viewType: "chatgpt.conversationEditor", extensionId: "openai.chatgpt", customUri: "openai-codex://route/x", viewColumn: 99 },
    { viewType: "x", extensionId: "sem-ponto" },
    { viewType: "", extensionId: "a.b" },
    { viewType: "x", extensionId: "a.b", customUri: "javascript" },
    null,
    "lixo",
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { viewType: "claudeVSCodePanel", extensionId: "anthropic.claude-code", title: "Sessão", viewColumn: 2, state: { sessionID: "x" }, options: { enableScripts: true } });
  assert.equal(out[1].viewColumn, undefined, "coluna fora da faixa descartada");
  assert.equal(out[1].customUri, "openai-codex://route/x");
  assert.equal(out[2].customUri, undefined, "uri sem esquema descartada");
  assert.deepEqual(sanitizePersistedPanels({}), []);
});

test("save/load por workspace; lista vazia apaga a chave", () => {
  const store = memStore();
  savePersistedPanels("/ws", [{ viewType: "v", extensionId: "a.b", title: "T" }], store);
  assert.ok(store.m.has(panelsKey("/ws")));
  assert.deepEqual(loadPersistedPanels("/ws", store), [{ viewType: "v", extensionId: "a.b", title: "T" }]);
  assert.deepEqual(loadPersistedPanels("/outro", store), []);
  savePersistedPanels("/ws", [], store);
  assert.ok(!store.m.has(panelsKey("/ws")));
  store.setItem(panelsKey("/ws"), "{json quebrado");
  assert.deepEqual(loadPersistedPanels("/ws", store), []);
});

test("estado grande demais: guarda o painel sem o estado", () => {
  const store = memStore();
  savePersistedPanels(null, [{ viewType: "v", extensionId: "a.b", state: "x".repeat(2 * 1024 * 1024) }], store);
  assert.deepEqual(loadPersistedPanels(null, store), [{ viewType: "v", extensionId: "a.b" }]);
});

test("restoreOrder: o painel ativo é restaurado por último (fica em primeiro plano)", () => {
  const order = restoreOrder([
    { viewType: "a", extensionId: "x.y", active: true },
    { viewType: "b", extensionId: "x.y" },
    { viewType: "c", extensionId: "x.y" },
  ]).map((p) => p.viewType);
  assert.deepEqual(order, ["b", "c", "a"]);
});
