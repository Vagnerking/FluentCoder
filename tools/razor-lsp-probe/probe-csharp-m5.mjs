// @ts-check
/**
 * Aceite headless da milestone #5 (paridade C# Dev Kit — language service `.cs`).
 *
 * Sobe o MESMO Roslyn standalone que o app usa (o binário em cache), abre o
 * projeto real `SampleMvc` e prova que as features novas da #5 são ANUNCIADAS na
 * `initialize` E RESPONDEM de fato num `.cs` real:
 *   - inlayHintProvider        → `textDocument/inlayHint` retorna hints;
 *   - implementationProvider   → `textDocument/implementation` responde;
 *   - typeDefinitionProvider   → `textDocument/typeDefinition` acha WeatherModel;
 *   - workspaceSymbolProvider  → `workspace/symbol "WeatherModel"` acha o tipo.
 *
 * Porquê um probe e não E2E: `tauri-driver` NÃO é suportado no macOS
 * ("tauri-driver is not supported on this platform"), então a suíte WebDriver só
 * roda no Windows. Este probe valida o NÚCLEO da #5 (o servidor + o wire das
 * features) de forma determinística e sem GUI, no macOS/CI. O aceite visual (a
 * renderização dos hints/lens no Monaco) continua sendo o gate do Windows E2E.
 *
 * Uso: node tools/razor-lsp-probe/probe-csharp-m5.mjs
 * Saída: linhas PASS/FAIL por feature e exit code 0 (tudo passou) ou 1.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const FIX = join(__dirname, "fixtures", "SampleMvc");
const root = resolve(arg("root", FIX));
const csproj = resolve(arg("csproj", join(FIX, "SampleMvc.csproj")));
const targetCs = resolve(arg("doc", join(FIX, "Controllers", "HomeController.cs")));

// The app caches Roslyn under the platform app-data dir; resolve the per-OS
// binary. Overridable with --server for CI images that stage it elsewhere.
const VERSION = "5.0.0-1.25277.114";
function defaultServer() {
  const plat = process.platform;
  if (plat === "win32") {
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
    return join(appData, "com.fluentcoder.app", "lsp", "roslyn", VERSION, "content", "LanguageServer", "win-x64", "Microsoft.CodeAnalysis.LanguageServer.exe");
  }
  const rid = plat === "darwin"
    ? (process.arch === "arm64" ? "osx-arm64" : "osx-x64")
    : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
  const base = plat === "darwin"
    ? join(process.env.HOME || "", "Library", "Application Support")
    : join(process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local", "share"));
  return join(base, "com.fluentcoder.app", "lsp", "roslyn", VERSION, "content", "LanguageServer", rid, "Microsoft.CodeAnalysis.LanguageServer");
}
const exe = resolve(arg("server", defaultServer()));

const toFileUri = (p) => { let n = p.replace(/\\/g, "/"); if (!n.startsWith("/")) n = `/${n}`; return `file://${encodeURI(n)}`; };

// Mirror the app's config pull (openFiles scope + inlay hints ON, so the server
// actually emits hints for the probe — the toggle default is OFF in the app).
const CFG = {
  "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles",
  "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "openFiles",
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_types": true,
  "csharp|inlay_hints.csharp_enable_inlay_hints_for_implicit_variable_types": true,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_parameters": true,
  "csharp|inlay_hints.dotnet_enable_inlay_hints_for_other_parameters": true,
};
const resolveCfg = (p) => ((p && p.items) || []).map((it) => (it && it.section && it.section in CFG ? CFG[it.section] : null));

if (!existsSync(exe)) { console.error(`Roslyn standalone não encontrado: ${exe}\nAbra um projeto C# no app uma vez para baixá-lo, ou passe --server.`); process.exit(2); }
if (!existsSync(targetCs)) { console.error(`arquivo alvo não encontrado: ${targetCs}`); process.exit(2); }

const logDir = mkdtempSync(join(tmpdir(), "fluent-m5-probe-"));
const child = spawn(exe, ["--logLevel", "Warning", "--extensionLogDirectory", logDir, "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => { const s = d.toString().trimEnd(); if (s) process.stderr.write(`[server] ${s}\n`); });

let nextId = 1; const pending = new Map();
const write = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); child.stdin.write(b); };
// Omit `params` entirely when undefined — the Roslyn JSON-RPC layer throws
// "Unexpected value kind: Null" if a request/notification carries params:null.
const send = (method, params) => { const id = nextId++; write(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }); return new Promise((r) => pending.set(id, r)); };
const notify = (method, params) => write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let projInit; const projInitP = new Promise((r) => (projInit = r));
let serverCaps = null;
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

const docText = readFileSync(targetCs, "utf8");
const docUri = toFileUri(targetCs);
function posOf(needle, after) {
  const from = after ? docText.indexOf(after) : 0;
  const idx = docText.indexOf(needle, from < 0 ? 0 : from);
  if (idx < 0) return null;
  const before = docText.slice(0, idx);
  return { line: (before.match(/\n/g) || []).length, character: idx - (before.lastIndexOf("\n") + 1) };
}

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
const hasCap = (k) => serverCaps && serverCaps[k] != null && serverCaps[k] !== false;

async function main() {
  const init = await send("initialize", {
    processId: process.pid, rootUri: toFileUri(root),
    capabilities: {
      workspace: { configuration: true, symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } } },
      textDocument: {
        synchronization: { didSave: true },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        typeDefinition: { linkSupport: true },
        implementation: { linkSupport: true },
        inlayHint: { dynamicRegistration: true },
      },
    },
    workspaceFolders: [{ uri: toFileUri(root), name: "SampleMvc" }],
  });
  serverCaps = init && init.result && init.result.capabilities;

  // 1) Capabilities anunciadas.
  record("capability: inlayHintProvider", hasCap("inlayHintProvider"));
  record("capability: implementationProvider", hasCap("implementationProvider"));
  record("capability: typeDefinitionProvider", hasCap("typeDefinitionProvider"));
  record("capability: workspaceSymbolProvider", hasCap("workspaceSymbolProvider"));

  notify("initialized", {});
  notify("workspace/didChangeConfiguration", { settings: {} });
  notify("solution/open", { solution: toFileUri(join(root, "SampleMvc.csproj")) });
  // solution/open expects a .sln; SampleMvc has none, so open the project.
  notify("project/open", { projects: [toFileUri(csproj)] });
  const ok = await Promise.race([projInitP, delay(90000).then(() => false)]);
  if (!ok) { record("projectInitializationComplete", false, "timeout 90s"); return; }
  record("projectInitializationComplete", true);
  await delay(1500);

  notify("textDocument/didOpen", { textDocument: { uri: docUri, languageId: "csharp", version: 1, text: docText } });
  await delay(2500);

  // 2) workspace/symbol "WeatherModel" acha o tipo no arquivo real.
  {
    let hit = null;
    for (let i = 1; i <= 5 && !hit; i++) {
      const r = await send("workspace/symbol", { query: "WeatherModel" }).catch((e) => ({ error: String(e) }));
      const arr = Array.isArray(r && r.result) ? r.result : [];
      hit = arr.find((s) => s.name === "WeatherModel");
      if (!hit) await delay(1500 + i * 1000);
    }
    const uri = hit && hit.location && hit.location.uri;
    record("workspace/symbol → WeatherModel", !!hit, uri ? uri.replace(/.*\//, "") : "não encontrado");
  }

  // 3) typeDefinition sobre `model` (var model = new WeatherModel{...}) → WeatherModel.cs.
  {
    const pos = posOf("model", "var ");
    const r = pos ? await send("textDocument/typeDefinition", { textDocument: { uri: docUri }, position: pos }).catch((e) => ({ error: String(e) })) : null;
    const loc = r && r.result;
    const arr = Array.isArray(loc) ? loc : (loc ? [loc] : []);
    const targets = arr.map((l) => (l.uri || l.targetUri || "").replace(/.*\//, ""));
    record("textDocument/typeDefinition @model", targets.some((t) => /WeatherModel\.cs/i.test(t)), targets.join(",") || "vazio");
  }

  // 4) implementation sobre `IActionResult` (interface) → responde sem erro (pode
  //    ser lista vazia se não houver impl no source; o que importa é o endpoint
  //    responder, provando o provider ativo).
  {
    const pos = posOf("IActionResult");
    const r = pos ? await send("textDocument/implementation", { textDocument: { uri: docUri }, position: pos }).catch((e) => ({ error: String(e) })) : null;
    const responded = r && !r.error && r.result !== undefined;
    const arr = Array.isArray(r && r.result) ? r.result : (r && r.result ? [r.result] : []);
    record("textDocument/implementation @IActionResult", !!responded, `${arr.length} alvo(s)`);
  }

  // 5) inlayHint no range do documento → retorna ao menos 1 hint (tipos/params).
  //    O range precisa ser VÁLIDO (dentro do doc): última linha 0-based e sua
  //    largura real; um End além do fim faz o Roslyn responder -32000.
  {
    const lines = docText.split("\n");
    const lastLine = lines.length - 1;
    const r = await send("textDocument/inlayHint", {
      textDocument: { uri: docUri },
      range: { start: { line: 0, character: 0 }, end: { line: lastLine, character: lines[lastLine].length } },
    }).catch((e) => ({ error: String(e) }));
    const arr = Array.isArray(r && r.result) ? r.result : [];
    record("textDocument/inlayHint", arr.length > 0, `${arr.length} hint(s)` + (r && r.error ? ` erro: ${JSON.stringify(r.error).slice(0, 80)}` : ""));
  }

  await delay(500);
  await send("shutdown").catch(() => {});
  notify("exit");
}

const gt = setTimeout(() => { console.error("[probe] timeout global"); child.kill(); process.exit(1); }, 150000);
gt.unref?.();
main()
  .then(async () => {
    clearTimeout(gt);
    await delay(300); child.kill();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passaram.`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch((e) => { console.error("[probe] fatal:", e && e.stack || e); child.kill(); process.exit(1); });
