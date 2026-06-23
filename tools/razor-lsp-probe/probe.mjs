// @ts-check
/**
 * Fase 0 — Headless Razor/CSHTML LSP capture probe (gate bloqueante).
 *
 * Drives the SAME Roslyn cohosting server the app launches (the C# extension
 * VSIX's `Microsoft.CodeAnalysis.LanguageServer` + `RazorExtension.dll`),
 * directly over stdio LSP — no Tauri/Monaco/UI. It opens a real ASP.NET Core
 * `.cshtml`, exercises the semantic features, and records EVERY JSON-RPC message
 * (both directions) so we can answer, with evidence:
 *
 *   - which capabilities the cohost advertises;
 *   - whether `solution/open`/`project/open` reaches `projectInitializationComplete`;
 *   - by which identifier/mechanism C# diagnostics for Razor are delivered
 *     (the documented `DocumentCompilerSemantic` -> items:[] gap);
 *   - whether semanticTokens/hover/definition/completion return real data;
 *   - which `razor/*` (HTML delegation / dynamic file) requests the server sends
 *     to the client (the contract input for Fase C).
 *
 * Output: a JSONL transcript + a human-readable summary under ./capture/.
 *
 * Usage (PowerShell):
 *   node tools/razor-lsp-probe/probe.mjs
 *   node tools/razor-lsp-probe/probe.mjs --root <projDir> --cshtml <file.cshtml>
 *
 * No npm dependencies. Pure Node (>=18).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- args ------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FIXTURE = join(__dirname, "fixtures", "SampleMvc");
const root = resolve(arg("root", FIXTURE));
const csproj = resolve(arg("csproj", join(FIXTURE, "SampleMvc.csproj")));
const cshtml = resolve(arg("cshtml", join(FIXTURE, "Views", "Home", "Index.cshtml")));
const languageId = arg("lang", "aspnetcorerazor");
const initTimeoutMs = Number(arg("initTimeout", "120000"));

const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
const roslynDir = resolve(
  arg("roslyn", join(appData, "com.fluentcoder.app", "lsp", "csharp-ext", "2.144.9", "extension", ".roslyn"))
);

const captureDir = join(__dirname, "capture");
mkdirSync(captureDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const transcriptPath = join(captureDir, `transcript-${stamp}.jsonl`);
const summaryPath = join(captureDir, `summary-${stamp}.md`);
const transcript = createWriteStream(transcriptPath, { flags: "w" });

// ---- uri helper (mirrors src/lsp/uri.ts: file:///c:/foo, unescaped colon) ---
function toFileUri(p) {
  let n = p.replace(/\\/g, "/");
  if (!n.startsWith("/")) n = `/${n}`;
  // encodeURI keeps / and : intact while escaping spaces, etc.
  return `file://${encodeURI(n)}`;
}

// Mirror the app's diagnostic-gating workspace/configuration answers
// (src/lsp/servers/csharpConfiguration.ts). This includes the load-bearing
// values (analyzer/compiler diagnostics scope = "openFiles") that, if left null,
// make Roslyn fall back to scope:"none" and report nothing — a probe false
// negative. Inlay-hint defaults are intentionally omitted (they don't gate
// diagnostics/generators). Keep the gating values in sync with the app.
const CSHARP_CONFIGURATION = {
  "csharp|background_analysis.dotnet_analyzer_diagnostics_scope": "openFiles",
  "csharp|background_analysis.dotnet_compiler_diagnostics_scope": "openFiles",
  "csharp|diagnostics.dotnet_report_information_as_hint": true,
  "csharp|completion.dotnet_provide_regex_completions": true,
  "csharp|completion.dotnet_show_completion_items_from_unimported_namespaces": true,
  "csharp|completion.dotnet_show_name_completion_suggestions": true,
  "csharp|completion.dotnet_trigger_completion_in_argument_lists": true,
  "csharp|symbol_search.dotnet_search_reference_assemblies": true,
  "csharp|code_lens.dotnet_enable_references_code_lens": true,
  "csharp|code_lens.dotnet_enable_tests_code_lens": true,
  "csharp|implement_type.dotnet_insertion_behavior": "with_other_members_of_the_same_kind",
  "csharp|implement_type.dotnet_property_generation_behavior": "prefer_throwing_properties",
};
function resolveConfig(params) {
  const items = (params && params.items) || [];
  return items.map((it) =>
    it && it.section && Object.prototype.hasOwnProperty.call(CSHARP_CONFIGURATION, it.section)
      ? CSHARP_CONFIGURATION[it.section]
      : null
  );
}

// ---- transcript logging ----------------------------------------------------
const events = [];
function log(dir, payload, note) {
  const entry = { t: Date.now(), dir, note, payload };
  events.push(entry);
  transcript.write(JSON.stringify(entry) + "\n");
  const m = payload && (payload.method || (payload.id != null ? `#${payload.id}` : ""));
  const tag = dir === "send" ? ">>" : dir === "recv" ? "<<" : "::";
  console.log(`${tag} ${m || ""}${note ? "  (" + note + ")" : ""}`);
}

// ---- LSP transport ---------------------------------------------------------
if (!existsSync(join(roslynDir, "Microsoft.CodeAnalysis.LanguageServer.exe"))) {
  console.error(`[probe] cohost server not found at:\n  ${roslynDir}\nPass --roslyn <dir> to override.`);
  process.exit(2);
}
const exe = join(roslynDir, "Microsoft.CodeAnalysis.LanguageServer.exe");
const razorExt = join(roslynDir, "Microsoft.VisualStudioCode.RazorExtension.dll");
const csharpDesignTime = join(roslynDir, "Targets", "Microsoft.CSharpExtension.DesignTime.targets");
const logDir = join(captureDir, "server-logs");
mkdirSync(logDir, { recursive: true });

const args = [
  "--logLevel", "Information",
  "--extensionLogDirectory", logDir,
  "--stdio",
  "--extension", razorExt,
];
if (existsSync(csharpDesignTime)) {
  args.push("--csharpDesignTimePath", csharpDesignTime);
}

console.log(`[probe] launching cohost:\n  ${exe}\n  ${args.join(" ")}\n`);
const child = spawn(exe, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });

child.stderr.on("data", (d) => {
  const s = d.toString();
  log("stderr", { text: s.trimEnd() });
});
child.on("exit", (code, sig) => log("note", { serverExit: { code, sig } }));

let nextId = 1;
const pending = new Map(); // id -> {resolve, method}
function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  writeMessage(msg);
  log("send", msg);
  return new Promise((res) => pending.set(id, { resolve: res, method }));
}
function notify(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  writeMessage(msg);
  log("send", msg);
}
function respond(id, result, error) {
  const msg = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  writeMessage(msg);
  log("send", msg, "response");
}
function writeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

// ---- server->client handling ----------------------------------------------
const razorRequests = []; // collected razor/* and unknown server->client requests
const notificationsSeen = new Set();
let projectInitResolve = null;
const projectInitialized = new Promise((res) => (projectInitResolve = res));

function handleServerMessage(msg) {
  // response to one of our requests
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const p = pending.get(msg.id);
    log("recv", msg, p ? `result of ${p.method}` : "result");
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg);
    }
    return;
  }
  // server -> client request (has id + method) or notification (method only)
  log("recv", msg);
  if (msg.method) {
    if (msg.method === "workspace/projectInitializationComplete") {
      if (projectInitResolve) projectInitResolve(true);
    }
    if (msg.method) notificationsSeen.add(msg.method);
    if (/^razor\//.test(msg.method) || /_vs_/.test(msg.method) || /dynamicFile/i.test(msg.method)) {
      razorRequests.push({ method: msg.method, params: msg.params, hadId: msg.id != null });
    }
    if (msg.id != null) answerServerRequest(msg);
  }
}

function answerServerRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "workspace/configuration": {
      respond(id, resolveConfig(params));
      return;
    }
    case "client/registerCapability":
    case "client/unregisterCapability":
    case "window/workDoneProgress/create":
    case "workspace/semanticTokens/refresh":
    case "workspace/diagnostic/refresh":
    case "workspace/inlayHint/refresh":
    case "workspace/codeLens/refresh":
      respond(id, null);
      return;
    case "window/showMessageRequest":
      respond(id, null);
      return;
    default:
      // Razor dynamic-file / HTML delegation and anything else: log + null.
      // (Fase C will implement these for real; here we just capture the shape.)
      respond(id, null);
      return;
  }
}

// ---- stdout framing parser -------------------------------------------------
let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buf.slice(0, headerEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) return;
    const body = buf.slice(start, start + len).toString("utf8");
    buf = buf.slice(start + len);
    try {
      handleServerMessage(JSON.parse(body));
    } catch (e) {
      log("note", { parseError: String(e), body });
    }
  }
});

// ---- helpers ---------------------------------------------------------------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cshtmlText = readFileSync(cshtml, "utf8");
const cshtmlUri = toFileUri(cshtml);

/** Find the 0-based {line,character} position of `needle` (optionally after an anchor). */
function posOf(needle, anchor) {
  const text = cshtmlText;
  let idx = anchor ? text.indexOf(needle, text.indexOf(anchor)) : text.indexOf(needle);
  if (idx < 0) return null;
  const before = text.slice(0, idx);
  const line = (before.match(/\n/g) || []).length;
  const character = idx - (before.lastIndexOf("\n") + 1);
  return { line, character };
}

const CAPS = {
  workspace: {
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: true },
    workspaceFolders: true,
    diagnostics: { refreshSupport: true },
    semanticTokens: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: true, didSave: true },
    publishDiagnostics: { relatedInformation: true },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    completion: { completionItem: { snippetSupport: true } },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true, full: { delta: false } },
      tokenTypes: [
        "namespace","type","class","enum","interface","struct","typeParameter","parameter",
        "variable","property","enumMember","event","function","method","macro","keyword",
        "modifier","comment","string","number","regexp","operator",
      ],
      tokenModifiers: [
        "declaration","definition","readonly","static","deprecated","abstract","async",
        "modification","documentation","defaultLibrary",
      ],
      formats: ["relative"],
    },
  },
};

// ---- main sequence ---------------------------------------------------------
async function main() {
  const initRes = await send("initialize", {
    processId: process.pid,
    clientInfo: { name: "razor-lsp-probe", version: "0.1.0" },
    locale: "en-us",
    rootUri: toFileUri(root),
    capabilities: CAPS,
    initializationOptions: {
      "csharp|background_analysis": {
        dotnet_analyzer_diagnostics_scope: "openFiles",
        dotnet_compiler_diagnostics_scope: "openFiles",
      },
    },
    workspaceFolders: [{ uri: toFileUri(root), name: "SampleMvc" }],
  });
  const caps = initRes && initRes.result && initRes.result.capabilities;
  log("note", { advertisedCapabilities: caps });

  notify("initialized", {});
  // nudge config (Roslyn pulls config on this)
  notify("workspace/didChangeConfiguration", { settings: {} });

  // open the workspace — mirror the app (src/lsp/servers/roslynShared.ts
  // openRoslynWorkspace): prefer solution/open with a .sln when present, else
  // project/open with the .csproj. Allow an explicit --sln override.
  const slnArg = arg("sln", "");
  let slnPath = slnArg && existsSync(slnArg) ? resolve(slnArg) : "";
  if (!slnPath) {
    const found = readdirSync(root).find((n) => n.toLowerCase().endsWith(".sln"));
    if (found) slnPath = join(root, found);
  }
  if (slnPath) {
    log("note", { open: "solution/open", solution: slnPath });
    notify("solution/open", { solution: toFileUri(slnPath) });
  } else if (csproj && existsSync(csproj)) {
    log("note", { open: "project/open", project: csproj });
    notify("project/open", { projects: [toFileUri(csproj)] });
  }

  log("note", { waitingForProjectInit: true, timeoutMs: initTimeoutMs });
  const initiated = await Promise.race([projectInitialized, delay(initTimeoutMs).then(() => false)]);
  log("note", { projectInitializationComplete: initiated });

  // give Razor a beat to wire the doc
  await delay(2000);

  // open the .cshtml
  let docVersion = 1;
  notify("textDocument/didOpen", {
    textDocument: { uri: cshtmlUri, languageId, version: docVersion, text: cshtmlText },
  });
  await delay(4000);

  const isFirstLoadError = (err) =>
    err && typeof err.message === "string" &&
    /Razor source generator is not referenced or no run result found/.test(err.message);

  async function pullDiag(identifier) {
    const params = { textDocument: { uri: cshtmlUri } };
    if (identifier) params.identifier = identifier;
    const r = await send("textDocument/diagnostic", params).catch((e) => ({ error: String(e) }));
    return r;
  }

  // Reopen workaround for dotnet/razor#12069 (generator no run result on first load):
  // didClose + didOpen (bump version) to force the cohost to re-evaluate the document.
  async function reopenDoc() {
    notify("textDocument/didClose", { textDocument: { uri: cshtmlUri } });
    await delay(800);
    docVersion += 1;
    notify("textDocument/didOpen", {
      textDocument: { uri: cshtmlUri, languageId, version: docVersion, text: cshtmlText },
    });
  }

  // ---- probes ----
  // 1) pull diagnostics with a nudge+retry loop to test the first-load generator bug.
  const NUDGE_ATTEMPTS = 6;
  let diagOk = false;
  for (let attempt = 1; attempt <= NUDGE_ATTEMPTS && !diagOk; attempt++) {
    const r = await pullDiag("DocumentCompilerSemantic");
    const firstLoad = r && r.error && isFirstLoadError(r.error);
    const items = r && r.result && r.result.items;
    log("note", {
      probe: "pull-diagnostic-retry",
      attempt,
      diagCount: items ? items.length : null,
      firstLoadError: !!firstLoad,
      error: r && r.error ? (r.error.message || j(r.error)).slice(0, 120) : null,
    });
    if (items) { diagOk = true; break; }
    if (firstLoad) {
      await reopenDoc();
      await delay(3000 + attempt * 2000); // increasing backoff for generator to run
    } else {
      break; // a different error — stop retrying
    }
  }
  log("note", { probe: "diag-nudge-summary", succeeded: diagOk, finalVersion: docVersion });

  // Now snapshot all known identifiers (post-nudge state).
  for (const identifier of [undefined, "syntax", "DocumentCompilerSemantic", "Razor"]) {
    const r = await pullDiag(identifier);
    const items = r && r.result && r.result.items;
    log("note", {
      probe: "pull-diagnostic",
      identifier: identifier || "(none)",
      diagCount: items ? items.length : null,
      result: items ? r.result : undefined,
      error: r && r.error ? (r.error.message || j(r.error)).slice(0, 160) : undefined,
    });
    await delay(500);
  }

  // 2) semantic tokens — the cohost advertises full:false, range:true, so use /range.
  {
    const docLines = cshtmlText.split("\n");
    const range = {
      start: { line: 0, character: 0 },
      end: { line: docLines.length - 1, character: docLines[docLines.length - 1].length },
    };
    const r = await send("textDocument/semanticTokens/range", { textDocument: { uri: cshtmlUri }, range }).catch((e) => ({ error: String(e) }));
    const dataLen = r && r.result && r.result.data ? r.result.data.length : 0;
    log("note", { probe: "semanticTokens/range", tokenInts: dataLen, error: r && r.error });
  }

  // 3) hover over Model.City
  {
    const p = posOf("City", "@Model.");
    if (p) {
      const r = await send("textDocument/hover", { textDocument: { uri: cshtmlUri }, position: p }).catch((e) => ({ error: String(e) }));
      log("note", { probe: "hover@Model.City", position: p, result: r && r.result, error: r && r.error });
    }
  }

  // 4) definition on Model.City
  {
    const p = posOf("City", "@Model.");
    if (p) {
      const r = await send("textDocument/definition", { textDocument: { uri: cshtmlUri }, position: p }).catch((e) => ({ error: String(e) }));
      log("note", { probe: "definition@Model.City", position: p, result: r && r.result, error: r && r.error });
    }
  }

  // 5) completion right after "@Model." on the City line
  {
    const anchor = "@Model.City";
    const idx = cshtmlText.indexOf(anchor);
    if (idx >= 0) {
      const dotIdx = cshtmlText.indexOf(".", idx) + 1;
      const before = cshtmlText.slice(0, dotIdx);
      const line = (before.match(/\n/g) || []).length;
      const character = dotIdx - (before.lastIndexOf("\n") + 1);
      const r = await send("textDocument/completion", {
        textDocument: { uri: cshtmlUri },
        position: { line, character },
        context: { triggerKind: 2, triggerCharacter: "." },
      }).catch((e) => ({ error: String(e) }));
      const items = r && r.result && (Array.isArray(r.result) ? r.result : r.result.items);
      log("note", { probe: "completion@Model.", count: items ? items.length : 0, sample: items ? items.slice(0, 8).map((i) => i.label) : null, error: r && r.error });
    }
  }

  await delay(1500);
  writeSummary(caps);

  try { await send("shutdown", null); } catch {}
  notify("exit", null);
  await delay(500);
  child.kill();
  transcript.end();
  console.log(`\n[probe] transcript: ${transcriptPath}\n[probe] summary:    ${summaryPath}`);
}

function findNotes(predicate) {
  return events.filter((e) => e.dir === "note" && predicate(e.payload)).map((e) => e.payload);
}

function writeSummary(caps) {
  const lines = [];
  lines.push(`# Fase 0 — captura LSP do cohost Roslyn (Razor/CSHTML)`);
  lines.push("");
  lines.push(`- server: \`${exe}\``);
  lines.push(`- RoslynVersion.txt: \`${safeRead(join(roslynDir, "RoslynVersion.txt"))}\``);
  lines.push(`- cshtml: \`${cshtml}\` (languageId \`${languageId}\`)`);
  lines.push(`- transcript: \`${transcriptPath}\``);
  lines.push("");
  lines.push(`## Capabilities anunciadas`);
  lines.push("```json");
  lines.push(JSON.stringify(caps || {}, null, 2));
  lines.push("```");
  lines.push("");
  const initNote = findNotes((p) => "projectInitializationComplete" in p)[0];
  lines.push(`## Project init`);
  lines.push(`- \`workspace/projectInitializationComplete\`: **${initNote ? initNote.projectInitializationComplete : "?"}**`);
  lines.push("");
  lines.push(`## Resultados das probes`);
  lines.push("");
  lines.push(`| probe | resultado |`);
  lines.push(`|---|---|`);
  const errStr = (e) => (e == null ? "" : (typeof e === "string" ? e : (e.message || j(e)))).slice(0, 140);
  for (const p of findNotes((x) => x.probe)) {
    let r = "";
    if (p.probe === "pull-diagnostic-retry") {
      r = `attempt ${p.attempt}: ${p.diagCount != null ? p.diagCount + " diag" : (p.firstLoadError ? "first-load error" : "ERRO " + errStr(p.error))}`;
    } else if (p.probe === "diag-nudge-summary") {
      r = `succeeded=**${p.succeeded}** (finalVersion ${p.finalVersion})`;
    } else if (p.probe === "pull-diagnostic") {
      r = `id=\`${p.identifier}\` → ${p.diagCount != null ? p.diagCount + " diag" : "ERRO " + errStr(p.error)}`;
    } else if (p.probe.startsWith("semanticTokens")) {
      r = p.error ? `ERRO ${errStr(p.error)}` : `${p.tokenInts} ints (${Math.floor((p.tokenInts || 0) / 5)} tokens)`;
    } else if (p.probe.startsWith("hover")) {
      r = p.error ? `ERRO ${j(p.error)}` : (p.result ? "hover OK: " + j(p.result).slice(0, 160) : "null");
    } else if (p.probe.startsWith("definition")) {
      r = p.error ? `ERRO ${j(p.error)}` : (p.result && (p.result.length || p.result.uri) ? "definition OK: " + j(p.result).slice(0, 200) : "null/empty");
    } else if (p.probe.startsWith("completion")) {
      r = p.error ? `ERRO ${j(p.error)}` : `${p.count} itens ${p.sample ? "ex: " + p.sample.join(", ") : ""}`;
    }
    lines.push(`| \`${p.probe}\` | ${r} |`);
  }
  lines.push("");
  lines.push(`## Requests \`razor/*\` / dynamic-file recebidos do servidor (insumo da Fase C)`);
  if (razorRequests.length === 0) {
    lines.push(`_(nenhum capturado nesta execução)_`);
  } else {
    const byMethod = {};
    for (const r of razorRequests) byMethod[r.method] = (byMethod[r.method] || 0) + 1;
    for (const [method, count] of Object.entries(byMethod)) {
      lines.push(`- \`${method}\` ×${count}${razorRequests.find((x) => x.method === method).hadId ? " (request)" : " (notification)"}`);
    }
    lines.push("");
    lines.push(`### Exemplo de payload`);
    lines.push("```json");
    lines.push(JSON.stringify(razorRequests[0], null, 2).slice(0, 2000));
    lines.push("```");
  }
  lines.push("");
  lines.push(`## Notificações server→client observadas`);
  lines.push([...notificationsSeen].map((m) => `- \`${m}\``).join("\n") || "_(nenhuma)_");
  writeFileSync(summaryPath, lines.join("\n"), "utf8");
}

function j(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function safeRead(p) { try { return readFileSync(p, "utf8").trim(); } catch { return "?"; } }

const globalTimeout = setTimeout(() => {
  log("note", { abort: "global timeout" });
  try { writeSummary(null); } catch {}
  child.kill();
  transcript.end();
  process.exit(1);
}, initTimeoutMs + 60000);
globalTimeout.unref?.();

main().then(() => { clearTimeout(globalTimeout); }).catch((e) => {
  log("note", { fatal: String(e && e.stack || e) });
  try { writeSummary(null); } catch {}
  child.kill();
  transcript.end();
  process.exit(1);
});
