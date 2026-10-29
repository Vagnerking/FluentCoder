import test from "node:test";
import assert from "node:assert/strict";
import { CORE_SETTINGS } from "./coreSettings.ts";
import { SettingsRegistry } from "./registry.ts";
import { completionContext, settingsDiagnostics, settingsFileKind } from "./settingsJson.ts";

const reg = new SettingsRegistry();
reg.register(CORE_SETTINGS);

test("tipo do arquivo de configuração pelo caminho", () => {
  assert.equal(settingsFileKind("/w/.vscode/settings.json"), "settings");
  assert.equal(settingsFileKind("C:\\cfg\\User\\settings.json"), "settings");
  assert.equal(settingsFileKind("/cfg/User/keybindings.json"), "keybindings");
  assert.equal(settingsFileKind("/w/a.code-workspace"), "workspace");
  assert.equal(settingsFileKind("/w/package.json"), null);
});

test("validação: tipo errado, enum, chave desconhecida, override de linguagem", () => {
  const text = '{\n  "editor.tabSize": "dois",\n  "editor.wordWrap": "talvez",\n  "ext.qualquer": 1,\n  "[python]": { "workbench.sideBar.location": "right", "editor.tabSize": 4 }\n}';
  const d = settingsDiagnostics(text, "settings", reg);
  const msgs = d.map((x) => `${x.severity}:${x.message}`);
  assert.ok(msgs.some((m) => m.startsWith("warning:Tipo incorreto")));
  assert.ok(msgs.some((m) => m.startsWith("warning:Valor não permitido")));
  assert.ok(msgs.some((m) => m.startsWith("info:Configuração desconhecida: ext.qualquer")));
  assert.ok(msgs.some((m) => m.includes("não pode ser definida por linguagem")));
  assert.equal(d.filter((x) => x.severity === "error").length, 0);
  // Workspace: só o objeto "settings" é validado.
  assert.equal(settingsDiagnostics('{ "folders": [], "settings": { "editor.fontSize": 400 } }', "workspace", reg).length, 1);
  assert.ok(settingsDiagnostics('[{ "key": "ctrl+x" }]', "keybindings", reg).some((x) => x.message.includes("command")));
});

test("contexto de completion: chave, valor, dentro de [lang] e comando", () => {
  const t1 = '{\n  "editor.tabSize": 2,\n  \n}';
  assert.equal(completionContext(t1, t1.indexOf("\n  \n") + 3, "settings")?.kind, "key");
  const t2 = '{\n  "editor.wordWrap": \n}';
  assert.deepEqual(completionContext(t2, t2.indexOf(": ") + 2, "settings"), { kind: "value", key: "editor.wordWrap" });
  const t3 = '{ "[python]": {  } }';
  const c3 = completionContext(t3, t3.indexOf("{  }") + 2, "settings");
  assert.equal(c3?.kind === "key" && c3.inLanguage, true);
  const t4 = '[{ "key": "ctrl+x", "command": "me';
  assert.deepEqual(completionContext(t4, t4.length, "keybindings"), { kind: "command" });
});
