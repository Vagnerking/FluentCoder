// @ts-check
/**
 * Fase B / Option b1 spike (broker mode) — prove that the PLAIN standalone Roslyn
 * C# LSP gives REAL semantics on the Razor-projected C# (`.g.cs`) when it is
 * compiled in a "shadow" project with the right references, so the b1 broker can
 * remap results to the `.cshtml` via the compiler-emitted `#line` directives.
 *
 * Steps proven here (the b1 success gate):
 *  - open the projected `Index_cshtml.g.cs` (auto-included in Shadow.csproj) as a C# doc;
 *  - textDocument/diagnostic → expect CS1061 (the deliberate @Model.NonExistentProperty);
 *  - hover on `Model.City` → expect it to resolve to WeatherModel.City (real type info);
 *  - definition on `Model.City` → expect a Location into WeatherModel.cs.
 *
 * Usage: node tools/razor-lsp-probe/spike-b1.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const FIX = join(__dirname, "fixtures", "Shadow");
const root = resolve(arg("root", FIX));
const csproj = resolve(arg("csproj", join(FIX, "Shadow.csproj")));
const projected = resolve(arg("doc", join(FIX, "projected", "Index_cshtml.g.cs")));
const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const exe = resolve(arg("server", join(appData, "com.fluentcoder.app", "lsp", "roslyn", "5.0.0-1.25277.114", "content", "LanguageServer", "win-x64", "Microsoft.CodeAnalysis.LanguageServer.exe")));

const cap = join(__dirname, "capture");
mkdirSync(cap, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const trPath = join(cap, `spike-b1-${stamp}.jsonl`);
const tr = createWriteStream(trPath, { flags: "w" });
const log = (dir, payload, note) => { tr.write(JSON.stringify({ t: Date.now(), dir, note, payload }) + "\n"); const m = payload && (payload.method || (payload.id != null ? `#${payload.id}` : "")); console.log(`${dir === "send" ? ">>" : dir === "recv" ? "<<" : "::"} ${m || ""}${note ? " (" + note + ")" : ""}`); };
const toFileUri = (p) => { let n = p.replace(/\\/g, "/"); if (!n.startsWith("/")) n = `/${n}`; return `file://${encodeURI(n)}`; };

const CFG = {
  "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles",
  "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "openFiles",
};
const resolveCfg = (p) => ((p && p.items) || []).map((it) => (it && it.section && it.section in CFG ? CFG[it.section] : null));

if (!existsSync(exe)) { console.error(`standalone Roslyn not found: ${exe}`); process.exit(2); }
if (!existsSync(projected)) { console.error(`projected doc not found: ${projected} (run dotnet build -p:EmitCompilerGeneratedFiles=true on SampleMvc first)`); process.exit(2); }
const logDir = join(cap, "spike-logs"); mkdirSync(logDir, { recursive: true });
const child = spawn(exe, ["--logLevel", "Information", "--extensionLogDirectory", logDir, "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => log("stderr", { text: d.toString().trimEnd() }));

let nextId = 1; const pending = new Map();
const write = (m) => { const b = Buffer.from(JSON.stringify(m), "utf8"); child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); child.stdin.write(b); };
const send = (method, params) => { const id = nextId++; write({ jsonrpc: "2.0", id, method, params }); log("send", { id, method }); return new Promise((r) => pending.set(id, r)); };
const notify = (method, params) => { write({ jsonrpc: "2.0", method, params }); log("send", { method }); };
const respond = (id, result) => { write({ jsonrpc: "2.0", id, result }); };
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

const docText = readFileSync(projected, "utf8");
const docUri = toFileUri(projected);
function posOf(needle, after) {
  let idx = after ? docText.indexOf(needle, docText.indexOf(after)) : docText.indexOf(needle);
  if (idx < 0) return null;
  const before = docText.slice(0, idx);
  return { line: (before.match(/\n/g) || []).length, character: idx - (before.lastIndexOf("\n") + 1) };
}

async function main() {
  await send("initialize", {
    processId: process.pid, rootUri: toFileUri(root),
    capabilities: {
      workspace: { configuration: true, diagnostics: { refreshSupport: true } },
      textDocument: {
        synchronization: { didSave: true },
        diagnostic: { dynamicRegistration: true },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        completion: { completionItem: { snippetSupport: true } },
      },
    },
    workspaceFolders: [{ uri: toFileUri(root), name: "Shadow" }],
  });
  notify("initialized", {});
  notify("workspace/didChangeConfiguration", { settings: {} });
  notify("project/open", { projects: [toFileUri(csproj)] });
  log("note", { waiting: "projectInit" });
  const ok = await Promise.race([projInitP, delay(90000).then(() => false)]);
  log("note", { projectInitializationComplete: ok });
  await delay(2000);

  // open the projected C# doc
  notify("textDocument/didOpen", { textDocument: { uri: docUri, languageId: "csharp", version: 1, text: docText } });
  await delay(3000);

  // 1) document pull diagnostics (retry while compilation settles)
  let diags = null;
  for (let i = 1; i <= 6 && !diags; i++) {
    const r = await send("textDocument/diagnostic", { textDocument: { uri: docUri } }).catch((e) => ({ error: String(e) }));
    const items = r && r.result && r.result.items;
    log("note", { probe: "doc-diagnostic", attempt: i, count: items ? items.length : null, sample: items ? items.slice(0, 3).map((d) => ({ code: d.code, msg: (d.message || "").slice(0, 80), line: d.range && d.range.start.line })) : null, error: r && r.error });
    if (items && items.length) { diags = items; break; }
    await delay(2500 + i * 1500);
  }

  // 2) hover on Model.City
  {
    const cityPos = posOf("City", "Model."); // first "Model." then City
    if (cityPos) {
      const r = await send("textDocument/hover", { textDocument: { uri: docUri }, position: cityPos }).catch((e) => ({ error: String(e) }));
      const md = r && r.result && r.result.contents;
      log("note", { probe: "hover@Model.City", position: cityPos, hover: md ? JSON.stringify(md).slice(0, 200) : null, raw: r && r.result, error: r && r.error });
    } else log("note", { probe: "hover@Model.City", error: "Model.City not found in projected doc" });
  }

  // 3) definition on Model.City
  {
    const cityPos = posOf("City", "Model.");
    if (cityPos) {
      const r = await send("textDocument/definition", { textDocument: { uri: docUri }, position: cityPos }).catch((e) => ({ error: String(e) }));
      const loc = r && r.result;
      const arr = Array.isArray(loc) ? loc : (loc ? [loc] : []);
      log("note", { probe: "definition@Model.City", position: cityPos, targets: arr.map((l) => (l.uri || l.targetUri || "").replace(/.*\//, "")), raw: r && r.result, error: r && r.error });
    }
  }

  await delay(800);
  await send("shutdown", null).catch(() => {}); // shutdown is a REQUEST per LSP
  notify("exit", null);
  await delay(400); child.kill(); tr.end();
  console.log("\n[spike-b1] transcript:", trPath);
}

const gt = setTimeout(() => { log("note", { abort: "global timeout" }); child.kill(); tr.end(); process.exit(1); }, 150000);
gt.unref?.();
main().then(() => clearTimeout(gt)).catch((e) => { log("note", { fatal: String(e && e.stack || e) }); child.kill(); tr.end(); process.exit(1); });
