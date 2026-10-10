#!/usr/bin/env node
// Entrada do mini extension host do Fluent Coder.
//
// Protocolo (stdio, uma mensagem JSON por linha):
//   app → host : { id?, method, params }      (sem `id` = notificação)
//   host → app : { id, result } | { id, error: { message } }   (respostas)
//                { event, ... }                                  (eventos)
// O stdout é EXCLUSIVO do protocolo: tudo que as extensões escrevem no
// stdout/console é desviado para o stderr (que o backend Rust só registra).
'use strict';
const path = require('path');
const os = require('os');
const readline = require('readline');

const protoWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

const { ExtensionHost } = require('./src/host');
const { listInstalled } = require('./src/installed');

function send(obj) {
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

const handlers = {
  async initialize(p = {}) {
    if (host) return { origin: host.server.origin, extensions: installed };
    const dataDir = p.dataDir || path.join(os.homedir(), '.fluent-coder', 'ext-host');
    host = new ExtensionHost({
      dataDir,
      workspaceFolders: (p.workspaceFolders || []).filter(Boolean),
      language: p.language || 'pt-br',
      emit: send,
      appConnected: p.appConnected !== false,
      debugWebviews: !!p.debugWebviews || process.env.FLUENT_EXT_HOST_DEBUG === '1',
      verbose: process.env.FLUENT_EXT_HOST_DEBUG === '1',
    });
    const { origin, port } = await host.start();
    installed = listInstalled();
    return { origin, port, dataDir, pid: process.pid, node: process.version, extensions: installed };
  },
  listInstalled() {
    installed = listInstalled();
    return installed;
  },
  async loadExtension(p) {
    const target = p.path || (installed.find((e) => e.id === String(p.id).toLowerCase()) || {}).path;
    if (!target) throw new Error(`Extensão não encontrada: ${p.id || p.path}`);
    const ext = host.loadExtension(target);
    if (p.activate !== false) await host.activate(ext.id);
    return host.describe(ext);
  },
  async activate(p) {
    await host.activate(p.id);
    return host.describe(host.extensions.get(p.id));
  },
  resolveView(p) {
    return host.resolveView(p.viewId);
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
  editorState(p) {
    return host.setEditorState(p || {});
  },
  setWorkspaceFolders(p) {
    host.setWorkspaceFolders(p.folders || []);
  },
  respond(p) {
    host.respond(p.requestId, p.result);
  },
  executeCommand(p) {
    return host.executeCommand(p.command, ...(p.args || []));
  },
  async shutdown() {
    if (host) await host.stop();
    setTimeout(() => process.exit(0), 50);
    return true;
  },
};

async function dispatch(msg) {
  const fn = handlers[msg.method];
  if (!fn) {
    if (msg.id !== undefined) send({ id: msg.id, error: { message: `método desconhecido: ${msg.method}` } });
    return;
  }
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
rl.on('close', async () => {
  // App fechou o stdin: encerra as extensões (elas matam seus filhos no deactivate).
  try {
    if (host) await host.stop();
  } finally {
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[ext-host] exceção não tratada: ${err && err.stack ? err.stack : err}\n`);
  send({ event: 'log', level: 'error', message: `exceção não tratada: ${err && err.message}` });
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[ext-host] promise rejeitada: ${err && err.stack ? err.stack : err}\n`);
});

send({ event: 'hello', pid: process.pid, node: process.version });
