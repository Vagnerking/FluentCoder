#!/usr/bin/env node
// Aceite headless (M2/M3/M4) do mini extension host, pelo MESMO protocolo stdio
// que o backend Rust usa:
//   1. sobe `node tools/ext-host/main.js`, initialize, lista as instaladas;
//   2. carrega + ativa a extensão real (sem enviar prompt a modelo nenhum);
//   3. resolve a webview view e baixa o HTML servido + todos os <script>/<link>
//      apontando para o servidor local (todos precisam responder 200);
//   4. round trip: injeta a 1ª mensagem que o webview real envia e espera a
//      resposta da extensão (postMessage) — webview → extensão → webview.
//
// Uso: node tools/ext-host/scripts/headless-check.js [claude|codex|all]
// Dica: rode com CLAUDE_CONFIG_DIR/CODEX_HOME apontando para pastas
// temporárias para não tocar a configuração real do usuário.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const readline = require('readline');

const TARGETS = {
  claude: {
    id: 'anthropic.claude-code',
    probe: { type: 'request', channelId: '', requestId: 'fluent-probe-1', request: { type: 'init' } },
    // A extensão embrulha as respostas: { type:'from-extension', message:{ type:'response', … } }
    isReply: (m) => m && m.type === 'from-extension' && m.message && m.message.type === 'response' && m.message.requestId === 'fluent-probe-1',
  },
  codex: {
    id: 'openai.chatgpt',
    probe: { type: 'ready' },
    isReply: (m) => m && m.type === 'chat-font-settings',
  },
};

function startHost() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'main.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const waiters = new Map();
  const listeners = [];
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (process.env.VERBOSE) process.stderr.write(d);
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('LINHA NÃO-JSON NO STDOUT DO PROTOCOLO:', line.slice(0, 200));
      process.exitCode = 1;
      return;
    }
    if (msg.id !== undefined && waiters.has(msg.id)) {
      const w = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    } else if (msg.event) for (const l of [...listeners]) l(msg);
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    call(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      return new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ method, params }) + '\n');
    },
    waitEvent(pred, ms) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          listeners.splice(listeners.indexOf(fn), 1);
          reject(new Error(`timeout (${ms}ms)`));
        }, ms);
        const fn = (e) => {
          if (pred(e)) {
            clearTimeout(t);
            listeners.splice(listeners.indexOf(fn), 1);
            resolve(e);
          }
        };
        listeners.push(fn);
      });
    },
  };
}

async function fetchStatus(url) {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body, type: res.headers.get('content-type') };
}

async function check(name, host, installed) {
  const t = TARGETS[name];
  const info = installed.find((e) => e.id === t.id);
  const report = { target: name, found: !!info };
  if (!info) return report;
  report.version = info.version;
  const loaded = await host.call('loadExtension', { id: t.id });
  report.activated = loaded.isActive;
  const viewId = info.viewIds.find((v) => loaded.views.some((x) => x.id === v));
  report.viewId = viewId;
  const view = await host.call('resolveView', { viewId });
  report.handle = view.handle;
  report.htmlUrl = view.url;
  const page = await fetchStatus(view.url);
  report.html = { status: page.status, bytes: page.body.length, hasPreamble: page.body.includes('acquireVsCodeApi'), preambleBeforeCsp: page.body.indexOf('acquireVsCodeApi') < page.body.indexOf('Content-Security-Policy') };
  const origin = new URL(view.url).origin;
  const baseTag = /<base href="([^"]+)"/.exec(page.body);
  const base = baseTag ? baseTag[1].replace(/&amp;/g, '&') : view.url;
  const urls = [...page.body.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)]
    .map((m) => new URL(m[1].replace(/&amp;/g, '&'), base).href)
    .filter((u) => u.startsWith(origin));
  report.assets = [];
  for (const u of [...new Set(urls)]) {
    const r = await fetchStatus(u);
    report.assets.push({ path: decodeURIComponent(new URL(u).pathname.split('/res')[1] || u).replace(info.path, '<ext>'), status: r.status, bytes: r.body.length, type: r.type });
  }
  const t0 = Date.now();
  const reply = host.waitEvent((e) => e.event === 'postMessage' && e.handle === view.handle && t.isReply(e.message), 30000);
  host.notify('webviewMessage', { handle: view.handle, message: t.probe });
  try {
    const ev = await reply;
    const inner = ev.message.message && ev.message.message.response ? ev.message.message.response : ev.message;
    const keys = Object.keys(inner || {});
    report.roundTrip = { ok: true, ms: Date.now() - t0, replyType: inner.type || ev.message.type, replyKeys: keys.slice(0, 12) };
  } catch (err) {
    report.roundTrip = { ok: false, error: err.message };
  }
  return report;
}

async function main() {
  const which = process.argv[2] || 'all';
  const names = which === 'all' ? Object.keys(TARGETS) : [which];
  const host = startHost();
  await host.waitEvent((e) => e.event === 'hello', 10000);
  const init = await host.call('initialize', {
    workspaceFolders: [process.cwd()],
    dataDir: path.join(os.tmpdir(), `fluent-ext-host-check-${process.pid}`),
    appConnected: false,
  });
  console.log(`host ok: ${init.origin} (node ${init.node}); instaladas suportadas: ${init.extensions.filter((e) => e.supported).map((e) => `${e.id}@${e.version}`).join(', ') || 'nenhuma'}`);
  let ok = true;
  for (const n of names) {
    let r;
    try {
      r = await check(n, host, init.extensions);
    } catch (err) {
      r = { target: n, error: err.message };
    }
    const pass = r.found && r.activated && r.html && r.html.status === 200 && r.assets.every((a) => a.status === 200) && r.roundTrip && r.roundTrip.ok;
    ok = ok && !!pass;
    console.log(JSON.stringify({ pass: !!pass, ...r }, null, 2));
  }
  await host.call('shutdown').catch(() => {});
  if (!ok && process.env.VERBOSE !== '1') console.error('--- stderr do host (cauda) ---\n' + host.stderr.split('\n').slice(-40).join('\n'));
  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
