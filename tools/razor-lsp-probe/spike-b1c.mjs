// @ts-check
/**
 * b1-full brick 2 validation — generalized shadow in a Roslyn WORKSPACE.
 *
 * Loads a 2-project solution (the user's SampleMvc + a plain-SDK ShadowRef that
 * ProjectReferences it and compiles the projected `.g.cs`) into the standalone
 * Roslyn C# LSP via `solution/open`, then opens the projected doc and proves
 * REAL semantics — diagnostics + hover + definition — even though the user
 * project itself has a deliberate error (workspace tolerates it; unlike
 * `dotnet build`, which would block on the dependency error).
 *
 * This validates the broker's actual shape: shadow ProjectReference + workspace.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FIX = join(__dirname, "fixtures");
const root = resolve(arg("root", FIX));
const sln = resolve(arg("sln", join(FIX, "TwoProj.sln")));
const doc = resolve(arg("doc", join(FIX, "ShadowRef", "projected", "Index_cshtml.g.cs")));
const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const exe = resolve(arg("server", join(appData, "com.fluentcoder.app", "lsp", "roslyn", "5.0.0-1.25277.114", "content", "LanguageServer", "win-x64", "Microsoft.CodeAnalysis.LanguageServer.exe")));

const cap = join(__dirname, "capture"); mkdirSync(cap, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const trPath = join(cap, `spike-b1c-${stamp}.jsonl`);
const tr = createWriteStream(trPath, { flags: "w" });
const log = (dir, payload, note) => { tr.write(JSON.stringify({ t: Date.now(), dir, note, payload }) + "\n"); const m = payload && (payload.method || (payload.id != null ? `#${payload.id}` : "")); console.log(`${dir === "send" ? ">>" : dir === "recv" ? "<<" : "::"} ${m || ""}${note ? " (" + note + ")" : ""}`); };
const toFileUri = (p) => { let n = p.replace(/\\/g, "/"); if (!n.startsWith("/")) n = `/${n}`; return `file://${encodeURI(n)}`; };
const CFG = { "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles", "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "openFiles" };
const resolveCfg = (p) => ((p && p.items) || []).map((it) => (it && it.section && it.section in CFG ? CFG[it.section] : null));

if (!existsSync(exe)) { console.error(`server not found: ${exe}`); process.exit(2); }
if (!existsSync(doc)) { console.error(`projected doc missing: ${doc}`); process.exit(2); }
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

const docText = readFileSync(doc, "utf8");
const docUri = toFileUri(doc);
function posOf(needle, after) { let i = after ? docText.indexOf(needle, docText.indexOf(after)) : docText.indexOf(needle); if (i < 0) return null; const b = docText.slice(0, i); return { line: (b.match(/\n/g) || []).length, character: i - (b.lastIndexOf("\n") + 1) }; }

async function main() {
  await send("initialize", {
    processId: process.pid, rootUri: toFileUri(root),
    capabilities: { workspace: { configuration: true }, textDocument: { synchronization: {}, diagnostic: { dynamicRegistration: true }, hover: { contentFormat: ["markdown", "plaintext"] }, definition: { linkSupport: true } } },
    workspaceFolders: [{ uri: toFileUri(root), name: "fixtures" }],
  });
  notify("initialized", {});
  notify("workspace/didChangeConfiguration", { settings: {} });
  notify("solution/open", { solution: toFileUri(sln) });
  const ok = await Promise.race([projInitP, delay(120000).then(() => false)]);
  log("note", { projectInitializationComplete: ok });
  await delay(3000);
  notify("textDocument/didOpen", { textDocument: { uri: docUri, languageId: "csharp", version: 1, text: docText } });
  await delay(3000);

  let diags = null;
  for (let i = 1; i <= 6 && !diags; i++) {
    const r = await send("textDocument/diagnostic", { textDocument: { uri: docUri } }).catch((e) => ({ error: String(e) }));
    const items = r && r.result && r.result.items;
    log("note", { probe: "doc-diagnostic", attempt: i, count: items ? items.length : null, sample: items ? items.slice(0, 3).map((d) => ({ code: d.code, msg: (d.message || "").slice(0, 70) })) : null, error: r && r.error ? String(r.error).slice(0, 80) : undefined });
    if (items && items.length) { diags = items; break; }
    await delay(2500 + i * 1500);
  }
  {
    const p = posOf("City", "Model.");
    if (p) { const r = await send("textDocument/hover", { textDocument: { uri: docUri }, position: p }).catch((e) => ({ error: String(e) })); const md = r && r.result && r.result.contents; log("note", { probe: "hover@Model.City", hover: md ? JSON.stringify(md).slice(0, 180) : null, error: r && r.error }); }
  }
  {
    const p = posOf("City", "Model.");
    if (p) { const r = await send("textDocument/definition", { textDocument: { uri: docUri }, position: p }).catch((e) => ({ error: String(e) })); const loc = r && r.result; const arr = Array.isArray(loc) ? loc : (loc ? [loc] : []); log("note", { probe: "definition@Model.City", targets: arr.map((l) => (l.uri || l.targetUri || "").replace(/.*\//, "")), error: r && r.error }); }
  }
  await delay(600);
  notify("exit"); // skip shutdown(null) — Roslyn crashes on null params; just exit+kill
  await delay(400); child.kill(); tr.end();
  console.log("\n[spike-b1c] transcript:", trPath);
}
const gt = setTimeout(() => { log("note", { abort: "global timeout" }); child.kill(); tr.end(); process.exit(1); }, 160000);
gt.unref?.();
main().then(() => clearTimeout(gt)).catch((e) => { log("note", { fatal: String(e && e.stack || e) }); child.kill(); tr.end(); process.exit(1); });
