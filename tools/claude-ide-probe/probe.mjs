#!/usr/bin/env node
// Probe de aceite da ponte IDE do Claude Code (ADR 0006).
//
// Faz o papel do CLI `claude`: acha o lock file do Fluent Coder para um
// workspace, conecta no WebSocket com o token e exercita o protocolo
// (initialize, tools/list, tools/call) conferindo os formatos que o CLI real
// consome. Também confere que token errado e header Origin são recusados.
//
// Uso:  node tools/claude-ide-probe/probe.mjs [pasta-do-workspace] [--port N]
// (padrão: diretório atual). Requer Node >= 22 (WebSocket global com headers).
// Sai com código 0 só se todas as verificações passarem.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const portIdx = argv.indexOf("--port");
const wantedPort = portIdx >= 0 ? Number(argv[portIdx + 1]) : null;
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port");
const workspace = resolve(positional[0] ?? process.cwd());

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 1. lock file --------------------------------------------------------

const lockDir = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "ide")
  : join(homedir(), ".claude", "ide");

const norm = (p) => p.replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase();
const within = (p, folder) => norm(p) === norm(folder) || norm(p).startsWith(`${norm(folder)}/`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

let entries = [];
try {
  entries = readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
} catch {
  console.error(`Diretório de lock files não encontrado: ${lockDir}`);
  process.exit(2);
}

const candidates = entries
  .map((f) => {
    try {
      const path = join(lockDir, f);
      return { path, port: Number(f.replace(/\.lock$/, "")), lock: JSON.parse(readFileSync(path, "utf8")) };
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter((c) => c.lock.ideName === "Fluent Coder" && alive(c.lock.pid))
  .filter((c) => (wantedPort ? c.port === wantedPort : true))
  .filter((c) => (c.lock.workspaceFolders ?? []).some((f) => within(workspace, f)));

if (candidates.length === 0) {
  console.error(
    `Nenhum lock file do Fluent Coder (processo vivo) cobre ${workspace} em ${lockDir}.\n` +
      "Abra essa pasta no Fluent Coder e rode de novo."
  );
  process.exit(2);
}
const { path: lockPath, port, lock } = candidates[0];
console.log(`Lock: ${lockPath} (porta ${port}, pid ${lock.pid})\n`);

check("lock: transport ws", lock.transport === "ws");
check("lock: authToken de 128 bits em hex", /^[0-9a-f]{32}$/.test(lock.authToken ?? ""));
check("lock: workspaceFolders absolutos", Array.isArray(lock.workspaceFolders) && lock.workspaceFolders.every((f) => f.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(f)));
check("lock: runningInWindows booleano coerente", lock.runningInWindows === (process.platform === "win32"));
if (process.platform !== "win32") {
  const mode = statSync(lockPath).mode & 0o777;
  check("lock: permissão 0600", mode === 0o600, `atual ${mode.toString(8)}`);
}

// ---- cliente JSON-RPC mínimo --------------------------------------------

const url = `ws://127.0.0.1:${port}`;

function open(headers) {
  return new Promise((res, rej) => {
    // O CLI sempre pede um subprotocolo; um servidor que não o ecoa derruba o
    // cliente ("Server sent no subprotocol"). Pedimos também, para pegar isso.
    const ws = new WebSocket(url, { headers, protocols: ["mcp"] });
    const timer = setTimeout(() => rej(new Error("timeout")), 3000);
    ws.onopen = () => {
      clearTimeout(timer);
      res(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rej(new Error("conexão recusada"));
    };
  });
}

function rpcClient(ws) {
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id != null && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  return {
    request(method, params, timeoutMs = 5000) {
      const id = nextId++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return new Promise((res, rej) => {
        waiting.set(id, res);
        setTimeout(() => {
          if (waiting.delete(id)) rej(new Error(`${method}: sem resposta`));
        }, timeoutMs);
      });
    },
    notify(method, params) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
  };
}

/** Uma conexão "recusada" não pode chegar a responder um initialize. */
async function rejected(headers) {
  let ws;
  try {
    ws = await open(headers);
  } catch {
    return true;
  }
  try {
    await rpcClient(ws).request("initialize", { protocolVersion: "2025-11-25" }, 1500);
    return false;
  } catch {
    return true;
  } finally {
    ws.close();
  }
}

const toolText = (resp) => resp?.result?.content?.[0]?.text;
const toolJson = (resp) => JSON.parse(toolText(resp));
const isPos = (p) => Number.isInteger(p?.line) && p.line >= 0 && Number.isInteger(p?.character) && p.character >= 0;

// ---- 2. autenticação -----------------------------------------------------

check("auth: token errado é recusado", await rejected({ "x-claude-code-ide-authorization": "0".repeat(32) }));
check("auth: sem token é recusado", await rejected({}));
check(
  "auth: header Origin é recusado (CSRF)",
  await rejected({ "x-claude-code-ide-authorization": lock.authToken, origin: "http://evil.example" })
);

// ---- 3. protocolo --------------------------------------------------------

let ws;
try {
  ws = await open({ "x-claude-code-ide-authorization": lock.authToken });
  check("auth: token correto conecta", true);
} catch (e) {
  check("auth: token correto conecta", false, e.message);
  finish();
}
const rpc = rpcClient(ws);

try {
  const init = await rpc.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: { roots: {}, elicitation: {} },
    clientInfo: { name: "claude-ide-probe", version: "1.0.0" },
  });
  check("initialize: ecoa protocolVersion", init.result?.protocolVersion === "2025-11-25");
  check("initialize: capabilities.tools", init.result?.capabilities?.tools != null);
  check("initialize: serverInfo.name", init.result?.serverInfo?.name === "fluent-coder");
  rpc.notify("notifications/initialized", {});
  rpc.notify("ide_connected", { pid: process.pid });

  const list = await rpc.request("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  const required = [
    "openDiff", "openFile", "getDiagnostics", "getWorkspaceFolders", "getCurrentSelection",
    "getLatestSelection", "getOpenEditors", "checkDocumentDirty", "saveDocument", "close_tab",
    "closeAllDiffTabs",
  ];
  const missing = required.filter((n) => !names.includes(n));
  check("tools/list: ferramentas do CLI presentes", missing.length === 0, missing.join(", "));
  check("tools/list: inputSchema em todas", (list.result?.tools ?? []).every((t) => t.inputSchema?.type === "object"));

  const call = (name, args = {}) => rpc.request("tools/call", { name, arguments: args });

  const wf = toolJson(await call("getWorkspaceFolders"));
  check("getWorkspaceFolders: success", wf.success === true);
  check(
    "getWorkspaceFolders: contém o workspace",
    wf.folders?.some((f) => within(workspace, f.path) && f.uri?.startsWith("file://") && typeof f.name === "string")
  );
  check("getWorkspaceFolders: rootPath", typeof wf.rootPath === "string");

  const diags = toolJson(await call("getDiagnostics"));
  check("getDiagnostics: array", Array.isArray(diags));
  check(
    "getDiagnostics: formato {uri, diagnostics[]} com faixas 0-based",
    diags.every(
      (f) =>
        f.uri?.startsWith("file://") &&
        Array.isArray(f.diagnostics) &&
        f.diagnostics.every(
          (d) =>
            typeof d.message === "string" &&
            ["Error", "Warning", "Information", "Hint"].includes(d.severity) &&
            isPos(d.range?.start) &&
            isPos(d.range?.end)
        )
    ),
    `${diags.length} arquivo(s) com diagnósticos`
  );
  if (diags.length > 0) {
    const one = toolJson(await call("getDiagnostics", { uri: diags[0].uri }));
    check("getDiagnostics {uri}: filtra pelo arquivo", one.length === 1 && one[0].uri === diags[0].uri);
  }

  const editors = toolJson(await call("getOpenEditors"));
  check(
    "getOpenEditors: tabs",
    Array.isArray(editors.tabs) &&
      editors.tabs.every((t) => typeof t.uri === "string" && typeof t.isDirty === "boolean" && typeof t.isActive === "boolean")
  );

  const sel = toolJson(await call("getCurrentSelection"));
  check(
    "getCurrentSelection: formato",
    sel.success === false ? typeof sel.message === "string" : isPos(sel.selection?.start) && typeof sel.filePath === "string"
  );

  check("closeAllDiffTabs: CLOSED_<n>_DIFF_TABS", /^CLOSED_\d+_DIFF_TABS$/.test(toolText(await call("closeAllDiffTabs"))));
  const unknown = await call("ferramentaInexistente");
  check("tools/call desconhecida: isError", unknown.result?.isError === true);
  const other = await rpc.request("prompts/list", {});
  check("prompts/list: vazio", Array.isArray(other.result?.prompts));
} catch (e) {
  check("protocolo", false, e.message);
}

ws.close();
finish();

function finish() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} verificações passaram.`);
  process.exit(passed === results.length ? 0 : 1);
}
