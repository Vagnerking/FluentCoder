import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { classify, satisfiesEngine, summarizeContributions, type ApiScan, type Capabilities } from "./compatibility.ts";

const caps: Capabilities = JSON.parse(fs.readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"));
const host = "linux-x64";
const base = { name: "x", publisher: "acme", version: "1.0.0", engines: { vscode: "^1.80.0" } };
const scan = (paths: [string, number][], called: string[] = paths.map(([p]) => p)): ApiScan => ({ bindings: 1, paths, called });

test("engines.vscode: faixas comuns", () => {
  assert.equal(satisfiesEngine("1.106.0", "^1.94.0"), true);
  assert.equal(satisfiesEngine("1.106.0", "^1.107.0"), false);
  assert.equal(satisfiesEngine("1.106.0", ">=1.60.0"), true);
  assert.equal(satisfiesEngine("1.106.0", "~1.106.0"), true);
  assert.equal(satisfiesEngine("1.106.0", "~1.105.0"), false);
  assert.equal(satisfiesEngine("1.106.0", "*"), true);
  assert.equal(satisfiesEngine("1.106.0", "1.x"), true);
  assert.equal(satisfiesEngine("1.106.0", "^1.90.0-insider"), true);
  assert.equal(satisfiesEngine("1.106.0", ">=1.50.0 <1.100.0"), false);
  assert.equal(satisfiesEngine("1.106.0", "^2.0.0 || ^1.100.0"), true);
  assert.equal(satisfiesEngine("1.106.0", "qualquer"), null);
});

test("sem código analisado nunca é positivo: Não avaliada", () => {
  const r = classify({ manifest: { ...base, main: "./out/ext.js", contributes: { commands: [{ command: "a", title: "A" }] } }, hostPlatform: host, apiScan: null }, caps);
  assert.equal(r.verdict, "unknown");
  assert.ok(r.reasons.some((x) => x.code === "code-not-analyzed"));
  assert.equal(r.analyzed.code, false);
});

test("código analisado só com APIs implementadas: Compatível", () => {
  const r = classify(
    {
      manifest: { ...base, main: "./out/ext.js", activationEvents: ["onStartupFinished"], contributes: { commands: [{ command: "a", title: "A" }], configuration: { properties: { "x.a": {} } } } },
      hostPlatform: host,
      apiScan: scan([["commands.registerCommand", 2], ["window.createTextEditorDecorationType", 1], ["Range", 3], ["workspace.getConfiguration", 1]]),
    },
    caps,
  );
  assert.equal(r.verdict, "compatible", JSON.stringify(r.reasons));
});

test("bloqueios: engine, plataforma, só web, API ausente chamada, dependência", () => {
  const engine = classify({ manifest: { ...base, engines: { vscode: "^1.200.0" }, main: "a.js" }, hostPlatform: host, apiScan: scan([]) }, caps);
  assert.equal(engine.verdict, "incompatible");
  assert.ok(engine.reasons[0].message.includes(caps.hostVersion));
  assert.equal(classify({ manifest: { ...base, main: "a.js" }, targetPlatform: "darwin-arm64", hostPlatform: host, apiScan: scan([]) }, caps).verdict, "incompatible");
  assert.equal(classify({ manifest: { ...base, browser: "./web.js" }, hostPlatform: host }, caps).verdict, "incompatible");
  const absent = classify({ manifest: { ...base, main: "a.js", contributes: { commands: [{ command: "a", title: "A" }] } }, hostPlatform: host, apiScan: scan([["languages.registerDocumentFormattingEditProvider", 1], ["commands.registerCommand", 1]]) }, caps);
  assert.equal(absent.verdict, "incompatible");
  assert.ok(absent.reasons.some((x) => x.code === "api-absent"));
  // só lida (não chamada): limitação, não bloqueio
  const read = classify({ manifest: { ...base, main: "a.js", contributes: { commands: [{ command: "a", title: "A" }] } }, hostPlatform: host, apiScan: scan([["window.algoInexistente", 1], ["commands.registerCommand", 1]], ["commands.registerCommand"]) }, caps);
  assert.equal(read.verdict, "partial");
  const deps = classify({ manifest: { ...base, main: "a.js", extensionDependencies: ["ms-vscode.dep"] }, hostPlatform: host, apiScan: scan([["commands.registerCommand", 1]]) }, caps);
  assert.ok(deps.reasons.some((x) => x.code === "dependencies" && x.severity === "blocker"));
  const depsOk = classify({ manifest: { ...base, main: "a.js", extensionDependencies: ["ms-vscode.dep"], contributes: { commands: [{ command: "a", title: "A" }] } }, hostPlatform: host, apiScan: scan([["commands.registerCommand", 1]]), installedIds: new Set(["ms-vscode.dep"]) }, caps);
  assert.notEqual(depsOk.verdict, "incompatible");
});

test("parcial: propostas, tree views, stubs com outra função", () => {
  const r = classify(
    {
      manifest: { ...base, main: "a.js", enabledApiProposals: ["chatParticipant"], contributes: { commands: [{ command: "a", title: "A" }], views: { explorer: [{ id: "tree", name: "Árvore" }] } } },
      hostPlatform: host,
      apiScan: scan([["commands.registerCommand", 1], ["window.registerTreeDataProvider", 1], ["chat.createChatParticipant", 1]]),
    },
    caps,
  );
  assert.equal(r.verdict, "partial", JSON.stringify(r.reasons));
  for (const code of ["proposed-api", "tree-views", "api-stub", "api-proposed"]) assert.ok(r.reasons.some((x) => x.code === code), code);
});

test("só stubs como função principal (servidor de linguagem): Incompatível", () => {
  const r = classify(
    { manifest: { ...base, main: "a.js", activationEvents: ["onLanguage:python"], contributes: { languages: [{ id: "py" }] } }, hostPlatform: host, apiScan: scan([["languages.registerHoverProvider", 1], ["languages.registerCompletionItemProvider", 1]]) },
    caps,
  );
  assert.equal(r.verdict, "incompatible");
  assert.ok(r.reasons.some((x) => x.code === "activation" && x.severity === "blocker"));
});

test("declarativa: tema só → Compatível (sem código); sem manifesto → Não avaliada", () => {
  const theme = classify({ manifest: { ...base, contributes: { themes: [{ label: "T", path: "t.json" }] } }, hostPlatform: host }, caps);
  assert.equal(theme.verdict, "compatible");
  assert.ok(theme.reasons.some((r) => r.code === "no-code" && /Sem código/.test(r.message)));
  // Engine acima da API do shim não bloqueia quem não tem código.
  const newer = classify({ manifest: { ...base, engines: { vscode: "^9.0.0" }, contributes: { iconThemes: [{ id: "i", label: "I", path: "i.json" }] } }, hostPlatform: host }, caps);
  assert.equal(newer.verdict, "compatible");
  assert.ok(newer.reasons.some((r) => r.code === "engine-no-code"));
  // Mista com código bloqueado: avisa que as contribuições valem mesmo assim.
  const mixed = classify({ manifest: { ...base, engines: { vscode: "^9.0.0" }, main: "a.js", contributes: { themes: [{ label: "T", path: "t.json" }] } }, hostPlatform: host, apiScan: null }, caps);
  assert.equal(mixed.verdict, "incompatible");
  assert.ok(mixed.reasons.some((r) => r.code === "contributions-only"));
  // Keymap/sem nada útil continua Incompatível.
  assert.equal(classify({ manifest: { ...base, contributes: { debuggers: [{}] } }, hostPlatform: host }, caps).verdict, "incompatible");
  assert.equal(classify({ manifest: null, hostPlatform: host }, caps).verdict, "unknown");
  assert.equal(classify({ manifest: { ...base, main: "a.js" }, hostPlatform: host, apiScan: { bindings: 0, paths: [] } }, caps).verdict, "unknown");
});

test("resumo das contribuições", () => {
  const items = summarizeContributions({ ...base, main: "./out/ext.js", contributes: { commands: [{}, {}], configuration: [{ properties: { a: {}, b: {} } }], debuggers: [{}] }, extensionDependencies: ["a.b"] }, caps);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(by.main.state, "code");
  assert.match(by.commands.detail, /^2 itens/);
  assert.match(by.configuration.detail, /^2 itens/);
  assert.equal(by.debuggers.state, "unsupported");
  assert.ok(by.extensionDependencies);
});
