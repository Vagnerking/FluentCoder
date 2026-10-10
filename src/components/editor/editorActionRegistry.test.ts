import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeEditorActions,
  contributedEditorActions,
  registerEditorAction,
  type EditorActionContext,
  type EditorActionItem,
} from "./editorActionRegistry.ts";

const ctx: EditorActionContext = { file: null, groupId: "g0", isActiveGroup: true };
const item = (id: string, extra: Partial<EditorActionItem> = {}): EditorActionItem => ({
  id,
  icon: "more",
  label: id,
  ...extra,
});

test("filtra por when, ordena e transborda o excedente para Mais ações", () => {
  const { primary, overflow } = arrangeEditorActions(
    [
      item("split", { order: 90 }),
      item("git", { order: 50 }),
      item("hidden", { when: () => false }),
      item("claude", { order: 20 }),
      item("menu-only", { group: "overflow" }),
    ],
    ctx,
    2
  );
  assert.deepEqual(primary.map((i) => i.id), ["claude", "git"]);
  assert.deepEqual(overflow.map((i) => i.id), ["split", "menu-only"]);
});

test("ids duplicados: vale o primeiro (local antes do contribuído)", () => {
  const { primary } = arrangeEditorActions([item("a", { label: "local" }), item("a", { label: "x" })], ctx, 5);
  assert.equal(primary.length, 1);
  assert.equal(primary[0].label, "local");
});

test("registro de contribuições: registrar, substituir e remover", () => {
  const dispose = registerEditorAction(item("codex"));
  assert.ok(contributedEditorActions().some((i) => i.id === "codex"));
  const replacement = item("codex", { label: "Codex" });
  const dispose2 = registerEditorAction(replacement);
  dispose(); // a versão antiga não remove a nova
  assert.equal(contributedEditorActions().find((i) => i.id === "codex")?.label, "Codex");
  dispose2();
  assert.equal(contributedEditorActions().some((i) => i.id === "codex"), false);
});
