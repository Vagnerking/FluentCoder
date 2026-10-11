import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_APP_KEYBINDINGS,
  canonicalCommand,
  chordFromEvent,
  evaluateWhen,
  findConflicts,
  matchKeybinding,
  normalizeKey,
  parseKeybindingsJson,
  resolveKeybindings,
} from "./keybindings.ts";
import { formatKeybinding } from "../platform/keybinding.ts";

test("normaliza teclas: ordem dos modificadores, aliases, acordes e Ctrl/⌘ equivalentes", () => {
  assert.equal(normalizeKey("Shift+Ctrl+P"), "ctrl+shift+p");
  assert.equal(normalizeKey("cmd+s"), "ctrl+s");
  assert.equal(normalizeKey("ctrl+k  ctrl+S"), "ctrl+k ctrl+s");
  assert.equal(normalizeKey("alt+UP"), "alt+uparrow");
  assert.equal(normalizeKey("ctrl++"), "ctrl+=");
  assert.equal(normalizeKey("escape"), "escape");
});

test("acorde do evento usa o code (layout) e trata ⌘ como Ctrl", () => {
  assert.equal(chordFromEvent({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), "ctrl+shift+p");
  assert.equal(chordFromEvent({ key: "s", code: "KeyS", ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }), "ctrl+s");
  assert.equal(chordFromEvent({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }), "ctrl+shift+2");
  assert.equal(chordFromEvent({ key: "Control", code: "ControlLeft", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), null);
  assert.equal(chordFromEvent({ key: ",", code: "Comma", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }), "ctrl+,");
});

test("when: !, &&, ||, ==, !=, =~, <, in, parênteses e config.*", () => {
  const ctx = (k: string): unknown =>
    ({ editorTextFocus: true, terminalFocus: false, resourceLangId: "csharp", resourceExtname: ".cs", "config.editor.tabSize": 4, list: ["a", "b"], item: "b" })[k];
  assert.equal(evaluateWhen("editorTextFocus && !terminalFocus", ctx), true);
  assert.equal(evaluateWhen("terminalFocus || resourceLangId == csharp", ctx), true);
  assert.equal(evaluateWhen("resourceLangId == 'typescript'", ctx), false);
  assert.equal(evaluateWhen("resourceLangId != typescript", ctx), true);
  assert.equal(evaluateWhen("resourceExtname =~ /\\.(cs|vb)$/", ctx), true);
  assert.equal(evaluateWhen("config.editor.tabSize > 2", ctx), true);
  assert.equal(evaluateWhen("item in list", ctx), true);
  assert.equal(evaluateWhen("item not in list", ctx), false);
  assert.equal(evaluateWhen("!(editorTextFocus && terminalFocus)", ctx), true);
  assert.equal(evaluateWhen("", ctx), true);
  assert.equal(evaluateWhen("naoExiste", ctx), false);
});

test("keybindings.json: parse, -command remove o padrão e o do usuário vence", () => {
  const { rules, errors } = parseKeybindingsJson(`[
    // comentário
    { "key": "ctrl+shift+s", "command": "-menu.file.saveAs" },
    { "key": "ctrl+shift+s", "command": "menu.file.saveAll", "when": "editorTextFocus" },
    { "key": "ctrl+p", "command": "workbench.action.showCommands" },
    { "command": "-menu.view.toggleSidebar" },
    { "key": "x" }
  ]`);
  assert.equal(errors.length, 1, "o item sem command vira erro, não quebra o resto");
  const all = resolveKeybindings(DEFAULT_APP_KEYBINDINGS, rules);
  assert.ok(!all.some((r) => r.command === "menu.file.saveAs"), "removido por -command");
  assert.ok(!all.some((r) => r.command === "menu.view.toggleSidebar"), "-command sem key remove todos os atalhos do comando");
  const ctx = (k: string) => (k === "editorTextFocus" ? true : undefined);
  const m = matchKeybinding(all, null, "ctrl+p", ctx);
  assert.equal(m.kind === "match" && canonicalCommand(m.rule.command), "menu.view.commandPalette", "o do usuário (posterior) vence o padrão");
  assert.equal(matchKeybinding(all, null, "ctrl+k", ctx).kind, "chord");
  const k2 = matchKeybinding(all, "ctrl+k", "ctrl+s", ctx);
  assert.equal(k2.kind === "match" && k2.rule.command, "keybindings.open");
  assert.equal(matchKeybinding(all, null, "ctrl+shift+s", () => false).kind, "none", "when falso não casa");
});

test("conflitos: mesma tecla, comandos diferentes, when que podem coincidir", () => {
  const c = findConflicts([
    { key: "ctrl+s", command: "a", source: "default" },
    { key: "ctrl+s", command: "b", source: "user" },
    { key: "ctrl+j", command: "c", when: "editorTextFocus", source: "default" },
    { key: "ctrl+j", command: "d", when: "terminalFocus", source: "user" },
  ]);
  assert.deepEqual(c, [{ key: "ctrl+s", commands: ["a", "b"] }]);
});

test("formatKeybinding exibe os atalhos por SO", () => {
  assert.equal(formatKeybinding("ctrl+k ctrl+s", "windows"), "Ctrl+K Ctrl+S");
  assert.equal(formatKeybinding("ctrl+shift+p", "macos"), "⇧⌘P");
});
