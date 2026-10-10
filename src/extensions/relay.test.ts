import assert from "node:assert/strict";
import test from "node:test";
import { controlMessage, isExternalLink, originOf, parseIframeMessage, PendingQueue } from "./relay.ts";

const win = { name: "iframe-window" };
const expected = { origin: "http://127.0.0.1:4321", source: win, handle: "wv1" };
const meta = { origin: "http://127.0.0.1:4321", source: win };

test("aceita postMessage do acquireVsCodeApi do iframe esperado", () => {
  const msg = parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "message", message: { type: "ready" } }, meta, expected);
  assert.deepEqual(msg, { type: "message", handle: "wv1", message: { type: "ready" } });
});

test("traduz setState, ready, link e pong", () => {
  assert.deepEqual(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "setState", state: { a: 1 } }, meta, expected), {
    type: "setState",
    handle: "wv1",
    state: { a: 1 },
  });
  assert.equal(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "ready" }, meta, expected)?.type, "ready");
  assert.equal(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "link", href: "https://x.dev" }, meta, expected)?.type, "link");
  assert.equal(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "link", href: 42 }, meta, expected), null);
});

test("rejeita origem, janela, handle ou formato diferentes", () => {
  const ok = { __fluentExt: 1, handle: "wv1", type: "message", message: 1 };
  assert.equal(parseIframeMessage(ok, { ...meta, origin: "http://evil.test" }, expected), null);
  assert.equal(parseIframeMessage(ok, { ...meta, source: {} }, expected), null);
  assert.equal(parseIframeMessage(ok, { ...meta, source: null }, { ...expected, source: null }), null);
  assert.equal(parseIframeMessage({ ...ok, handle: "wv2" }, meta, expected), null);
  assert.equal(parseIframeMessage({ ...ok, __fluentExt: true }, meta, expected), null);
  assert.equal(parseIframeMessage({ ...ok, type: "eval" }, meta, expected), null);
  assert.equal(parseIframeMessage("texto", meta, expected), null);
});

test("mensagens de controle levam __fluentCtl para o preâmbulo consumir", () => {
  assert.deepEqual(controlMessage("theme", { kind: "dark" }), { __fluentCtl: 1, type: "theme", kind: "dark" });
});

test("originOf e isExternalLink", () => {
  assert.equal(originOf("http://127.0.0.1:5000/tok/wv/wv1/index.html?v=2"), "http://127.0.0.1:5000");
  assert.equal(originOf("não é url"), "");
  assert.equal(isExternalLink("https://claude.ai"), true);
  assert.equal(isExternalLink("mailto:x@y.z"), true);
  assert.equal(isExternalLink("command:workbench.action.reloadWindow"), false);
  assert.equal(isExternalLink("javascript:alert(1)"), false);
});

test("PendingQueue retém até o iframe ficar pronto e entrega na ordem", () => {
  const got: number[] = [];
  const q = new PendingQueue<number>((n) => got.push(n));
  q.push(1);
  q.push(2);
  assert.deepEqual(got, []);
  assert.equal(q.size, 2);
  q.open();
  assert.deepEqual(got, [1, 2]);
  q.push(3);
  assert.deepEqual(got, [1, 2, 3]);
  q.close();
  q.push(4);
  assert.deepEqual(got, [1, 2, 3]);
  q.open();
  assert.deepEqual(got, [1, 2, 3, 4]);
});
