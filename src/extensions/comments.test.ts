import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetComments,
  commentThreads,
  removeCommentThread,
  sortActions,
  subscribeCommentThreads,
  threadAnchorLine,
  threadTitle,
  upsertCommentThread,
  type CommentThreadInfo,
} from "./comments.ts";
import { minimalEdit } from "./textEdits.ts";

function thread(over: Partial<CommentThreadInfo> = {}): CommentThreadInfo {
  return {
    handle: "ct1",
    extensionId: "anthropic.claude-code",
    controllerId: "claude-code-hunks",
    uri: "_claude_vscode_fs_right:/w/a.ts",
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } },
    label: " ",
    collapsibleState: 1,
    canReply: false,
    comments: [],
    actions: [],
    replyActions: [],
    canReact: false,
    ...over,
  };
}

test("store de threads: upsert, remoção e assinatura", () => {
  __resetComments();
  let calls = 0;
  const off = subscribeCommentThreads(() => calls++);
  upsertCommentThread(thread());
  upsertCommentThread(thread({ label: "x" }));
  assert.equal(commentThreads().length, 1);
  assert.equal(commentThreads()[0].label, "x");
  removeCommentThread("ct1");
  removeCommentThread("ct1"); // repetido: sem aviso
  assert.equal(commentThreads().length, 0);
  assert.equal(calls, 3);
  off();
});

test("âncora do widget: abaixo da última linha da faixa (1-based); sem faixa = topo", () => {
  assert.equal(threadAnchorLine(thread()), 5);
  assert.equal(threadAnchorLine(thread({ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 3 } } })), 3);
  assert.equal(threadAnchorLine(thread({ range: null })), 0);
});

test("ações inline primeiro, na ordem do @n; título vazio para o rótulo ' ' do Claude", () => {
  const sorted = sortActions([
    { command: "b", title: "B", group: "inline@2" },
    { command: "z", title: "Z" },
    { command: "a", title: "A", group: "inline@1" },
  ]);
  assert.deepEqual(sorted.map((a) => a.command), ["a", "b", "z"]);
  assert.equal(threadTitle(thread()), "");
  assert.equal(threadTitle(thread({ label: "Revisão" })), "Revisão");
});

test("minimalEdit: só o trecho que mudou", () => {
  assert.equal(minimalEdit("abc", "abc"), null);
  assert.deepEqual(minimalEdit("const a = 100;\nb\n", "const a = 1;\nb\n"), { start: 11, end: 13, text: "" });
  assert.deepEqual(minimalEdit("x\ny\n", "x\nY\nz\n"), { start: 2, end: 3, text: "Y\nz" });
  assert.deepEqual(minimalEdit("", "novo"), { start: 0, end: 0, text: "novo" });
});

test("faixas comentáveis: controller por linha, linhas únicas e modo edição", async () => {
  const { controllerForLine, commentableLines, isEditing } = await import("./comments.ts");
  const list = [
    { controllerId: "a", ranges: [{ start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }], enableFileComments: false },
    { controllerId: "b", ranges: [{ start: { line: 2, character: 0 }, end: { line: 4, character: 0 } }], enableFileComments: true },
  ];
  assert.equal(controllerForLine(list, 1), "a");
  assert.equal(controllerForLine(list, 2), "a", "o primeiro controller vence na sobreposição");
  assert.equal(controllerForLine(list, 4), "b");
  assert.equal(controllerForLine(list, 9), null);
  assert.deepEqual(commentableLines(list), [0, 1, 2, 3, 4]);
  assert.equal(commentableLines(list, 2).length, 2, "teto respeitado");
  assert.equal(isEditing({ mode: 0 }), true);
  assert.equal(isEditing({ mode: 1 }), false);
  assert.equal(isEditing({}), false);
});
