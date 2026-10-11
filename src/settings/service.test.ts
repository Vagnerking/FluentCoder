import test from "node:test";
import assert from "node:assert/strict";
import { CORE_SETTINGS } from "./coreSettings.ts";
import { SettingsRegistry, validateSettingValue } from "./registry.ts";
import { SettingsService, type SettingsIO } from "./service.ts";
import { ConfigurationModel, toLayer, languagesOfKey, folderFor } from "./model.ts";
import { parseJsoncObject } from "./jsonc.ts";
import { collectLegacySettings, legacyExtHostValues } from "./migration.ts";
import { workbenchAttributes } from "./applyWorkbench.ts";

function fakeIO(files: Record<string, string>) {
  const writes: string[] = [];
  let onChange: ((p: string[]) => void) | null = null;
  const io: SettingsIO = {
    paths: async () => ({ userSettings: "/cfg/User/settings.json", userKeybindings: "/cfg/User/keybindings.json" }),
    read: async (paths) => Object.fromEntries(paths.map((p) => [p, files[p] ?? null])),
    write: async (p, t) => {
      files[p] = t;
      writes.push(p);
    },
    watch: async () => {},
    onFilesChanged: (cb) => {
      onChange = cb;
      return () => (onChange = null);
    },
  };
  return { io, files, writes, external: (p: string, text: string) => ((files[p] = text), onChange?.([p])) };
}

function registry() {
  const r = new SettingsRegistry();
  r.register(CORE_SETTINGS);
  return r;
}

test("precedência: default < user < workspace < folder; linguagem vence tudo", () => {
  const m = new ConfigurationModel();
  m.setDefaults({ "editor.tabSize": 2, "[python]": { "editor.tabSize": 4 } });
  assert.equal(m.get("editor.tabSize"), 2);
  assert.equal(m.get("editor.tabSize", { languageId: "python" }), 4);
  m.user = toLayer({ "editor.tabSize": 3 });
  assert.equal(m.get("editor.tabSize"), 3);
  assert.equal(m.get("editor.tabSize", { languageId: "python" }), 4, "default de linguagem vence user geral (VS Code)");
  m.workspace = toLayer({ "editor.tabSize": 5, "[python]": { "editor.tabSize": 6 } });
  m.folders = [{ root: "/w/a", layer: toLayer({ "editor.tabSize": 7 }) }];
  assert.equal(m.get("editor.tabSize"), 5);
  assert.equal(m.get("editor.tabSize", { resource: "/w/a/x.ts" }), 7);
  assert.equal(m.get("editor.tabSize", { resource: "/w/b/x.ts" }), 5);
  assert.equal(m.get("editor.tabSize", { resource: "/w/a/x.py", languageId: "python" }), 6);
  const i = m.inspect("editor.tabSize", { resource: "/w/a/x.py", languageId: "python" });
  assert.equal(i.defaultValue, 2);
  assert.equal(i.userValue, 3);
  assert.equal(i.workspaceValue, 5);
  assert.equal(i.workspaceFolderValue, 7);
  assert.equal(i.workspaceLanguageValue, 6);
  assert.equal(i.defaultLanguageValue, 4);
});

test("objetos são mesclados entre camadas (files.exclude)", () => {
  const m = new ConfigurationModel();
  m.setDefaults({ "files.exclude": { "**/.git": true, "**/bin": true } });
  m.user = toLayer({ "files.exclude": { "**/bin": false, "**/dist": true } });
  assert.deepEqual(m.get("files.exclude"), { "**/.git": true, "**/bin": false, "**/dist": true });
});

test("toLayer: [a][b], objetos aninhados e chaves desconhecidas preservadas", () => {
  const r = registry();
  const l = toLayer({ "[javascript][typescript]": { "editor.tabSize": 4 }, editor: { fontSize: 20 }, "minha.ext.flag": true }, r);
  assert.deepEqual(l.overrides.javascript, { "editor.tabSize": 4 });
  assert.deepEqual(l.overrides.typescript, { "editor.tabSize": 4 });
  assert.equal(l.settings["editor.fontSize"], 20);
  assert.equal(l.settings["minha.ext.flag"], true);
  assert.deepEqual(languagesOfKey("[a][b]"), ["a", "b"]);
  assert.equal(languagesOfKey("editor"), null);
});

test("folderFor escolhe a raiz mais específica e ignora caixa no Windows", () => {
  const folders = [{ root: "/w", layer: toLayer({}) }, { root: "/w/sub", layer: toLayer({}) }, { root: "C:/Proj", layer: toLayer({}) }];
  assert.equal(folderFor(folders, "/w/sub/a.ts")?.root, "/w/sub");
  assert.equal(folderFor(folders, "/w/a.ts")?.root, "/w");
  assert.equal(folderFor(folders, "c:\\proj\\x.cs")?.root, "C:/Proj");
  assert.equal(folderFor(folders, "/other"), undefined);
});

test("serviço: pasta lê .vscode e .fluent (fluent vence) e grava em .fluent preservando comentários", async () => {
  const { io, files } = fakeIO({
    "/cfg/User/settings.json": '{\n  // meu\n  "editor.fontSize": 15\n}\n',
    "/w/.vscode/settings.json": '{\n  "editor.tabSize": 8,\n  "editor.wordWrap": "on",\n  "ext.unknown": 1\n}',
    "/w/.fluent/settings.json": '{ "editor.tabSize": 3 }',
  });
  const s = new SettingsService(registry(), io);
  await s.init();
  await s.setWorkspace({ mode: "folder", roots: ["/w"] });
  assert.equal(s.get("editor.fontSize"), 15);
  assert.equal(s.get("editor.tabSize"), 3);
  assert.equal(s.get("editor.wordWrap"), "on");
  assert.equal(s.get("ext.unknown"), 1, "chaves desconhecidas continuam disponíveis (extensões)");

  const events: string[][] = [];
  s.onDidChange((e) => events.push([...e.keys]));
  await s.update("editor.fontSize", 18, "user");
  assert.ok(files["/cfg/User/settings.json"].includes("// meu"));
  assert.equal(s.get("editor.fontSize"), 18);
  assert.deepEqual(events.at(-1), ["editor.fontSize"]);

  await s.update("editor.rulers", [100], "workspace");
  assert.deepEqual(parseJsoncObject(files["/w/.fluent/settings.json"])["editor.rulers"], [100]);

  // Restaurar padrão no workspace remove dos dois arquivos.
  await s.update("editor.tabSize", undefined, "workspace");
  assert.equal(s.get("editor.tabSize"), 2);
  assert.equal(parseJsoncObject(files["/w/.vscode/settings.json"])["editor.tabSize"], undefined);
  assert.equal(parseJsoncObject(files["/w/.vscode/settings.json"])["ext.unknown"], 1);
});

test("serviço: override de linguagem e validação", async () => {
  const { io, files } = fakeIO({});
  const s = new SettingsService(registry(), io);
  await s.init();
  await s.update("editor.tabSize", 4, "user", { languageId: "python", overrideInLanguage: true });
  assert.deepEqual(parseJsoncObject(files["/cfg/User/settings.json"])["[python]"], { "editor.tabSize": 4 });
  assert.equal(s.get("editor.tabSize", { languageId: "python" }), 4);
  assert.equal(s.get("editor.tabSize"), 2);
  await assert.rejects(s.update("editor.tabSize", "x", "user"), /Tipo incorreto/);
  await assert.rejects(s.update("editor.wordWrap", "talvez", "user"), /não permitido/);
});

test("serviço: workspace multi-root grava no settings do arquivo de workspace e por pasta", async () => {
  const wsFile = "/ws/proj.fluent-workspace";
  const { io, files } = fakeIO({
    [wsFile]: '{\n  "fluentWorkspace": 1,\n  // pastas\n  "folders": [],\n  "settings": { "editor.tabSize": 6 }\n}',
    "/a/.vscode/settings.json": '{ "editor.tabSize": 1 }',
  });
  const s = new SettingsService(registry(), io);
  await s.init();
  let pushed: Record<string, unknown> | null = null;
  await s.setWorkspace({ mode: "workspace", roots: ["/a", "/b"], workspaceFile: wsFile }, (st) => (pushed = st));
  assert.equal(s.get("editor.tabSize"), 6);
  assert.equal(s.get("editor.tabSize", { resource: "/a/x.ts" }), 1);
  assert.equal(s.get("editor.tabSize", { resource: "/b/x.ts" }), 6);
  await s.update("editor.wordWrap", "on", "workspace");
  assert.ok(files[wsFile].includes("// pastas"));
  assert.deepEqual(parseJsoncObject(files[wsFile]).settings, { "editor.tabSize": 6, "editor.wordWrap": "on" });
  assert.deepEqual(pushed, { "editor.tabSize": 6, "editor.wordWrap": "on" });
  await s.update("editor.wordWrap", "bounded", "folder", { resource: "/b/y.ts" });
  assert.equal(parseJsoncObject(files["/b/.fluent/settings.json"])["editor.wordWrap"], "bounded");
  assert.equal(s.get("editor.wordWrap", { resource: "/b/y.ts" }), "bounded");
  assert.equal(s.canWrite("extensions.autoUpdate", "workspace"), false);
  assert.equal(s.canWrite("editor.tabSize", "folder"), true);
  assert.equal(s.canWrite("workbench.sideBar.location", "folder"), false);
});

test("serviço: workspace não salvo guarda settings em memória", async () => {
  const { io } = fakeIO({});
  const s = new SettingsService(registry(), io);
  await s.init();
  let pushed: Record<string, unknown> | null = null;
  await s.setWorkspace({ mode: "workspace", roots: [], workspaceSettings: { "editor.fontSize": 11 } }, (st) => (pushed = st));
  assert.equal(s.get("editor.fontSize"), 11);
  await s.update("editor.fontSize", 12, "workspace");
  assert.equal(s.get("editor.fontSize"), 12);
  assert.deepEqual(pushed, { "editor.fontSize": 12 });
});

test("serviço: edição externa dispara evento com as chaves alteradas", async () => {
  const ctx = fakeIO({ "/cfg/User/settings.json": "{}" });
  const s = new SettingsService(registry(), ctx.io);
  await s.init();
  const got = new Promise<string[]>((resolve) => s.onDidChange((e) => resolve([...e.keys])));
  ctx.external("/cfg/User/settings.json", '{ "editor.minimap.enabled": true }');
  assert.deepEqual(await got, ["editor.minimap.enabled"]);
  assert.equal(s.get("editor.minimap.enabled"), true);
});

test("extensões: contributes.configuration entra no registro sem sobrescrever o core", () => {
  const r = registry();
  r.registerExtension("pub.ext", "Ext", {
    contributes: {
      configuration: { properties: { "ext.a": { type: "boolean", default: true, markdownDescription: "Liga **A**" }, "editor.tabSize": { default: 9 } } },
      configurationDefaults: { "[markdown]": { "editor.wordWrap": "on" } },
    },
  });
  assert.equal(r.get("ext.a")?.description, "Liga A");
  assert.equal(r.get("ext.a")?.source, "pub.ext");
  assert.equal(r.get("editor.tabSize")?.default, 2);
  assert.deepEqual(r.defaults()["[markdown]"], { "editor.wordWrap": "on" });
  r.unregisterExtension("pub.ext");
  assert.equal(r.get("ext.a"), undefined);
});

test("validação de valores", () => {
  const r = registry();
  assert.equal(validateSettingValue(r.get("editor.fontSize")!, 300), "O valor máximo é 100.");
  assert.equal(validateSettingValue(r.get("editor.fontSize")!, 13), null);
  assert.equal(validateSettingValue(r.get("editor.fontLigatures")!, "ss01"), null);
  assert.match(validateSettingValue(r.get("editor.tabSize")!, 2.5) ?? "", /Tipo/);
});

test("migração: chaves antigas do localStorage viram settings (só o que difere do default)", () => {
  const store = new Map<string, string>([
    ["editor.formatOnSave", "1"],
    ["csharp.inlayHints", "0"],
    ["git.autofetch", "off"],
    ["ui.sidebarSide", "right"],
    ["ui.activityBarPos", "side"],
    ["ui.scale", "1.2"],
    ["files.exclude", JSON.stringify({ "**/.git": true, "**/bin": false, "**/dist": true })],
    ["ui.acrylicFlyouts", "talvez"],
    ["ui.sidebarWidth", "300"],
  ]);
  const { values, consumed } = collectLegacySettings({ getItem: (k) => store.get(k) ?? null }, registry().defaults());
  assert.deepEqual(values, {
    "editor.formatOnSave": true,
    "git.autofetch": false,
    "workbench.sideBar.location": "right",
    "fluent.ui.scale": 1.2,
    "files.exclude": { "**/bin": false, "**/dist": true },
  });
  assert.ok(consumed.includes("ui.acrylicFlyouts"));
  assert.ok(!consumed.includes("ui.sidebarWidth"), "tamanhos de painel continuam no localStorage");
  assert.deepEqual(legacyExtHostValues({ a: 1, b: 2 }, { b: 3 }), { a: 1 });
});

test("workbench: atributos de acessibilidade/abas a partir das settings", () => {
  const vals: Record<string, unknown> = {
    "workbench.reduceMotion": "auto",
    "fluent.accessibility.highContrast": "on",
    "fluent.ui.fontSize": 15,
    "workbench.editor.tabActionLocation": "left",
    "workbench.statusBar.visible": false,
    "workbench.editor.showTabs": "multiple",
    "workbench.editor.tabSizing": "fit",
  };
  const { attrs, vars } = workbenchAttributes((k) => vals[k], { prefersReducedMotion: true, prefersContrast: false });
  assert.equal(attrs["data-reduce-motion"], "on");
  assert.equal(attrs["data-high-contrast"], "on");
  assert.equal(attrs["data-tab-close"], "left");
  assert.equal(attrs["data-statusbar"], "hidden");
  assert.equal(attrs["data-show-tabs"], null);
  assert.equal(vars["--font-base"], "15px");
});
