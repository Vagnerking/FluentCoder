import assert from "node:assert/strict";
import test from "node:test";
import {
  chordFromKey,
  markersToDiagnostics,
  markerSeverityToVscode,
  normalizeChord,
  renderDecorationType,
  themeColorVar,
  toMonacoRange,
  toMonacoSelection,
  toPlainChanges,
  toPlainRange,
  toPlainSelection,
  vscodeSeverityToMarker,
} from "./editorModel.ts";
import { applyStatusBarItem, applyStatusMessage, clearStatusItems, parseStatusText, statusItemsSnapshot } from "./statusBar.ts";
import {
  __resetTerminalBridge,
  configureTerminalBridge,
  handleTerminalEvent,
  ptyClosed,
  ptyIdFor,
  ptyReady,
  subscribeExtTerminals,
} from "./terminalBridge.ts";
import { addExtDiff, clearExtDiffs, extDiffsSnapshot, removeExtDiff, setExtDiffError } from "./diffs.ts";
import { parseIframeMessage } from "./relay.ts";
import type { ExtensionDiffEvent, HostEvent, StatusBarItemEvent } from "./protocol.ts";

test("Monaco (1-based) ↔ protocolo (0-based): faixas, seleções e mudanças", () => {
  const r = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 };
  assert.deepEqual(toPlainRange(r), { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } });
  assert.deepEqual(toMonacoRange(toPlainRange(r)), r);
  const s = { selectionStartLineNumber: 3, selectionStartColumn: 5, positionLineNumber: 1, positionColumn: 2 };
  assert.deepEqual(toPlainSelection(s), { anchor: { line: 2, character: 4 }, active: { line: 0, character: 1 } });
  assert.deepEqual(toMonacoSelection(toPlainSelection(s)), s);
  assert.deepEqual(toPlainChanges([{ range: r, text: "x", rangeOffset: 0, rangeLength: 7 }])[0].range.end, { line: 1, character: 3 });
});

test("markers do Monaco → diagnósticos do VS Code (severidade invertida)", () => {
  assert.deepEqual([8, 4, 2, 1].map(markerSeverityToVscode), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map(vscodeSeverityToMarker), [8, 4, 2, 1]);
  const d = markersToDiagnostics([{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 3, message: "m", severity: 8, owner: "csharp", code: { value: "CS1002" } }]);
  assert.deepEqual(d[0], { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, message: "m", severity: 0, source: "csharp", code: "CS1002" });
});

test("acordes de teclado normalizados (layout independente, cmd = meta)", () => {
  assert.equal(normalizeChord("Cmd+Alt+K"), "alt+meta+k");
  assert.equal(normalizeChord("shift+ctrl+escape"), "ctrl+shift+escape");
  assert.equal(normalizeChord("ctrl++"), "ctrl++");
  assert.equal(chordFromKey({ key: "P", code: "KeyP", ctrl: true, shift: true }), "ctrl+shift+p");
  assert.equal(chordFromKey({ key: "Escape", ctrl: true }), "ctrl+escape");
  assert.equal(chordFromKey({ key: "ArrowUp", alt: true }), "alt+up");
  assert.equal(chordFromKey({ key: "ç", code: "KeyK", alt: true }), "alt+k");
});

test("decorações: CSS seguro + opções do Monaco", () => {
  const resolve = (id: string) => (id === "editor.findMatchBackground" ? "rgba(1,2,3,.4)" : undefined);
  const r = renderDecorationType(
    "d1",
    {
      backgroundColor: { themeColor: "editor.findMatchBackground" },
      isWholeLine: true,
      after: { contentText: 'oi "x"', color: "red" },
      border: "1px solid red;}body{display:none",
      overviewRulerColor: "#ff0000",
    },
    resolve,
  );
  assert.equal(r.options.className, "extd-d1");
  assert.equal(r.options.isWholeLine, true);
  assert.equal(r.options.afterContentClassName, "extd-d1-after");
  assert.equal(r.options.overviewRulerColor, "#ff0000");
  assert.ok(r.css.includes(".extd-d1{background-color:rgba(1,2,3,.4)}"));
  assert.ok(r.css.includes('content:"oi \\"x\\""'));
  assert.ok(!r.css.includes("display:none"), "valor com ; { } descartado");
  const inline = renderDecorationType("d2", { color: "blue" }, resolve);
  assert.equal(inline.options.inlineClassName, "extd-d2");
  assert.equal(themeColorVar("editor.findMatchBackground"), "--vscode-editor-findMatchBackground");
});

test("barra de status: itens por prioridade, mensagens e ícones $(…)", () => {
  clearStatusItems();
  const base: StatusBarItemEvent = { event: "statusBarItem", id: "a", extensionId: "x", visible: true, alignment: "right", priority: 1, text: "$(sync~spin) Sincronizando" };
  applyStatusBarItem(base, () => undefined);
  applyStatusBarItem({ ...base, id: "b", priority: 5, text: "B", color: "#fff" }, (c) => (typeof c === "string" ? c : undefined));
  assert.deepEqual(statusItemsSnapshot().map((i) => i.id), ["b", "a"]);
  assert.equal(statusItemsSnapshot()[0].color, "#fff");
  applyStatusBarItem({ ...base, visible: false }, () => undefined);
  assert.deepEqual(statusItemsSnapshot().map((i) => i.id), ["b"]);
  applyStatusMessage({ id: "m", extensionId: "x", text: "Trabalhando", progress: true });
  assert.ok(statusItemsSnapshot().some((i) => i.id === "m" && i.text.startsWith("$(sync~spin)")));
  applyStatusMessage({ id: "m", extensionId: "x", text: null });
  assert.ok(!statusItemsSnapshot().some((i) => i.id === "m"));
  assert.deepEqual(parseStatusText("$(sync~spin) A $(check)"), [
    { kind: "icon", name: "sync", spin: true },
    { kind: "text", value: " A " },
    { kind: "icon", name: "check", spin: false },
  ]);
  clearStatusItems();
});

test("terminais de extensão: criar/mostrar, texto retido até o PTY, fechar avisa o host", () => {
  __resetTerminalBridge();
  const writes: [string, string][] = [];
  const notes: [string, unknown][] = [];
  configureTerminalBridge({ write: (id, d) => writes.push([id, d]), notify: (m, p) => notes.push([m, p]) });
  // Ação antes de o painel assinar fica no backlog.
  let shown = 0;
  handleTerminalEvent({ event: "terminalCreate", id: "t1", name: "Claude Code", cwd: "/w", env: { A: "1" } } as HostEvent, () => shown++);
  const actions: unknown[] = [];
  const off = subscribeExtTerminals((a) => actions.push(a));
  assert.equal((actions[0] as { type: string; spec: { ptyId: string; name: string } }).spec.ptyId, ptyIdFor("t1"));
  handleTerminalEvent({ event: "terminalShow", id: "t1", preserveFocus: false } as HostEvent, () => shown++);
  assert.equal(shown, 1);
  handleTerminalEvent({ event: "terminalSendText", id: "t1", text: "claude\r" } as HostEvent, () => {});
  assert.equal(writes.length, 0, "retido até o PTY existir");
  ptyReady(ptyIdFor("t1"), 77);
  assert.deepEqual(writes, [["ext-t1", "claude\r"]]);
  assert.deepEqual(notes[0], ["terminalOpened", { id: "t1", pid: 77, shellIntegration: false }]);
  handleTerminalEvent({ event: "terminalSendText", id: "t1", text: "ls\r" } as HostEvent, () => {});
  assert.equal(writes.length, 2);
  ptyClosed(ptyIdFor("t1"), 0);
  assert.deepEqual(notes[1], ["terminalClosed", { id: "t1", exitCode: 0 }]);
  ptyClosed(ptyIdFor("t1"), 0);
  assert.equal(notes.length, 2, "fechar duas vezes avisa uma vez");
  off();
  __resetTerminalBridge();
});

test("fila de diffs das extensões (formato do ClaudeDiffReview)", () => {
  clearExtDiffs();
  const ev: ExtensionDiffEvent = {
    event: "diff",
    diffId: "diff1",
    title: "a.ts (proposta)",
    extensionName: "Claude Code",
    filePath: "/w/a.ts",
    isNewFile: false,
    reviewable: true,
    left: { uri: "file:///w/a.ts", path: "/w/a.ts", content: "1" },
    right: { uri: "_claude_fs_right:/w/a.ts", content: "2" },
  };
  addExtDiff(ev);
  addExtDiff(ev); // mesmo id: substitui
  assert.equal(extDiffsSnapshot().length, 1);
  const d = extDiffsSnapshot()[0];
  assert.deepEqual([d.id, d.newPath, d.original, d.proposed, d.sourceLabel], ["diff1", "/w/a.ts", "1", "2", "Claude Code"]);
  setExtDiffError("diff1", "falhou");
  assert.equal(extDiffsSnapshot()[0].error, "falhou");
  removeExtDiff("diff1");
  assert.equal(extDiffsSnapshot().length, 0);
});

test("relay: atalhos e área de transferência do iframe validados", () => {
  const win = {};
  const meta = { origin: "http://127.0.0.1:1", source: win };
  const exp = { origin: "http://127.0.0.1:1", source: win, handle: "wv1" };
  const key = parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "key", key: "P", code: "KeyP", ctrl: true, shift: true }, meta, exp);
  assert.deepEqual(key, { type: "key", handle: "wv1", key: "P", code: "KeyP", ctrl: true, shift: true, alt: false, meta: false, repeat: false });
  assert.equal(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "key", key: "x".repeat(100) }, meta, exp), null);
  assert.deepEqual(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "clipboard", op: "write", text: "oi" }, meta, exp), { type: "clipboard", handle: "wv1", op: "write", text: "oi" });
  assert.deepEqual(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "clipboard", op: "read", nonce: 3 }, meta, exp), { type: "clipboard", handle: "wv1", op: "read", nonce: 3 });
  assert.equal(parseIframeMessage({ __fluentExt: 1, handle: "wv1", type: "clipboard", op: "exec" }, meta, exp), null);
  assert.equal(parseIframeMessage({ __fluentExt: 1, handle: "wv2", type: "key", key: "p" }, meta, exp), null, "handle de outro webview");
});
