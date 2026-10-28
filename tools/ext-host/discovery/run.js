// Descoberta dinâmica: ativa uma extensão real no shim com o proxy de gravação,
// resolve as webview views contribuídas e imprime (JSON) os caminhos tocados.
// NÃO envia prompts a nenhum modelo: só activate() + resolveWebviewView().
//
// Uso: node tools/ext-host/discovery/run.js <pasta-da-extensão> [--data <dir>] [--workspace <dir>] [--wait <ms>]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ExtensionHost } = require('../src/host');
const { createRecorder } = require('./record');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

// A extensão escreve no stdout (console.log); o relatório JSON precisa dele limpo.
const writeOut = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

async function main() {
  const extPath = process.argv[2];
  if (!extPath) throw new Error('informe a pasta da extensão');
  const explicitDataDir = arg('--data', undefined);
  const temporary = !process.argv.includes('--data');
  const dataDir = temporary
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-ext-host-discovery-'))
    : explicitDataDir;
  let host;
  try {
    const workspace = arg('--workspace', process.cwd());
    const wait = Number(arg('--wait', '3000'));
    const recorder = createRecorder();
    const events = [];
    host = new ExtensionHost({
      dataDir,
      workspaceFolders: [workspace],
      emit: (e) => events.push(e),
      wrapApi: (api) => recorder.wrapApi(api),
    });
    await host.start();
    const ext = host.loadExtension(extPath);
    let activationError = null;
    try {
      await host.activate(ext.id);
    } catch (err) {
      activationError = err && err.stack ? err.stack : String(err);
    }
    const resolved = [];
    for (const v of ext.views) {
      if (!host.viewProviders.has(v.id)) {
        resolved.push({ viewId: v.id, registered: false });
        continue;
      }
      try {
        const info = await host.resolveView(v.id);
        const entry = host.webviews.get(info.handle);
        resolved.push({ viewId: v.id, registered: true, handle: info.handle, htmlLength: entry.webview.html.length, url: info.url });
      } catch (err) {
        resolved.push({ viewId: v.id, registered: true, error: String(err && err.stack || err) });
      }
    }
    // Simula a 1ª mensagem que o webview real envia, para gravar também a API
    // tocada no handshake (sem prompts: só init/ready).
    const PROBES = {
      'anthropic.claude-code': [{ type: 'request', channelId: '', requestId: 'discovery-1', request: { type: 'init' } }, { type: 'request', channelId: '', requestId: 'discovery-2', request: { type: 'get_claude_state' } }],
      'openai.chatgpt': [{ type: 'ready' }],
    };
    for (const r of resolved.filter((x) => x.handle).slice(0, 1)) {
      for (const m of PROBES[ext.id] || []) host.webviewMessage(r.handle, m);
    }
    await new Promise((r) => setTimeout(r, wait));
    const out = {
      extension: ext.id,
      version: ext.packageJSON.version,
      activationError,
      commandsRegistered: [...host.commands.keys()].length,
      viewProviders: [...host.viewProviders.keys()],
      contexts: Object.fromEntries(host.contexts),
      resolved,
      eventsByType: events.reduce((acc, e) => ((acc[e.event] = (acc[e.event] || 0) + 1), acc), {}),
      surface: recorder.report(),
    };
    writeOut(JSON.stringify(out, null, 2) + "\n");
  } finally {
    // O estado explícito pertence ao operador. Só removemos o default desta execução,
    // depois que deactivate() e os recursos do host terminaram de usar os arquivos.
    if (host) await host.stop().catch(() => {});
    if (temporary) fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
