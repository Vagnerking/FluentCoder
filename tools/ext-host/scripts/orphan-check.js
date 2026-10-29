#!/usr/bin/env node
'use strict';
// Regressão: o host (e os filhos das extensões) precisam morrer quando o app
// morre. Sobe o host como o app faz no Unix (líder de grupo próprio), ativa as
// extensões instaladas — o Codex sobe o `codex app-server` —, simula a morte do
// app fechando TODOS os pipes de uma vez e exige que o grupo inteiro suma.
//
// Usa CLAUDE_CONFIG_DIR/CODEX_HOME temporários: não toca nos logins reais.
//   npm run ext-host:orphan-check

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEADLINE_MS = 6000;

if (process.platform === 'win32') {
  console.log('orphan-check: só Unix (grupos de processos). Ignorado.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-orphan-check-'));
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  CODEX_HOME: path.join(tmp, 'codex'),
};
fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
fs.mkdirSync(env.CODEX_HOME);

// detached = setsid: o host vira líder de grupo, como `process_group(0)` no Rust.
const child = spawn(process.execPath, [path.join(__dirname, '..', 'main.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
  detached: true,
});
const pgid = child.pid;

let buf = '';
let nextId = 1;
const waiting = new Map();
const events = [];
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.event) {
      events.push(msg);
    }
  }
});
child.stderr.on('data', () => {});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

function groupPids() {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep sai com 1 quando não acha nada
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const t0 = Date.now();
  while (!events.some((e) => e.event === 'hello')) {
    if (Date.now() - t0 > 10000) throw new Error('host não mandou hello');
    await sleep(50);
  }
  const init = await call('initialize', {
    workspaceFolders: [process.cwd()],
    dataDir: path.join(tmp, 'data'),
    appConnected: false,
  });
  const supported = init.extensions.filter((e) => e.supported);
  for (const ext of supported) {
    await call('loadExtension', { id: ext.id }).catch((err) => console.log(`  aviso: ${ext.id}: ${err.message}`));
  }
  await sleep(1500); // deixa os filhos (codex app-server) subirem
  const before = groupPids();
  console.log(`grupo ${pgid}: ${before.length} processo(s) com ${supported.map((e) => e.id).join(', ') || 'nenhuma extensão'}`);

  // "O app morreu": todos os pipes fecham ao mesmo tempo, sem `shutdown`.
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();

  const start = Date.now();
  let left = groupPids();
  while (left.length && Date.now() - start < DEADLINE_MS) {
    await sleep(100);
    left = groupPids();
  }
  if (left.length) {
    console.log(`FAIL: ${left.length} processo(s) sobreviveram após ${DEADLINE_MS} ms: ${left.join(' ')}`);
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* já foi */
    }
    return false;
  }
  console.log(`PASS: grupo encerrado em ${Date.now() - start} ms`);
  return true;
}

main()
  .then((ok) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.log(`FAIL: ${err.message}`);
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* já foi */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  });
