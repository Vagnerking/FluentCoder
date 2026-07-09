// @ts-check
/**
 * Aceite: quick fix (lâmpada Ctrl+.) CROSS-CAMADA num projeto estilo DDD.
 *
 * Responde a duas perguntas com o Roslyn standalone real (o mesmo do app),
 * abrindo a solução DddSample (Domain + Application + Infra) via project/open:
 *
 *   CENÁRIO 1 — "add using": Application JÁ referencia Domain, mas ClienteService.cs
 *   usa `Cliente` (de Ddd.Domain.Entities) SEM o using. A lâmpada deve oferecer
 *   "using Ddd.Domain.Entities;" (add-using cross-camada).
 *
 *   CENÁRIO 2 — "add project reference": UsaInfra.cs usa `RepositorioSql` (de
 *   Infra), e Application NÃO referencia o projeto Infra. O C# Dev Kit ofereceria
 *   "Add project reference to 'Infra'". Este probe mostra se o Roslyn STANDALONE
 *   oferece isso ou não (esperado: NÃO — é feature do componente de projeto do
 *   Dev Kit, ausente no standalone).
 *
 * Saída: os títulos das code actions oferecidas em cada posição de erro.
 * Uso: node tools/razor-lsp-probe/probe-csharp-crosslayer.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures", "DddSample");
const root = resolve(FIX);
const projects = [
  join(FIX, "Domain", "Domain.csproj"),
  join(FIX, "Application", "Application.csproj"),
  join(FIX, "Infra", "Infra.csproj"),
];
const clienteService = join(FIX, "Application", "ClienteService.cs");
const usaInfra = join(FIX, "Application", "UsaInfra.cs");

const VERSION = "5.0.0-1.25277.114";
function defaultServer() {
  const rid = process.platform === "darwin" ? (process.arch === "arm64" ? "osx-arm64" : "osx-x64")
    : process.platform === "win32" ? "win-x64"
    : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
  const base = process.platform === "darwin" ? join(process.env.HOME || "", "Library", "Application Support")
    : process.platform === "win32" ? (process.env.APPDATA || "")
    : (process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local", "share"));
  const exe = process.platform === "win32" ? "Microsoft.CodeAnalysis.LanguageServer.exe" : "Microsoft.CodeAnalysis.LanguageServer";
  return join(base, "com.fluentcoder.app", "lsp", "roslyn", VERSION, "content", "LanguageServer", rid, exe);
}
const exe = resolve((() => { const i = process.argv.indexOf("--server"); return i >= 0 ? process.argv[i + 1] : defaultServer(); })());

const toFileUri = (p) => { let n = p.replace(/\\/g, "/"); if (!n.startsWith("/")) n = `/${n}`; return `file://${encodeURI(n)}`; };
const CFG = {
  "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles",
  "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "openFiles",
  "csharp|completion.dotnet_show_completion_items_from_unimported_namespaces": true,
};
const resolveCfg = (p) => ((p && p.items) || []).map((it) => (it && it.section && it.section in CFG ? CFG[it.section] : null));

if (!existsSync(exe)) { console.error(`Roslyn não encontrado: ${exe}`); process.exit(2); }

const logDir = mkdtempSync(join(tmpdir(), "fluent-xlayer-"));
const child = spawn(exe, ["--logLevel", "Warning", "--extensionLogDirectory", logDir, "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => { const s = d.toString().trimEnd(); if (s) process.stderr.write(`[server] ${s}\n`); });

let nextId = 1; const pending = new Map();
const write = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); child.stdin.write(b); };
const send = (method, params) => { const id = nextId++; write(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }); return new Promise((r) => pending.set(id, r)); };
const notify = (method, params) => write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let projInit; const projInitP = new Promise((r) => (projInit = r));
let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n"); if (he < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString()); if (!m) { buf = buf.slice(he + 4); continue; }
    const len = +m[1], start = he + 4; if (buf.length < start + len) return;
    const body = buf.slice(start, start + len).toString("utf8"); buf = buf.slice(start + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.id != null && !msg.method && (msg.result !== undefined || msg.error !== undefined)) { const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); } continue; }
    if (msg.method) {
      if (msg.method === "workspace/projectInitializationComplete") projInit(true);
      if (msg.method === "workspace/configuration") respond(msg.id, resolveCfg(msg.params));
      else if (msg.id != null) respond(msg.id, null);
    }
  }
});

function posOf(text, needle) { const idx = text.indexOf(needle); if (idx < 0) return null; const b = text.slice(0, idx); return { line: (b.match(/\n/g) || []).length, character: idx - (b.lastIndexOf("\n") + 1) }; }

async function openAndPullDiags(uri, text) {
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "csharp", version: 1, text } });
  await delay(1500);
  let items = [];
  for (let i = 1; i <= 6; i++) {
    const r = await send("textDocument/diagnostic", { textDocument: { uri } }).catch(() => null);
    items = (r && r.result && r.result.items) || [];
    if (items.length) break;
    await delay(2000 + i * 1000);
  }
  return items;
}

async function codeActionsAt(uri, text, needle, diags) {
  const pos = posOf(text, needle);
  if (!pos) return { error: `'${needle}' não encontrado` };
  const wordRange = { start: pos, end: { line: pos.line, character: pos.character + needle.length } };
  // Diagnóstico que cobre a posição (a lâmpada de "add using" precisa do diag no contexto).
  const ctxDiags = (diags || []).filter((d) => d.range && d.range.start.line === pos.line);
  const r = await send("textDocument/codeAction", {
    textDocument: { uri },
    range: wordRange,
    context: { diagnostics: ctxDiags, only: undefined },
  }).catch((e) => ({ error: String(e) }));
  if (r && r.error) return { error: JSON.stringify(r.error).slice(0, 120) };
  const actions = Array.isArray(r && r.result) ? r.result : [];
  return { titles: actions.map((a) => a.title || (a.command && a.command.title) || "?") };
}

async function main() {
  await send("initialize", {
    processId: process.pid, rootUri: toFileUri(root),
    capabilities: {
      workspace: { configuration: true },
      textDocument: {
        synchronization: { didSave: true },
        diagnostic: { dynamicRegistration: true },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source"] } }, resolveSupport: { properties: ["edit"] } },
      },
    },
    workspaceFolders: [{ uri: toFileUri(root), name: "DddSample" }],
  });
  notify("initialized", {});
  notify("workspace/didChangeConfiguration", { settings: {} });
  notify("project/open", { projects: projects.map(toFileUri) });
  const ok = await Promise.race([projInitP, delay(90000).then(() => false)]);
  console.log(`projectInitializationComplete: ${ok ? "OK" : "TIMEOUT"}`);
  if (!ok) { child.kill(); process.exit(1); }
  await delay(2000);

  // CENÁRIO 1 — add using (Domain já referenciado).
  const csText = readFileSync(clienteService, "utf8");
  const csUri = toFileUri(clienteService);
  const d1 = await openAndPullDiags(csUri, csText);
  console.log(`\n[Cenário 1] ClienteService.cs — diags: ${d1.map((d) => d.code).join(",") || "nenhum"}`);
  const a1 = await codeActionsAt(csUri, csText, "Cliente cliente", d1);
  console.log(`[Cenário 1] code actions em 'Cliente':`);
  (a1.titles || [a1.error]).forEach((t) => console.log(`   • ${t}`));
  const addUsingOk = (a1.titles || []).some((t) => /using .*Domain/i.test(t) || /Ddd\.Domain/i.test(t));
  console.log(`   → add-using cross-camada: ${addUsingOk ? "SIM ✅" : "NÃO ❌"}`);

  // CENÁRIO 2 — add project reference (Infra NÃO referenciado).
  const uiText = readFileSync(usaInfra, "utf8");
  const uiUri = toFileUri(usaInfra);
  const d2 = await openAndPullDiags(uiUri, uiText);
  console.log(`\n[Cenário 2] UsaInfra.cs — diags: ${d2.map((d) => d.code).join(",") || "nenhum"}`);
  const a2 = await codeActionsAt(uiUri, uiText, "RepositorioSql repo", d2);
  console.log(`[Cenário 2] code actions em 'RepositorioSql':`);
  (a2.titles || [a2.error]).forEach((t) => console.log(`   • ${t}`));
  const addRefOk = (a2.titles || []).some((t) => /add .*reference|refer.ncia|adicionar refer/i.test(t));
  const addUsingInfra = (a2.titles || []).some((t) => /using .*Infra/i.test(t));
  console.log(`   → add-project-reference: ${addRefOk ? "SIM ✅" : "NÃO ❌ (esperado no standalone)"}`);
  console.log(`   → oferece só add-using (se o assembly já estiver no workspace): ${addUsingInfra ? "SIM" : "NÃO"}`);

  await delay(500);
  await send("shutdown").catch(() => {});
  notify("exit");
}

const gt = setTimeout(() => { console.error("[probe] timeout"); child.kill(); process.exit(1); }, 150000);
gt.unref?.();
main().then(async () => { clearTimeout(gt); await delay(300); child.kill(); process.exit(0); }).catch((e) => { console.error("fatal:", e && e.stack || e); child.kill(); process.exit(1); });
