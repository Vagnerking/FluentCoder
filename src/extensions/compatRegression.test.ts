/**
 * Regressão da auditoria 03 (B6–B9): a varredura REAL (api-scan.js, espelho do
 * Rust) + o classificador sobre fixtures minimizados das extensões populares,
 * no formato que os bundles reais têm (webpack, tsc, esbuild minificado).
 *
 * Antes da correção: GitLens/ms-python/ESLint/Vim saíam "Parcial" (veredito
 * EXECUTÁVEL) com 0 APIs vistas; o Git Graph saía "Incompatível" por
 * `"vscode.diff"` numa string; Monokai/Material por identificadores minificados.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { RUNNABLE, classify, type ApiScan, type Capabilities, type CompatibilityReport } from "./compatibility.ts";

const require = createRequire(import.meta.url);
const { scanExtension } = require("../../tools/ext-host/discovery/api-scan.js") as { scanExtension: (dir: string) => ApiScan };
const caps: Capabilities = JSON.parse(fs.readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"));
const FIX = new URL("../../tools/ext-host/test/fixtures/compat/", import.meta.url).pathname;

function run(name: string, installed: string[] = []): { report: CompatibilityReport; scan: ApiScan | null } {
  const dir = path.join(FIX, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const scan = typeof manifest.main === "string" ? scanExtension(dir) : null;
  const report = classify({ manifest, hostPlatform: "linux-x64", apiScan: scan, installedIds: new Set(installed) }, caps);
  return { report, scan };
}
const codes = (r: CompatibilityReport) => r.reasons.map((x) => x.code);
const absentMsg = (r: CompatibilityReport) => r.reasons.find((x) => x.code === "api-absent")?.message ?? "";

test("GitLens (webpack 5): o uso da API é seguido pelo id do módulo — nada de 'Parcial' com 0 APIs", () => {
  const { report, scan } = run("lens");
  assert.ok(scan && scan.paths.length >= 6, JSON.stringify(scan));
  assert.equal(scan!.unresolved, 0);
  assert.ok(scan!.paths.some(([p]) => p === "window.createTreeView"));
  assert.equal(report.verdict, "incompatible");
  assert.match(absentMsg(report), /`Hover`/);
});

test("ms-python (webpack, `s(n(ID))` e `const e=n(ID)` local): Incompatível pelas APIs de LSP/testes/debug", () => {
  const { report, scan } = run("python");
  assert.ok(scan!.paths.some(([p]) => p === "tests.createTestController"));
  assert.ok(scan!.paths.some(([p]) => p === "languages.createLanguageStatusItem"));
  assert.equal(report.verdict, "incompatible");
  assert.match(absentMsg(report), /DebugAdapterExecutable/);
});

test("ESLint (`(0,r.languages.x)(…)`): chamada reconhecida → Incompatível", () => {
  const { report, scan } = run("eslint");
  assert.ok(scan!.called!.includes("languages.registerCodeActionsProvider"));
  assert.equal(report.verdict, "incompatible");
});

test("Vim: sobrescrever o comando `type` é a função principal → bloqueio", () => {
  const { report, scan } = run("vim");
  assert.equal(scan!.typeCommand, true);
  assert.equal(report.verdict, "incompatible");
  assert.ok(report.reasons.some((r) => r.code === "type-command" && r.severity === "blocker"));
});

test("Git Graph: `\"vscode.diff\"`/`'vscode.open'` em strings não são APIs → Compatível", () => {
  const { report, scan } = run("graph");
  assert.ok(!scan!.paths.some(([p]) => p === "diff" || p === "open"), JSON.stringify(scan!.paths));
  assert.equal(report.verdict, "compatible", JSON.stringify(report.reasons));
});

test("Monokai Pro: identificadores minificados ignorados; namespace guardado em `this.M` → Não avaliada (opaco)", () => {
  const { report, scan } = run("monokai");
  assert.ok(scan!.ignored! >= 4);
  assert.ok(!codes(report).includes("api-absent"), JSON.stringify(report.reasons));
  assert.equal(report.verdict, "unknown");
  assert.ok(codes(report).includes("code-opaque"));
  assert.ok(!RUNNABLE.has(report.verdict), "opaco nunca passa no portão");
});

test("Material Icon Theme: `glsl` de outro objeto não vira API ausente", () => {
  const { report, scan } = run("material-icons");
  assert.ok(!scan!.paths.some(([p]) => p === "glsl"));
  assert.ok(!codes(report).includes("api-absent"));
  assert.equal(report.verdict, "partial");
});

test("ErrorLens: `browser` igual ao `main` não tira o bundle da análise", () => {
  const { scan } = run("errorlens");
  assert.ok(scan!.bindings > 0 && scan!.paths.some(([p]) => p === "languages.onDidChangeDiagnostics"));
});

test("keymap puro (jupyter-keymap): atalhos para comandos que não existem aqui → Incompatível", () => {
  const { report } = run("keymap");
  assert.equal(report.verdict, "incompatible");
  assert.ok(codes(report).includes("keymap-only"));
});

test("`require(\"vscode\")` sem ligação rastreável → Não avaliada, mesmo sem nada faltando", () => {
  const { report, scan } = run("unresolved");
  assert.equal(scan!.unresolved, 1);
  assert.equal(report.verdict, "unknown");
  assert.ok(codes(report).includes("code-unresolved"));
});

test("varredura antiga (sem `called`) com bindings e 0 caminhos continua opaca", () => {
  const manifest = { name: "x", publisher: "a", version: "1.0.0", engines: { vscode: "^1.80.0" }, main: "a.js", contributes: { commands: [{ command: "a", title: "A" }] } };
  const r = classify({ manifest, hostPlatform: "linux-x64", apiScan: { bindings: 1, paths: [] } }, caps);
  assert.equal(r.verdict, "unknown");
});
