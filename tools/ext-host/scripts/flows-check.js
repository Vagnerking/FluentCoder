#!/usr/bin/env node
// Aceite headless dos FLUXOS de integração com a extensão REAL do Claude Code,
// pelo mesmo protocolo stdio do app (este script faz o papel do Fluent Coder):
//
//   1. editor: documentOpened/documentChanged/editorsChanged/diagnostics →
//      conferidos pelas ferramentas MCP da PRÓPRIA extensão (getOpenEditors,
//      getCurrentSelection, getDiagnostics), como o CLI `claude` as vê;
//   2. diff: o "CLI" (WebSocket no servidor MCP da extensão, com o token do
//      lock file) chama `openDiff` → a extensão abre `vscode.diff` → o app
//      recebe `diff` → `diffAction accept` (com o lado direito editado) → a
//      extensão responde FILE_SAVED com o texto final; e `reject` → DIFF_REJECTED;
//   3. terminal: `claude-vscode.terminal.open` → `terminalCreate` →
//      `terminalOpened` → a shell integration digita a linha do `claude`;
//   4. URI handler: `fluent-coder://anthropic.claude-code/open` → painel;
//   5. diff do chat (`open_diff` da UI): barra de hunks por CommentThread
//      (comments API) — aceitar/rejeitar cada mudança pelos botões;
//   6. painéis restaurados após reiniciar: a lista persistível (`webviewPanels`)
//      sai do 1º host; um 2º host recebe `restoreWebviewPanels` e o
//      serializer do Claude Code (`claudeVSCodePanel`) e o custom editor do
//      Codex (`chatgpt.conversationEditor`, se instalado) recriam os painéis.
//
// NÃO envia prompts a modelos e não executa o `claude` (o terminal é simulado).
// Use CLAUDE_CONFIG_DIR temporário (o script cria um se não houver).
// Uso: node tools/ext-host/scripts/flows-check.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-flows-'));
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(tmp, 'claude-config');
fs.mkdirSync(configDir, { recursive: true });
const workspace = path.join(tmp, 'ws');
fs.mkdirSync(workspace);
const target = path.join(workspace, 'hello.ts');
fs.writeFileSync(target, 'export const a = 1;\nexport const b = 2;\n');

function startHost() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'main.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  const waiters = new Map();
  const listeners = [];
  const events = [];
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (process.env.VERBOSE) process.stderr.write(d);
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiters.has(msg.id)) {
      const w = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    } else if (msg.event) {
      events.push(msg);
      for (const l of [...listeners]) l(msg);
    }
  });
  return {
    child,
    events,
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
    on(fn) {
      listeners.push(fn);
    },
    waitEvent(pred, ms = 15000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
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

function rpcClient(ws) {
  let nextId = 1;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id != null && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  return {
    request(method, params, timeoutMs = 10000) {
      const id = nextId++;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return new Promise((res, rej) => {
        waiting.set(id, res);
        setTimeout(() => {
          if (waiting.delete(id)) rej(new Error(`${method}: sem resposta`));
        }, timeoutMs);
      });
    },
    notify(method, params) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    },
  };
}

async function findLock(ms) {
  const dir = path.join(configDir, 'ide');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.lock'))) {
        const lock = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if ((lock.workspaceFolders || []).some((w) => path.resolve(w) === workspace)) return { port: Number(f.replace('.lock', '')), lock };
      }
    } catch {
      /* ainda não existe */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const text = (r) => (r && r.result && Array.isArray(r.result.content) ? r.result.content.map((c) => c.text).join('\n') : JSON.stringify(r && (r.result || r.error)));

async function main() {
  const host = startHost();
  await host.waitEvent((e) => e.event === 'hello', 10000);
  // Este script é o "app": responde pedidos de UI/edição.
  host.on((e) => {
    if (e.event === 'request') host.notify('respond', { requestId: e.requestId, result: null });
  });
  const init = await host.call('initialize', { workspaceFolders: [workspace], dataDir: path.join(tmp, 'data'), appConnected: true });
  const claude = init.extensions.find((e) => e.id === 'anthropic.claude-code');
  if (!claude) {
    console.log('SKIP  Claude Code não instalado em ~/.vscode/extensions');
    await host.call('shutdown').catch(() => {});
    return;
  }
  const loaded = await host.call('loadExtension', { id: claude.id });
  check('extensão ativa', loaded.isActive, `${loaded.version}, ${loaded.activationMs} ms`);

  // ---- 1. editor espelhado (eventos, sem polling)
  host.notify('documentOpened', { path: target, text: fs.readFileSync(target, 'utf8'), version: 1, languageId: 'typescript' });
  host.notify('documentChanged', { path: target, version: 2, dirty: true, changes: [{ range: { start: { line: 1, character: 13 }, end: { line: 1, character: 14 } }, text: 'bb' }] });
  host.notify('editorsChanged', {
    active: { path: target, selections: [{ anchor: { line: 0, character: 13 }, active: { line: 0, character: 14 } }] },
    visible: [{ path: target }],
    tabs: [{ path: target, dirty: true, active: true }],
  });
  host.notify('diagnostics', { entries: [{ path: target, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, message: 'teste de diagnóstico', severity: 0, source: 'ts' }] }] });

  const found = await findLock(15000);
  check('servidor MCP da extensão no ar (lock file)', !!found, found ? `porta ${found.port}` : configDir);
  if (!found) throw new Error('sem lock file');
  const ws = await new Promise((res, rej) => {
    const s = new WebSocket(`ws://127.0.0.1:${found.port}`, { headers: { 'x-claude-code-ide-authorization': found.lock.authToken }, protocols: ['mcp'] });
    s.onopen = () => res(s);
    s.onerror = () => rej(new Error('WS recusado'));
  });
  const rpc = rpcClient(ws);
  const initRes = await rpc.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fluent-flows-check', version: '1' } });
  check('MCP initialize', !!initRes.result, initRes.result && initRes.result.serverInfo && initRes.result.serverInfo.name);
  rpc.notify('notifications/initialized', {});
  const tools = await rpc.request('tools/list', {});
  const names = (tools.result && tools.result.tools ? tools.result.tools : []).map((t) => t.name);
  check('tools/list', names.includes('openDiff'), names.join(', '));
  const call = (name, args = {}, ms) => rpc.request('tools/call', { name, arguments: args }, ms);

  await new Promise((r) => setTimeout(r, 150)); // debounce da seleção na extensão
  if (names.includes('getOpenEditors')) {
    const r = text(await call('getOpenEditors'));
    check('getOpenEditors vê a aba do app (dirty)', r.includes('hello.ts') && /isDirty"?\s*:\s*true/.test(r), r.slice(0, 160));
  }
  if (names.includes('getCurrentSelection')) {
    const r = text(await call('getCurrentSelection'));
    check('getCurrentSelection = seleção do Monaco', r.includes('"1"') || r.includes('hello.ts'), r.slice(0, 160));
  }
  if (names.includes('getDiagnostics')) {
    const r = text(await call('getDiagnostics', {}));
    check('getDiagnostics = markers do app', r.includes('teste de diagnóstico'), r.slice(0, 160));
  }
  if (names.includes('checkDocumentDirty')) {
    const r = text(await call('checkDocumentDirty', { filePath: target }));
    check('checkDocumentDirty = buffer sujo do app', /true/i.test(r), r.slice(0, 120));
  }

  // ---- 2. diff: aceitar com o lado direito editado
  const proposed = 'export const a = 1;\nexport const b = 3;\n';
  const accepting = call('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: proposed, tab_name: 'hello.ts (proposta)' }, 30000);
  const diff = await host.waitEvent((e) => e.event === 'diff' && !host.events.some((x) => x.event === 'closeDiff' && x.diffId === e.diffId), 15000);
  check('openDiff → evento diff no app', diff.right.content === proposed && diff.filePath === target, `${diff.diffId} reviewable=${diff.reviewable}`);
  const finalText = 'export const a = 1;\nexport const b = 4; // editado no app\n';
  const act = await host.call('diffAction', { diffId: diff.diffId, action: 'accept', text: finalText });
  check('Aceitar → comando da própria extensão', act.ok, act.via);
  const accepted = text(await accepting);
  check('extensão responde FILE_SAVED com o texto final', accepted.startsWith('FILE_SAVED') && accepted.includes('editado no app'), accepted.slice(0, 80).replace(/\n/g, '⏎'));
  // O CLI fecha a aba depois da resposta (close_tab) → tabGroups.close → closeDiff.
  if (names.includes('close_tab')) await call('close_tab', { tab_name: 'hello.ts (proposta)' }).catch(() => null);
  await host.waitEvent((e) => e.event === 'closeDiff' && e.diffId === diff.diffId, 5000).then(
    () => check('close_tab do CLI fecha a revisão no app (closeDiff)', true),
    () => check('close_tab do CLI fecha a revisão no app (closeDiff)', false),
  );

  // ---- 2b. diff: rejeitar
  const rejecting = call('openDiff', { old_file_path: target, new_file_path: target, new_file_contents: 'x', tab_name: 'rejeitar' }, 30000);
  const diff2 = await host.waitEvent((e) => e.event === 'diff' && e.diffId !== diff.diffId, 15000);
  const act2 = await host.call('diffAction', { diffId: diff2.diffId, action: 'reject' });
  check('Rejeitar → comando da própria extensão', act2.ok, act2.via);
  const rejected = text(await rejecting);
  check('extensão responde DIFF_REJECTED', rejected.startsWith('DIFF_REJECTED'), rejected.slice(0, 60));
  ws.close();

  // ---- 3. terminal (sem executar nada: o "app" só registra)
  host.on((e) => {
    if (e.event === 'terminalCreate') host.notify('terminalOpened', { id: e.id, pid: 4242 });
  });
  const t0 = Date.now();
  host.call('executeCommand', { command: 'claude-vscode.terminal.open', args: [] }).catch(() => {});
  try {
    const created = await host.waitEvent((e) => e.event === 'terminalCreate', 8000);
    check('createTerminal → terminal integrado', !!created.id, `${created.name}, cwd=${created.cwd === workspace ? 'workspace' : created.cwd}, env ${Object.keys(created.env || {}).length} vars`);
    const shown = await host.waitEvent((e) => e.event === 'terminalShow', 3000).catch(() => null);
    check('Terminal.show → painel', !!shown);
    const sent = await host.waitEvent((e) => e.event === 'terminalSendText' && e.id === created.id, 6000);
    check('shell integration digita o comando', /claude/.test(sent.text), `${JSON.stringify(sent.text.slice(0, 60))} em ${Date.now() - t0} ms`);
  } catch (err) {
    check('fluxo do terminal', false, err.message);
  }

  // ---- 4. URI handler (deep link)
  const before = host.events.filter((e) => e.event === 'webviewPanelCreated').length;
  const handled = await host.call('handleUri', { uri: 'fluent-coder://anthropic.claude-code/open' });
  check('handleUri roteia para a extensão', handled === true);
  await new Promise((r) => setTimeout(r, 500));
  const after = host.events.filter((e) => e.event === 'webviewPanelCreated').length;
  check('…que abre o painel do Claude Code', after > before, `${after - before} painel(is)`);

  // ---- 5. diff do CHAT (claude-vscode): barra de hunks por CommentThread
  try {
    await hunkFlow(host);
  } catch (err) {
    check('fluxo de hunks (comments API)', false, err.message);
  }

  // ---- 6. painéis voltam depois de reiniciar (serializer / custom editor)
  let restoreHost = null;
  try {
    restoreHost = await restoreFlow(host, init);
  } catch (err) {
    check('restauração de painéis', false, err.message);
  }

  await host.call('shutdown').catch(() => {});
  if (restoreHost) await restoreHost.call('shutdown').catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} verificações ok`);
  if (failed.length && !process.env.VERBOSE) console.error('--- stderr do host (cauda) ---\n' + host.stderr.split('\n').slice(-30).join('\n'));
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
}

/**
 * O 1º host publica a lista persistível dos painéis (o app a guarda); um 2º
 * host (app reiniciado) recebe `restoreWebviewPanels` e as extensões REAIS
 * recriam os painéis pelo serializer / custom editor delas.
 */
async function restoreFlow(host, init) {
  const snap = await host.waitEvent((e) => e.event === 'webviewPanels' && e.panels.some((p) => p.viewType === 'claudeVSCodePanel'), 3000);
  const latest = host.events.filter((e) => e.event === 'webviewPanels').at(-1) || snap;
  const panels = latest.panels.filter((p) => p.viewType === 'claudeVSCodePanel').slice(0, 1);
  check('lista persistível dos painéis (webviewPanels)', panels.length === 1, `${latest.panels.length} painel(is), estado ${panels[0] && panels[0].state !== undefined ? 'com' : 'sem'} setState`);
  const codex = init.extensions.find((e) => e.id === 'openai.chatgpt' && e.supported);
  if (codex) panels.push({ viewType: 'chatgpt.conversationEditor', extensionId: 'openai.chatgpt', title: 'Codex', customUri: 'openai-codex://route/extension/panel/new' });
  const h2 = startHost();
  await h2.waitEvent((e) => e.event === 'hello', 10000);
  h2.on((e) => {
    if (e.event === 'request') h2.notify('respond', { requestId: e.requestId, result: null });
  });
  await h2.call('initialize', { workspaceFolders: [workspace], dataDir: path.join(tmp, 'data'), appConnected: true });
  const t0 = Date.now();
  const r = await h2.call('restoreWebviewPanels', { panels });
  check('restoreWebviewPanels (2ª sessão)', r && r.restored === panels.length, `${r && r.restored}/${panels.length} em ${Date.now() - t0} ms`);
  const created = (vt) => h2.events.find((e) => e.event === 'webviewPanelCreated' && e.viewType === vt);
  const claudePanel = created('claudeVSCodePanel');
  check('Claude Code: deserializeWebviewPanel recria o painel (sem roubar foco)', !!claudePanel && claudePanel.preserveFocus === true);
  const html = await h2.waitEvent((e) => e.event === 'webviewHtml' && claudePanel && e.handle === claudePanel.handle, 5000).catch(() => null);
  check('…e define o HTML da UI dele', !!html && !!html.url);
  if (codex) {
    const codexPanel = created('chatgpt.conversationEditor');
    check('Codex: custom editor reaberto pela uri persistida', !!codexPanel);
    const chtml = await h2.waitEvent((e) => e.event === 'webviewHtml' && codexPanel && e.handle === codexPanel.handle, 8000).catch(() => null);
    check('…com o HTML da conversa', !!chtml);
  }
  return h2;
}

/**
 * A UI do chat pede `open_diff` (como quando o Claude propõe uma edição): a
 * extensão abre `vscode.diff` com o lado direito `_claude_vscode_fs_right:` e
 * cria um CommentThread por hunk (controller `claude-code-hunks`) com os botões
 * Aceitar/Rejeitar do menu `comments/commentThread/title`. O "app" clica nos
 * botões (`commentAction`), como o widget do Monaco faz.
 */
async function hunkFlow(host) {
  const file = path.join(workspace, 'hunks.ts');
  fs.writeFileSync(file, 'const um = 1;\nconst dois = 2;\nconst tres = 3;\nconst quatro = 4;\nconst cinco = 5;\nconst seis = 6;\nconst sete = 7;\nconst oito = 8;\n');
  const view = await host.call('resolveView', { viewId: 'claudeVSCodeSidebar' });
  const before = host.events.length;
  host.notify('webviewMessage', {
    handle: view.handle,
    message: {
      type: 'request',
      requestId: 'flows-hunk-1',
      channelId: 'flows',
      request: {
        type: 'open_diff',
        originalFilePath: file,
        newFilePath: file,
        edits: [
          { oldString: 'const um = 1;', newString: 'const um = 100;' },
          { oldString: 'const oito = 8;', newString: 'const oito = 800;' },
        ],
        supportMultiEdits: true,
        channelId: 'flows',
        diffToken: 'flows-token',
      },
    },
  });
  const diff = await host.waitEvent((e) => e.event === 'diff' && /_claude_vscode_fs_right/.test(e.right.uri), 15000);
  check('open_diff do chat → revisão com lado direito virtual', !!diff, diff.right.uri.split(':')[0]);
  const threadsOf = () => {
    const alive = new Map();
    for (const e of host.events.slice(before)) {
      if (e.event === 'commentThread' && e.uri === diff.right.uri) alive.set(e.handle, e);
      if (e.event === 'commentThreadDisposed') alive.delete(e.handle);
    }
    return [...alive.values()];
  };
  const t0 = Date.now();
  while (threadsOf().length < 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  const threads = threadsOf().sort((a, b) => a.range.start.line - b.range.start.line);
  check(
    'um CommentThread por hunk (claude-code-hunks)',
    threads.length === 2 && threads.every((t) => t.controllerId === 'claude-code-hunks' && t.actions.some((a) => a.command === 'claude-vscode.acceptProposedHunkFromBar')),
    threads.map((t) => `${t.contextValue} [${t.actions.map((a) => a.icon).join(',')}]`).join(' · '),
  );
  const deco = host.events.slice(before).find((e) => e.event === 'decorations' && e.uri === diff.right.uri);
  check('barra lateral dos hunks (decoração no lado direito)', !!deco && deco.items.length >= 1, deco ? `${deco.items.length} faixa(s)` : 'nenhuma');
  // Aceitar o 1º hunk pela barra: o thread some.
  const acc = await host.call('commentAction', { handle: threads[0].handle, command: 'claude-vscode.acceptProposedHunkFromBar' });
  await new Promise((r) => setTimeout(r, 200));
  check('Aceitar na barra → claude-vscode.acceptProposedHunkFromBar(thread)', acc.ok && !threadsOf().some((t) => t.handle === threads[0].handle), JSON.stringify(acc));
  // Rejeitar o 2º: a extensão desfaz o hunk no lado direito (applyEdit) → diffContent.
  const rej = await host.call('commentAction', { handle: threads[1].handle, command: 'claude-vscode.rejectProposedHunkFromBar' });
  const content = await host.waitEvent((e) => e.event === 'diffContent' && e.diffId === diff.diffId, 5000).catch(() => null);
  check(
    'Rejeitar na barra → hunk desfeito no lado direito (diffContent)',
    rej.ok && !!content && content.text.includes('const oito = 8;') && content.text.includes('const um = 100;'),
    content ? content.text.split('\n')[7] : JSON.stringify(rej),
  );
  await new Promise((r) => setTimeout(r, 200));
  check('sem hunks pendentes → nenhum thread', threadsOf().length === 0, `${threadsOf().length} restante(s)`);
  host.notify('diffClosed', { diffId: diff.diffId });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
