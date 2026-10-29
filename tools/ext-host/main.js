#!/usr/bin/env node
// Entrada do mini extension host do Fluent Coder.
//
// Protocolo (stdio, uma mensagem JSON por linha):
//   app → host : { id?, method, params }      (sem `id` = notificação)
//   host → app : { id, result } | { id, error: { message } }   (respostas)
//                { event, ... }                                  (eventos)
// O stdout é EXCLUSIVO do protocolo: tudo que as extensões escrevem no
// stdout/console é desviado para o stderr (que o backend Rust só registra).
// Toda mensagem recebida é validada (src/protocol.js) antes de ser tratada.
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const readline = require('readline');
const Module = require('module');

const protoWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

const { ExtensionHost } = require('./src/host');
const { listInstalled } = require('./src/installed');
const { validateMessage } = require('./src/protocol');

// Pipes para o app: quando o app morre, escrever neles dá EPIPE. Sem esta
// guarda, o erro caía no `uncaughtException`, que escrevia de novo — um loop
// quente (CPU alta) que nunca deixava o host encerrar e o deixava órfão.
let protocolBroken = false;
process.stdout.on('error', (err) => {
  protocolBroken = true;
  void shutdown(`stdout indisponível (${err && err.code})`);
});
process.stderr.on('error', () => {
  /* stderr só tem logs: perder é aceitável, travar não */
});

function logErr(text) {
  try {
    process.stderr.write(text);
  } catch {
    /* stderr fechado */
  }
}

function send(obj) {
  if (protocolBroken) return;
  let line;
  try {
    line = JSON.stringify(obj);
  } catch (err) {
    line = JSON.stringify({ event: 'log', message: `falha ao serializar evento ${obj && obj.event}: ${err.message}` });
  }
  protoWrite(line + '\n');
}

let host = null;
let installed = [];
/** Pasta de extensões gerenciada pelo app (`<app_data>/extensions`), vinda do `initialize`. */
let managedExtensionsDir = null;
/** `loadExtension({path})` só sem app (scripts headless/testes): no app vale o portão de compatibilidade. */
let headless = false;

function scanInstalled() {
  return listInstalled({ managed: managedExtensionsDir, language: host ? host.language : 'pt-br' });
}

/** Cache de compilação do V8 (Node 22.1+): `require` dos bundles grandes fica mais rápido da 2ª vez. */
function enableCompileCache(dataDir) {
  if (typeof Module.enableCompileCache !== 'function') return null;
  try {
    const r = Module.enableCompileCache(path.join(dataDir, 'compile-cache'));
    return r && r.directory ? r.directory : null;
  } catch {
    return null;
  }
}

function readPort(dataDir) {
  try {
    const n = parseInt(fs.readFileSync(path.join(dataDir, 'server-port'), 'utf8'), 10);
    return n > 1024 && n < 65536 ? n : 0;
  } catch {
    return 0;
  }
}

const handlers = {
  async initialize(p = {}) {
    if (host) return { origin: host.server.origin, extensions: installed };
    const dataDir = p.dataDir || path.join(os.homedir(), '.fluent-coder', 'ext-host');
    fs.mkdirSync(dataDir, { recursive: true });
    managedExtensionsDir = p.extensionsDir || null;
    headless = p.appConnected === false;
    const compileCache = enableCompileCache(dataDir);
    host = new ExtensionHost({
      dataDir,
      workspaceFolders: (p.workspaceFolders || []).filter(Boolean),
      language: p.language || 'pt-br',
      emit: send,
      appConnected: p.appConnected !== false,
      secretsBackend: p.secrets === 'keyring' ? 'keyring' : 'file',
      serverPort: readPort(dataDir),
      debugWebviews: !!p.debugWebviews || process.env.FLUENT_EXT_HOST_DEBUG === '1',
      verbose: process.env.FLUENT_EXT_HOST_DEBUG === '1',
    });
    const { origin, port } = await host.start();
    try {
      fs.writeFileSync(path.join(dataDir, 'server-port'), String(port));
    } catch {
      /* ignora */
    }
    installed = scanInstalled();
    return { origin, port, dataDir, pid: process.pid, node: process.version, compileCache, extensions: installed };
  },
  listInstalled() {
    installed = scanInstalled();
    return installed;
  },
  async loadExtension(p) {
    if (p.path && !headless) throw new Error('loadExtension por caminho só é aceito sem app (headless).');
    let target = p.path;
    if (!target) {
      const id = String(p.id).toLowerCase();
      const found = installed.find((e) => e.id === id);
      if (!found) throw new Error(`Extensão não encontrada: ${p.id}`);
      // Portão de compatibilidade: desabilitada / não avaliada / incompatível não carrega.
      if (!found.supported) throw new Error(`Extensão ${p.id} não liberada para este host (${found.blockedReason || 'bloqueada'}).`);
      target = found.path;
    }
    const ext = host.loadExtension(target);
    if (p.activate !== false) await host.activate(ext.id);
    return { ...host.describe(ext), activationMs: ext.activationMs };
  },
  async activate(p) {
    await host.activate(p.id);
    return host.describe(host.extensions.get(p.id));
  },
  resolveView(p) {
    return host.resolveView(p.viewId);
  },
  /**
   * Painéis da sessão anterior (persistidos pelo app): carrega/ativa a
   * extensão dona (como o `onWebviewPanel:<viewType>` do VS Code) e chama o
   * serializer/custom editor dela. Devolve quantos voltaram.
   */
  async restoreWebviewPanels(p) {
    let restored = 0;
    for (const rec of p.panels) {
      try {
        const id = String(rec.extensionId).toLowerCase();
        if (!host.extensions.has(id)) {
          const target = (installed.find((e) => e.id === id && e.supported) || {}).path;
          if (!target) continue;
          host.loadExtension(target);
        }
        if (await host.restoreWebviewPanel(rec)) restored++;
      } catch (err) {
        logErr(`[ext-host] restaurar painel ${rec && rec.viewType} falhou: ${err && err.stack ? err.stack : err}\n`);
      }
    }
    return { restored };
  },
  webviewMessage(p) {
    return host.webviewMessage(p.handle, p.message);
  },
  webviewState(p) {
    host.setWebviewState(p.handle, p.state);
  },
  webviewVisible(p) {
    host.setWebviewVisible(p.handle, p.visible);
  },
  webviewPanelState(p) {
    host.setWebviewPanelState(p);
  },
  webviewLog(p) {
    const text = String(p && p.text).slice(0, 4000);
    logErr(`[ext-host] [webview ${p && p.handle}] ${p && p.level === 'warn' ? 'aviso' : 'erro'}: ${text}\n`);
  },
  disposeWebview(p) {
    host.disposeWebview(p.handle);
  },
  webviewUrl(p) {
    const entry = host.webviews.get(p.handle);
    return entry ? host._webviewInfo(entry) : null;
  },
  setTheme(p) {
    host.setTheme(p.vars, p.kind);
  },
  setWorkspaceFolders(p) {
    host.setWorkspaceFolders(p.folders || []);
  },
  setLanguages(p) {
    host.setLanguages(p.languages);
  },
  // Camadas de configuração do app (src/settings/): default/user/workspace/pastas.
  configuration(p) {
    host.config.setSnapshot(p);
  },
  respond(p) {
    host.respond(p.requestId, p.result);
  },
  executeCommand(p) {
    return host.executeCommand(p.command, ...(p.args || []));
  },
  listCommands() {
    return host.contributedCommands();
  },
  // `when` de contribuições (ex.: botões editor/title) avaliado com o contexto
  // do host (config.*, setContext, foco publicado pelo app). Best effort.
  evaluateWhen(p) {
    return p.exprs.map((e) => {
      if (!e) return true;
      try {
        return !!host.evaluateWhen(e);
      } catch {
        return false;
      }
    });
  },
  runKeybinding(p) {
    return host.runKeybinding(p.key, p.context);
  },
  // ---- espelho do editor do app
  documentOpened(p) {
    host.documentOpened(p);
  },
  documentChanged(p) {
    host.documentChanged(p);
  },
  documentClosed(p) {
    host.documentClosed(p);
  },
  documentSaved(p) {
    host.documentSaved(p);
  },
  editorsChanged(p) {
    host.editorsChanged(p);
  },
  selectionChanged(p) {
    host.selectionChanged(p);
  },
  visibleRangesChanged(p) {
    host.visibleRangesChanged(p);
  },
  diagnostics(p) {
    host.setDiagnostics(p.entries);
  },
  windowState(p) {
    if (host.windowState.focused === p.focused) return;
    host.windowState = { focused: p.focused, active: p.focused };
    host.events.windowState.fire(host.windowState);
  },
  // ---- terminais / diffs / URIs
  terminalOpened(p) {
    host.terminalOpened(p.id, p.pid, p.shellIntegration, p.cols ? { cols: p.cols, rows: p.rows } : undefined);
  },
  terminalInput(p) {
    host.terminalInput(p.id, p.data);
  },
  terminalResize(p) {
    host.terminalResize(p.id, p.cols, p.rows);
  },
  terminalShell(p) {
    host.terminalShell(p);
  },
  terminalClosed(p) {
    host.terminalClosed(p.id, p.exitCode);
  },
  diffAction(p) {
    return host.diffAction(p.diffId, p.action, p.text);
  },
  diffClosed(p) {
    host.diffClosed(p.diffId);
  },
  handleUri(p) {
    return host.handleUri(p.uri);
  },
  cancelProgress(p) {
    return host.progress.cancel(p.id);
  },
  quickInputEvent(p) {
    return host.quickInputs.event(p);
  },
  commentAction(p) {
    return host.comments.action(p);
  },
  commentReaction(p) {
    return host.comments.reaction(p);
  },
  commentingRanges(p) {
    return host.comments.commentingRanges(p.uri);
  },
  commentCreateThread(p) {
    return host.comments.createThread(p);
  },
  commentDisposeTemplate(p) {
    return host.comments.disposeTemplate(p.handle);
  },
  commentThreads() {
    return host.comments.snapshot();
  },
  diffEdited(p) {
    return host.diffEdited(p.diffId, p.text);
  },
  provideCodeLenses(p) {
    return host.provideCodeLenses(p.path);
  },
  executeCodeLens(p) {
    return host.executeCodeLens(p.id);
  },
  async shutdown() {
    if (host) await host.stop();
    setTimeout(() => process.exit(0), 50);
    return true;
  },
};

async function dispatch(msg) {
  const invalid = validateMessage(msg);
  if (invalid) {
    process.stderr.write(`[ext-host] mensagem recusada: ${invalid}\n`);
    if (msg && msg.id !== undefined) send({ id: msg.id, error: { message: invalid } });
    return;
  }
  const fn = handlers[msg.method];
  if (!host && msg.method !== 'initialize' && msg.method !== 'listInstalled' && msg.method !== 'shutdown') {
    if (msg.id !== undefined) send({ id: msg.id, error: { message: 'host não inicializado' } });
    return;
  }
  try {
    const result = await fn(msg.params || {});
    if (msg.id !== undefined) send({ id: msg.id, result: result === undefined ? null : result });
  } catch (err) {
    process.stderr.write(`[ext-host] ${msg.method} falhou: ${err && err.stack ? err.stack : err}\n`);
    if (msg.id !== undefined) send({ id: msg.id, error: { message: err && err.message ? err.message : String(err) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`[ext-host] linha inválida ignorada: ${line.slice(0, 200)}\n`);
    return;
  }
  dispatch(msg);
});
// Teto do deactivate() no encerramento: uma extensão que não responde (o Codex
// esperando o app-server, por ex.) não pode segurar o processo vivo — era o
// que deixava hosts órfãos depois de o app morrer.
const STOP_TIMEOUT_MS = 2000;
let shuttingDown = false;

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logErr(`[ext-host] encerrando: ${reason}\n`);
  try {
    if (host) await Promise.race([host.stop(), new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS))]);
  } catch {
    /* encerra de qualquer jeito */
  }
  killProcessGroup();
  process.exit(0);
}

// O app nos inicia como líder de grupo (Unix): sinalizar o grupo derruba os
// filhos que as extensões não encerraram (claude, codex app-server) — e o
// próprio host. Fora do grupo (ex.: rodando à mão), `-pid` não existe e é no-op.
function killProcessGroup() {
  if (process.platform === 'win32') return;
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    /* não somos líder de grupo */
  }
}

// App fechou o stdin: encerra as extensões (elas matam seus filhos no deactivate).
rl.on('close', () => void shutdown('stdin fechado'));

// Rede de segurança: se o app morrer sem fechar o stdin, o host é adotado por
// outro processo (o ppid muda) — encerra em vez de ficar órfão.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) void shutdown('app encerrado');
}, 2000).unref();

process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') {
    protocolBroken = true;
    void shutdown('pipe do app fechado');
    return;
  }
  logErr(`[ext-host] exceção não tratada: ${err && err.stack ? err.stack : err}\n`);
  send({ event: 'log', level: 'error', message: `exceção não tratada: ${err && err.message}` });
});
process.on('unhandledRejection', (err) => {
  logErr(`[ext-host] promise rejeitada: ${err && err.stack ? err.stack : err}\n`);
});

send({ event: 'hello', pid: process.pid, node: process.version });
