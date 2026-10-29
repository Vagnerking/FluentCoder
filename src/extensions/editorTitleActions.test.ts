import assert from "node:assert/strict";
import test from "node:test";
import { isSidebarCommand, planExtensionEditorActions, whenKey } from "./editorTitleActions.ts";
import type { InstalledExtension } from "./protocol.ts";

const ext = (id: string, label: string, extra: Partial<InstalledExtension> = {}): InstalledExtension => ({
  id,
  path: `/x/${id}`,
  version: "1.0.0",
  displayName: label,
  supported: true,
  label,
  viewIds: ["v"],
  ...extra,
});

const CLAUDE = ext("anthropic.claude-code", "Claude Code", {
  icon: "data:image/svg+xml;base64,AAA",
  editorTitle: [
    { command: "claude-vscode.editor.openLast", title: "Claude Code: Open", when: "!config.claudeCode.useTerminal", icon: { src: "data:img" } },
    { command: "claude-vscode.terminal.open", title: "Claude Code: Open in Terminal", when: "config.claudeCode.useTerminal" },
  ],
});
const CODEX = ext("openai.chatgpt", "Codex", {
  icon: "data:codex",
  editorTitle: [{ command: "chatgpt.openSidebar", title: "Codex: Open Codex Sidebar" }],
});

test("um botão por extensão com view (ícone dela) + comandos contribuídos no overflow pelo when", () => {
  const when = {
    [whenKey(CLAUDE.id, "claude-vscode.editor.openLast")]: true,
    [whenKey(CLAUDE.id, "claude-vscode.terminal.open")]: false,
  };
  const plan = planExtensionEditorActions([CLAUDE, CODEX], when);
  assert.deepEqual(
    plan.map((a) => [a.id, a.kind, a.group, a.label, a.commands.join()]),
    [
      ["ext-view-anthropic-claude-code", "reveal", "primary", "Mostrar Claude Code", ""],
      ["ext-cmd-claude-vscode-editor-openlast", "command", "overflow", "Claude Code: Open", "claude-vscode.editor.openLast"],
      // "Open Codex Sidebar" = o próprio revelar: roda junto com o botão, sem item duplicado.
      ["ext-view-openai-chatgpt", "reveal", "primary", "Mostrar Codex", "chatgpt.openSidebar"],
    ],
  );
  assert.equal(plan[0].iconImage, "data:image/svg+xml;base64,AAA");
  assert.equal(plan[1].iconImage, "data:img");
});

test("when ainda não avaliado: só entra o que não tem when; config muda o comando aplicável", () => {
  const unknown = planExtensionEditorActions([CLAUDE], {});
  assert.deepEqual(unknown.map((a) => a.id), ["ext-view-anthropic-claude-code"]);
  const terminal = planExtensionEditorActions([CLAUDE], {
    [whenKey(CLAUDE.id, "claude-vscode.editor.openLast")]: false,
    [whenKey(CLAUDE.id, "claude-vscode.terminal.open")]: true,
  });
  assert.deepEqual(terminal.map((a) => a.label), ["Mostrar Claude Code", "Claude Code: Open in Terminal"]);
});

test("extensões bloqueadas não ganham ações; sem view não há botão de revelar", () => {
  assert.deepEqual(planExtensionEditorActions([{ ...CODEX, supported: false }], {}), []);
  const noView = planExtensionEditorActions([{ ...CODEX, viewIds: [] }], {});
  assert.deepEqual(noView.map((a) => [a.kind, a.label]), [["command", "Codex: Open Codex Sidebar"]]);
  assert.equal(isSidebarCommand({ command: "x.open", title: "Abrir na barra lateral" }), true);
  assert.equal(isSidebarCommand({ command: "claude-vscode.editor.openLast", title: "Claude Code: Open" }), false);
});
