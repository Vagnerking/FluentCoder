import assert from "node:assert/strict";
import test from "node:test";
import { formatKeybinding, keybindingFor } from "./keybindingLabel.ts";

test("atalhos da Paleta: formato das extensões e dos menus viram o mesmo rótulo", () => {
  assert.equal(formatKeybinding("ctrl+shift+escape"), "Ctrl+Shift+Esc");
  assert.equal(formatKeybinding("Ctrl+K Ctrl+O"), "Ctrl+K Ctrl+O");
  assert.equal(formatKeybinding("alt+k"), "Alt+K");
  assert.equal(formatKeybinding("ctrl++"), "Ctrl++");
  assert.equal(formatKeybinding("f5"), "F5");
  assert.equal(formatKeybinding("cmd+shift+p", true), "⌘⇧P");
  assert.equal(formatKeybinding(""), undefined);
  assert.equal(formatKeybinding(undefined), undefined);
  const kbs = [
    { command: "claude-vscode.insertAtMention", key: "alt+k", when: "editorTextFocus" },
    { command: "x.nunca", key: "ctrl+j", when: "false" },
  ];
  assert.equal(keybindingFor("claude-vscode.insertAtMention", kbs), "Alt+K");
  assert.equal(keybindingFor("x.nunca", kbs), undefined);
  assert.equal(keybindingFor("outro", kbs), undefined);
  assert.equal(keybindingFor("outro", undefined), undefined);
});
