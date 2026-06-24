// @ts-check
/**
 * Fase B1 ARCH spike (option b) — can we reuse the standalone Roslyn's OWN
 * source-generated `.cshtml.g.cs` (it already runs the Razor SDK generator when
 * it loads the user project), instead of building a separate shadow pipeline?
 *
 * If Roslyn exposes the generated document queryably, b1-full shrinks a lot:
 * route .cshtml requests to the generated doc, let Roslyn remap via #line.
 *
 * Test: load the REAL SampleMvc project, find the generated class
 * `Views_Home_Index` via workspace/symbol, inspect the URI scheme, then try to
 * open/query it (hover) — does Roslyn serve source-generated docs over LSP?
 *
 * Hard global timeout so it can't hang like workspace/diagnostic did.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FIX = join(__dirname, "fixtures", "SampleMvc");
const root = resolve(arg("root", FIX));
const csproj = resolve(arg("csproj", join(FIX, "SampleMvc.csproj")));
const sln = join(FIX, "SampleMvc.sln");
const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const exe = resolve(arg("server", join(appData, "com.fluentcoder.app", "lsp", "roslyn", "5.0.0-1.25277.114", "content", "LanguageServer", "win-x64", "Microsoft.CodeAnalysis.LanguageServer.exe")));

const cap = join(__dirname, "capture"); mkdirSync(cap, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const trPath = join(cap, `spike-b1b-${stamp}.jsonl`);
const tr = createWriteStream(trPath, { flags: "w" });
const log = (dir, payload, note) => { tr.write(JSON.stringify({ t: Date.now(), dir, note, payload }) + "\n"); const m = payload && (payload.method || (payload.id != null ? `#${payload.id}` : "")); console.log(`${dir === "send" ? ">>" : dir === "recv" ? "<<" : "::"} ${m || ""}${note ? " (" + note + ")" : ""}`); };
const toFileUri = (p) => { let n = p.replace(/\\/g, "/"); if (!n.startsWith("/")) n = `/${n}`; return `file://${encodeURI(n)}`; };
const CFG = { "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "fullSolution", "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "fullSolution" };
const resolveCfg = (p) => ((p && p.items) || []).map((it) => (it && it.section && it.section in CFG ? CFG[it.section] : null));

if (!existsSync(exe)) { console.error(`server not found: ${exe}`); process.exit(2); }
const logDir = join(cap, "spike-logs"); mkdirSync(logDir, { recursive: true });
const child = spawn(exe, ["--logLevel", "Information", "--extensionLogDirectory", logDir, "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => log("stderr", { text: d.toString().trimEnd() }));
let nextId = 1; const pending = new Map();
const write = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); child.stdin.write(b); };
const send = (method, params) => { const id = nextId++; write({ jsonrpc: "2.0", id, method, params }); log("send", { id, method }); return new Promise((r) => pending.set(id, r)); };
const notify = (method, params) => { write({ jsonrpc: "2.0", method, params }); log("send", { method }); };
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
    if (msg.method) { if (msg.method === "workspace/projectInitializationComplete") projInit(true); if (msg.method === "workspace/configuration") respond(msg.id, resolveCfg(msg.params)); else if (msg.id != null) respond(msg.id, null); }
  }
});

async function main() {
  await send("initialize", {
    processId: process.pid, rootUri: toFileUri(root),
    capabilities: { workspace: { configuration: true, symbol: {} }, textDocument: { hover: {}, definition: {} } },
    workspaceFolders: [{ uri: toFileUri(root), name: "SampleMvc" }],
  });
  notify("initialized", {});
  notify("workspace/didChangeConfiguration", { settings: {} });
  notify(existsSync(sln) ? "solution/open" : "project/open", existsSync(sln) ? { solution: toFileUri(sln) } : { projects: [toFileUri(csproj)] });
  const ok = await Promise.race([projInitP, delay(90000).then(() => false)]);
  log("note", { projectInitializationComplete: ok });
  await delay(4000);

  // Find the generated Razor class via workspace symbol search.
  for (const q of ["Views_Home_Index", "Index", "WeatherModel"]) {
    const r = await send("workspace/symbol", { query: q }).catch((e) => ({ error: String(e) }));
    const syms = (r && r.result) || [];
    const mapped = syms.map((s) => ({ name: s.name, kind: s.kind, uri: (s.location && s.location.uri) || (s.location && s.location.range && "?") }));
    log("note", { probe: "workspace/symbol", query: q, count: syms.length, uris: [...new Set(mapped.map((m) => (m.uri || "").replace(/^(file|[a-z-]+):/i, "$1:").slice(0, 90)))].slice(0, 8), sample: mapped.slice(0, 6) });
  }

  // If any symbol points at a source-generated doc, try to open+hover it.
  // (We log the raw uris above; opening is attempted only if a non-file scheme appears.)
  await delay(500);
  await send("shutdown", null).catch(() => {}); notify("exit", null);
  await delay(400); child.kill(); tr.end();
  console.log("\n[spike-b1b] transcript:", trPath);
}
const gt = setTimeout(() => { log("note", { abort: "global timeout" }); child.kill(); tr.end(); process.exit(1); }, 130000);
gt.unref?.();
main().then(() => clearTimeout(gt)).catch((e) => { log("note", { fatal: String(e && e.stack || e) }); child.kill(); tr.end(); process.exit(1); });
