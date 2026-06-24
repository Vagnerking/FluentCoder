// @ts-check
/**
 * b1-full brick 6 design probe — DUMP THE RAW WIRE SHAPE.
 *
 * spike-b1c proved diagnostics/hover/definition come back for the projected
 * `.g.cs`, but only logged {code,msg}. Brick 6's diagnostic routing depends on
 * ONE fact it did NOT capture: does Roslyn's pull-diagnostic report the range in
 *   (a) `.g.cs` coordinates  → broker MUST remap via razorRemapToSource, or
 *   (b) `.cshtml` coordinates (already #line-mapped) → publish directly?
 *
 * This dumps the FULL diagnostic report (incl. any relatedDocuments / per-item
 * uri / relatedInformation), plus the hover range and definition target range,
 * so the routing is built on measured shape, not a guess. Read-only.
 *
 * Run: node tools/razor-lsp-probe/spike-b1d.mjs
 *   The error `Model.NonExistentProperty` is at .g.cs line 161 (1-based),
 *   #line-mapped to Index.cshtml (16,9)-(16,34). So:
 *     range.start.line == 160 (0-based)  → .g.cs coords  → REMAP needed
 *     range.start.line == 15  (0-based)  → .cshtml coords → direct
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
const trPath = join(cap, `spike-b1d-${stamp}.jsonl`);
const tr = createWriteStream(trPath, { flags: "w" });
const log = (dir, payload, note) => { tr.write(JSON.stringify({ t: Date.now(), dir, note, payload }) + "\n"); const m = payload && (payload.method || (payload.id != null ? `#${payload.id}` : "")); console.log(`${dir === "send" ? ">>" : dir === "recv" ? "<<" : "::"} ${m || ""}${note ? " (" + note + ")" : ""}`); };
const dump = (label, obj) => { const s = JSON.stringify(obj, null, 2); console.log(`\n===== ${label} =====\n${s}\n`); tr.write(JSON.stringify({ t: Date.now(), dir: "dump", label, obj }) + "\n"); };
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

  // The `Model.NonExistentProperty` token in the .g.cs (1-based line shown by editors).
  const errPos = posOf("NonExistentProperty");
  dump("ERROR-TOKEN-POSITION-IN-GCS (0-based)", { needle: "NonExistentProperty", pos0: errPos, line1: errPos ? errPos.line + 1 : null });

  let report = null;
  for (let i = 1; i <= 6 && !report; i++) {
    const r = await send("textDocument/diagnostic", { textDocument: { uri: docUri } }).catch((e) => ({ error: String(e) }));
    if (r && r.result && r.result.items && r.result.items.length) { report = r.result; break; }
    log("note", { probe: "doc-diagnostic", attempt: i, count: r && r.result && r.result.items ? r.result.items.length : null, error: r && r.error ? String(r.error).slice(0, 80) : undefined });
    await delay(2500 + i * 1500);
  }
  dump("FULL-DIAGNOSTIC-REPORT (raw result of textDocument/diagnostic)", report);
  if (report && report.items) {
    for (const it of report.items) {
      dump("DIAGNOSTIC-ITEM", { code: it.code, source: it.source, severity: it.severity, message: it.message, range: it.range, relatedInformation: it.relatedInformation });
      const ln = it.range && it.range.start ? it.range.start.line : null;
      dump("ROUTING-VERDICT", {
        rangeStartLine0: ln,
        ifGcsCoords_expect: 160,
        ifCshtmlCoords_expect: 15,
        verdict: ln === 160 ? "GCS-COORDS → broker MUST remap (generated→source)" : ln === 15 ? "CSHTML-COORDS → publish directly (already #line-mapped)" : `UNEXPECTED line ${ln} — inspect`,
      });
    }
  }

  {
    const p = posOf("City", "Model.");
    const r = await send("textDocument/hover", { textDocument: { uri: docUri }, position: p }).catch((e) => ({ error: String(e) }));
    dump("HOVER@Model.City (raw result; note presence/absence of .range)", r && r.result, r && r.error);
  }
  {
    const p = posOf("City", "Model.");
    const r = await send("textDocument/definition", { textDocument: { uri: docUri }, position: p }).catch((e) => ({ error: String(e) }));
    dump("DEFINITION@Model.City (raw result; uri + range of target)", r && r.result, r && r.error);
  }

  await delay(600);
  notify("exit");
  await delay(400); child.kill(); tr.end();
  console.log("\n[spike-b1d] transcript:", trPath);
}
const gt = setTimeout(() => { log("note", { abort: "global timeout" }); child.kill(); tr.end(); process.exit(1); }, 160000);
gt.unref?.();
main().then(() => clearTimeout(gt)).catch((e) => { log("note", { fatal: String(e && e.stack || e) }); child.kill(); tr.end(); process.exit(1); });
