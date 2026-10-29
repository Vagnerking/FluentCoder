import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import type { Preflight } from "./catalog";
import type { Capabilities } from "./compatibility";
import { classifyPreview } from "./preview.ts";

const caps: Capabilities = JSON.parse(fs.readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"));
const manifest = { name: "x", publisher: "acme", version: "1.0.0", engines: { vscode: "^1.80.0" }, main: "./out/ext.js", activationEvents: ["onStartupFinished"], contributes: { commands: [{ command: "a", title: "A" }] } };
const base: Preflight = { scannerVersion: 2, id: "acme.x", version: "1.0.0", targetPlatform: "universal", manifest, code: "not-requested", apiScan: null, codeError: null, codeGaps: [], savedAt: 1, cached: false };
const scan = { scannerVersion: 2, file: "out/ext.js", filesWithApi: 1, bindings: 1, sites: 1, unresolved: 0, ignored: 0, typeCommand: false, paths: [["commands.registerCommand", 1]] as [string, number][], called: ["commands.registerCommand"], truncated: false, error: null };

test("prévia fase 1 (manifesto): com código ainda é Não avaliada; tema puro já sai decidido", () => {
  assert.equal(classifyPreview(base, "linux-x64", new Set(), caps).verdict, "unknown");
  const theme = { ...base, manifest: { name: "t", publisher: "a", version: "1", engines: { vscode: "^1.80.0" }, contributes: { themes: [{ label: "T", path: "t.json" }] } }, code: "no-main" as const };
  assert.equal(classifyPreview(theme, "linux-x64", new Set(), caps).verdict, "compatible");
});

test("prévia fase 2 (código): veredito com a varredura; incompleta/grande demais não afirmam nada", () => {
  assert.equal(classifyPreview({ ...base, code: "scanned", apiScan: scan }, "linux-x64", new Set(), caps).verdict, "compatible");
  const gap = classifyPreview({ ...base, code: "scanned", apiScan: { ...scan, truncated: true }, codeGaps: ["vscode-languageclient: dependência de node_modules não baixada"] }, "linux-x64", new Set(), caps);
  assert.equal(gap.verdict, "unknown");
  assert.match(gap.reasons.find((r) => r.code === "code-truncated")!.message, /Prévia incompleta.*languageclient/);
  const big = classifyPreview({ ...base, code: "too-large", codeError: "o arquivo principal passa de 8 MB" }, "linux-x64", new Set(), caps);
  assert.equal(big.verdict, "unknown");
  assert.ok(big.reasons.some((r) => r.code === "preview-code" && /grande demais/.test(r.message)));
});
