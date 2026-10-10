import assert from "node:assert/strict";
import test from "node:test";
import {
  clearWebviewPanels,
  handleOfWebviewTab,
  hasWebviewPanel,
  isWebviewTabPath,
  patchWebviewPanel,
  removeWebviewPanel,
  targetForViewColumn,
  upsertWebviewPanel,
  webviewPanelsSnapshot,
  webviewTabPath,
} from "./webviewTabs.ts";

test("caminho sintético da aba de painel", () => {
  const p = webviewTabPath("wv7");
  assert.equal(p, "extwebview:wv7");
  assert.ok(isWebviewTabPath(p));
  assert.ok(!isWebviewTabPath("/home/a.ts"));
  assert.ok(!isWebviewTabPath(null));
  assert.equal(handleOfWebviewTab(p), "wv7");
  assert.equal(handleOfWebviewTab("/x"), null);
});

test("ViewColumn → grupo da grade (Active, Beside, N, além das existentes)", () => {
  assert.deepEqual(targetForViewColumn(undefined, 1, 0), { kind: "active" });
  assert.deepEqual(targetForViewColumn(-1, 2, 1), { kind: "active" });
  assert.deepEqual(targetForViewColumn(-2, 1, 0), { kind: "beside" });
  assert.deepEqual(targetForViewColumn(-2, 3, 0), { kind: "group", index: 1 });
  assert.deepEqual(targetForViewColumn(1, 2, 1), { kind: "group", index: 0 });
  assert.deepEqual(targetForViewColumn(3, 2, 0), { kind: "beside" });
});

test("store de painéis: upsert/patch/remove/clear", () => {
  clearWebviewPanels();
  upsertWebviewPanel({ handle: "wv1", viewType: "claudeVSCodePanel", kind: "panel", extensionId: "anthropic.claude-code", url: null, title: "A" });
  patchWebviewPanel("wv1", { url: "http://127.0.0.1:1/t/wv/wv1/index.html" });
  patchWebviewPanel("wv9", { title: "ignorado" });
  assert.equal(webviewPanelsSnapshot().get("wv1")?.url, "http://127.0.0.1:1/t/wv/wv1/index.html");
  assert.ok(hasWebviewPanel("wv1"));
  assert.equal(removeWebviewPanel("wv1"), true);
  assert.equal(removeWebviewPanel("wv1"), false);
  upsertWebviewPanel({ handle: "wv2", viewType: "x", kind: "panel", extensionId: "e", url: null });
  assert.deepEqual(clearWebviewPanels(), ["wv2"]);
});
