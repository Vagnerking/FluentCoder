'use strict';
// Gaps finais: restauração de painéis (serializer/custom editor), decorações
// (gutter/régua/before-after/isWholeLine), withProgress cancelável,
// CustomExecution/Pseudoterminal, novos threads de comentário e notebooks
// coerentes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ExtensionHost } = require('../src/host');
const { validateMessage } = require('../src/protocol');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function writeExtension(pkg, code, files = {}) {
  const dir = tmp('fake-ext-finais-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ publisher: 'fluent', version: '1.0.0', main: './extension.js', ...pkg }));
  fs.writeFileSync(path.join(dir, 'extension.js'), code);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

async function hostWith(opts = {}) {
  const events = [];
  const workspace = tmp('ws-finais-');
  const host = new ExtensionHost({ dataDir: tmp('data-finais-'), workspaceFolders: [workspace], emit: (e) => events.push(e), appConnected: !!opts.appConnected });
  await host.start();
  return { host, events, workspace };
}

const plainExtension = () => writeExtension({ name: 'plain' }, `exports.activate = () => ({ vscode: require('vscode') });`);

// ------------------------------------------------- painéis restaurados

/** Réplica do Claude Code (serializer `claudeVSCodePanel`) + custom editor do Codex. */
function panelExtension() {
  return writeExtension(
    { name: 'paineis' },
    `const vscode = require('vscode');
const revived = [];
const resolved = [];
exports.activate = (context) => {
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('sessao', {
    async deserializeWebviewPanel(panel, state) {
      revived.push({ title: panel.title, state, column: panel.viewColumn, scripts: panel.webview.options.enableScripts });
      panel.webview.html = '<html><body>restaurado</body></html>';
    },
  }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('conversa', {
    openCustomDocument: (uri) => ({ uri, dispose() {} }),
    async resolveCustomEditor(doc, panel) {
      resolved.push({ uri: doc.uri.toString(), state: panel.webview.state });
      panel.webview.html = '<html>conversa</html>';
    },
  }));
  return { vscode, revived, resolved };
};`,
  );
}

test('painéis: snapshot persistível (estado, coluna, uri do custom editor) e restauração pelo serializer', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  const dir = panelExtension();
  try {
    const ext = host.loadExtension(dir);
    const { vscode } = await host.activate(ext.id);
    const panel = vscode.window.createWebviewPanel('sessao', 'Sessão X', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file('/etc')] });
    host.setWebviewState(panel.webview.handle, { sessionID: 'abc' });
    host.setWebviewPanelState({ handle: panel.webview.handle, active: true, visible: true, viewColumn: 2 });
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse('openai-codex://route/extension/panel/new'), 'conversa', { viewColumn: 1 });
    await wait(300);
    const snap = events.filter((e) => e.event === 'webviewPanels').at(-1);
    assert.ok(snap, 'evento webviewPanels emitido (debounce)');
    const sess = snap.panels.find((p) => p.viewType === 'sessao');
    assert.deepEqual(sess.state, { sessionID: 'abc' });
    assert.equal(sess.viewColumn, 2);
    assert.equal(sess.title, 'Sessão X');
    assert.equal(sess.extensionId, ext.id);
    assert.deepEqual(sess.options, { enableScripts: true }, 'localResourceRoots não é persistido');
    const conv = snap.panels.find((p) => p.viewType === 'conversa');
    assert.equal(conv.customUri, 'openai-codex://route/extension/panel/new');
    // Protocolo aceita a lista que o app devolve; recusa lixo.
    assert.equal(validateMessage({ method: 'restoreWebviewPanels', params: { panels: snap.panels } }), null);
    assert.ok(validateMessage({ method: 'restoreWebviewPanels', params: { panels: [{ viewType: 1 }] } }));
    assert.ok(validateMessage({ method: 'restoreWebviewPanels', params: { panels: [{ viewType: 'a', extensionId: 'b', customUri: 'semesquema' }] } }));

    // Encerrar (deactivate descarta os painéis) NÃO apaga a lista persistida.
    const before = events.filter((e) => e.event === 'webviewPanels').length;
    await host.stop();
    await wait(300);
    assert.equal(events.filter((e) => e.event === 'webviewPanels').length, before);

    // Sessão nova: o app devolve a lista e a extensão restaura.
    const h2 = await hostWith({ appConnected: true });
    try {
      // Cópia nova (o require cacheia o módulo da 1ª sessão neste processo).
      const ext2 = h2.host.loadExtension(panelExtension());
      assert.equal(await h2.host.restoreWebviewPanel(sess), true);
      const exp = ext2.exports;
      assert.deepEqual(exp.revived, [{ title: 'Sessão X', state: { sessionID: 'abc' }, column: 2, scripts: true }]);
      const created = h2.events.filter((e) => e.event === 'webviewPanelCreated');
      assert.equal(created.length, 1);
      assert.equal(created[0].preserveFocus, true, 'restaurar não rouba o foco');
      assert.equal(created[0].viewColumn, 2);
      assert.ok(h2.events.some((e) => e.event === 'webviewHtml'));
      assert.equal(await h2.host.restoreWebviewPanel(conv), true);
      assert.equal(exp.resolved.at(-1).uri, 'openai-codex://route/extension/panel/new');
      // Sem serializer para o viewType: descartado.
      assert.equal(await h2.host.restoreWebviewPanel({ viewType: 'outro', extensionId: ext.id }), false);
      // Extensão que não está carregada: recusado.
      assert.equal(await h2.host.restoreWebviewPanel({ ...sess, extensionId: 'fluent.nao-existe' }), false);
    } finally {
      await h2.host.stop();
    }
  } finally {
    await host.stop().catch(() => {});
  }
});

test('painéis: deserialize que lança descarta o painel', async () => {
  const dir = writeExtension(
    { name: 'quebra' },
    `const vscode = require('vscode');
exports.activate = () => { vscode.window.registerWebviewPanelSerializer('x', { deserializeWebviewPanel() { throw new Error('boom'); } }); };`,
  );
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(dir);
    assert.equal(await host.restoreWebviewPanel({ viewType: 'x', extensionId: ext.id, title: 'T' }), false);
    assert.ok(events.some((e) => e.event === 'webviewDisposed'));
    assert.equal(host.panelSnapshot().length, 0);
  } finally {
    await host.stop();
  }
});

// ------------------------------------------------------------ decorações

test('decorações: gutterIconPath/contentIconPath viram data: URI só de raízes permitidas', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const dir = writeExtension({ name: 'decor' }, `exports.activate = () => ({ vscode: require('vscode') });`, { 'icone.svg': svg, 'grande.png': Buffer.alloc(70 * 1024) });
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(dir);
    const { vscode } = await host.activate(ext.id);
    const t = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(path.join(dir, 'icone.svg')),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: true,
      after: { contentText: ' blame', contentIconPath: path.join(dir, 'icone.svg') },
      light: { gutterIconPath: '/etc/hostname' },
    });
    const ev = events.find((e) => e.event === 'decorationType' && e.key === t.key);
    const b64 = Buffer.from(svg).toString('base64');
    assert.deepEqual(ev.options.gutterIconPath, { dataUri: `data:image/svg+xml;base64,${b64}` });
    assert.equal(ev.options.gutterIconSize, 'contain');
    assert.equal(ev.options.overviewRulerLane, 4);
    assert.deepEqual(ev.options.overviewRulerColor, { themeColor: 'editorGutter.modifiedBackground' });
    assert.equal(ev.options.isWholeLine, true);
    assert.equal(ev.options.after.contentIconPath.dataUri.startsWith('data:image/svg+xml;base64,'), true);
    assert.equal(ev.options.light.gutterIconPath, undefined, 'fora das raízes: descartado');
    // Grande demais e fora das raízes (symlink) → descartados.
    const big = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(dir, 'grande.png') });
    assert.equal(events.find((e) => e.event === 'decorationType' && e.key === big.key).options.gutterIconPath, undefined);
    fs.symlinkSync('/etc/hostname', path.join(workspace, 'fora.svg'));
    const link = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(workspace, 'fora.svg') });
    assert.equal(events.find((e) => e.event === 'decorationType' && e.key === link.key).options.gutterIconPath, undefined);
    // renderOptions por faixa (before/after com texto próprio) chegam ao app.
    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'linha 1\nlinha 2\n');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    editor.setDecorations(t, [{ range: new vscode.Range(1, 0, 1, 0), renderOptions: { after: { contentText: 'Ana, ontem', color: 'gray' } }, hoverMessage: 'oi' }]);
    const deco = events.filter((e) => e.event === 'decorations').at(-1);
    assert.deepEqual(deco.items[0].renderOptions, { after: { contentText: 'Ana, ontem', color: 'gray' } });
    assert.equal(deco.items[0].hoverMessage, 'oi');
  } finally {
    await host.stop();
  }
});

// ------------------------------------------------------ withProgress

test('withProgress: notificação cancelável, percentual acumulado e cancelProgress dispara o token', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    let cancelled = 0;
    const run = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Indexando', cancellable: true }, (p, token) => {
      token.onCancellationRequested(() => cancelled++);
      p.report({ message: 'a.ts', increment: 30 });
      p.report({ increment: 50 });
      return new Promise((resolve) => token.onCancellationRequested(() => resolve('parou')));
    });
    await wait(80);
    const evs = events.filter((e) => e.event === 'progress');
    assert.equal(evs[0].location, 'notification');
    assert.equal(evs[0].cancellable, true);
    assert.equal(evs[0].extensionName, 'plain');
    const last = evs.at(-1);
    assert.equal(last.percent, 80);
    assert.equal(last.message, 'a.ts');
    assert.equal(validateMessage({ method: 'cancelProgress', params: { id: last.id } }), null);
    assert.ok(validateMessage({ method: 'cancelProgress', params: {} }));
    assert.equal(host.progress.cancel(last.id), true);
    assert.equal(await run, 'parou');
    assert.equal(cancelled, 1);
    assert.ok(events.some((e) => e.event === 'progressEnd' && e.id === last.id));
    assert.equal(host.progress.cancel(last.id), false, 'já terminou');
    // Não cancelável: o app não consegue cancelar; Window → barra de status.
    let token2;
    const r2 = vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Sync' }, async (_p, t) => {
      token2 = t;
      await wait(20);
      throw new Error('falhou');
    });
    const id2 = events.filter((e) => e.event === 'progress').at(-1).id;
    assert.equal(events.filter((e) => e.event === 'progress').at(-1).location, 'window');
    assert.equal(host.progress.cancel(id2), false);
    await assert.rejects(r2, /falhou/);
    assert.equal(token2.isCancellationRequested, false);
    assert.ok(events.some((e) => e.event === 'progressEnd' && e.id === id2), 'termina mesmo rejeitada');
  } finally {
    await host.stop();
  }
});

// ------------------------------------------------ Pseudoterminal / CustomExecution

function fakePty(vscode, log) {
  const write = new vscode.EventEmitter();
  const close = new vscode.EventEmitter();
  const name = new vscode.EventEmitter();
  return {
    write,
    close,
    pty: {
      onDidWrite: write.event,
      onDidClose: close.event,
      onDidChangeName: name.event,
      open: (dims) => {
        log.push(['open', dims]);
        write.fire('olá\r\n');
      },
      close: () => log.push(['close']),
      handleInput: (d) => {
        log.push(['input', d]);
        if (d === 'q') close.fire(5);
        else write.fire(d);
      },
      setDimensions: (d) => log.push(['dims', d]),
    },
  };
}

test('createTerminal({ pty }): aba dirigida pela extensão (open/onDidWrite/handleInput/setDimensions/close)', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const log = [];
    const { pty } = fakePty(vscode, log);
    const term = vscode.window.createTerminal({ name: 'Pseudo', pty });
    const created = events.find((e) => e.event === 'terminalCreate');
    assert.equal(created.pseudo, true);
    assert.equal(created.shellIntegration, false);
    assert.equal(created.shellPath, undefined);
    host.terminalOpened(created.id, undefined, false, { cols: 80, rows: 24 });
    assert.deepEqual(log[0], ['open', { columns: 80, rows: 24 }]);
    assert.equal(await term.processId, undefined);
    assert.ok(events.some((e) => e.event === 'terminalPtyWrite' && e.data === 'olá\r\n'));
    host.terminalInput(created.id, 'ls');
    term.sendText('echo');
    host.terminalResize(created.id, 100, 30);
    assert.deepEqual(log.slice(1), [['input', 'ls'], ['input', 'echo\r'], ['dims', { columns: 100, rows: 30 }]]);
    // Usuário fechou a aba: pty.close() e onDidCloseTerminal.
    const closed = new Promise((r) => vscode.window.onDidCloseTerminal(r));
    host.terminalClosed(created.id, undefined);
    assert.equal(await closed, term);
    assert.deepEqual(log.at(-1), ['close']);
    // pty que encerra sozinho (onDidClose) fecha a aba.
    const log2 = [];
    const p2 = fakePty(vscode, log2);
    const t2 = vscode.window.createTerminal({ name: 'P2', pty: p2.pty });
    const c2 = events.filter((e) => e.event === 'terminalCreate').at(-1);
    host.terminalOpened(c2.id);
    const closed2 = new Promise((r) => vscode.window.onDidCloseTerminal(r));
    host.terminalInput(c2.id, 'q');
    assert.equal(await closed2, t2);
    assert.equal(t2.exitStatus.code, 5);
    const exit = events.find((e) => e.event === 'terminalPtyExit' && e.id === c2.id);
    assert.deepEqual([exit.exitCode, exit.close], [5, true]);
    assert.ok(!log2.some((l) => l[0] === 'close'), 'quem fechou foi o pty: sem close()');
    assert.equal(validateMessage({ method: 'terminalInput', params: { id: 't1', data: 'x' } }), null);
    assert.equal(validateMessage({ method: 'terminalResize', params: { id: 't1', cols: 80, rows: 24 } }), null);
    assert.ok(validateMessage({ method: 'terminalResize', params: { id: 't1', cols: 0, rows: 24 } }));
    assert.equal(validateMessage({ method: 'terminalOpened', params: { id: 't1', cols: 80, rows: 24 } }), null);
  } finally {
    await host.stop();
  }
});

test('tasks: CustomExecution roda no pseudoterminal e termina com o código do onDidClose', async () => {
  for (const appConnected of [true, false]) {
    const { host, events } = await hostWith({ appConnected });
    try {
      const ext = host.loadExtension(plainExtension());
      const { vscode } = await host.activate(ext.id);
      const log = [];
      let ctl;
      const task = new vscode.Task({ type: 'fluent', alvo: 'x' }, vscode.TaskScope.Workspace, 'Build', 'fluent', new vscode.CustomExecution(async (def) => {
        log.push(['def', def.alvo]);
        ctl = fakePty(vscode, log);
        return ctl.pty;
      }));
      const ended = new Promise((r) => vscode.tasks.onDidEndTaskProcess(r));
      const execution = await vscode.tasks.executeTask(task);
      assert.equal(vscode.tasks.taskExecutions.length, 1);
      if (appConnected) {
        const created = events.find((e) => e.event === 'terminalCreate');
        assert.equal(created.name, 'Tarefa: Build');
        assert.equal(created.pseudo, true);
        host.terminalOpened(created.id, undefined, false, { cols: 90, rows: 20 });
        assert.deepEqual(log[1], ['open', { columns: 90, rows: 20 }]);
      } else assert.deepEqual(log[1], ['open', undefined]);
      assert.deepEqual(log[0], ['def', 'x']);
      ctl.close.fire(2);
      const end = await ended;
      assert.equal(end.execution, execution);
      assert.equal(end.exitCode, 2);
      if (appConnected) assert.equal(events.find((e) => e.event === 'terminalPtyExit').close, false, 'tarefa: aba fica com a saída');
      assert.equal(vscode.tasks.taskExecutions.length, 0);
    } finally {
      await host.stop();
    }
  }
});

// ------------------------------------------------------------ comentários

/** Réplica do comment-sample do VS Code: criar, responder, editar e apagar notas. */
function notesExtension() {
  return writeExtension(
    {
      name: 'notas',
      contributes: {
        commands: [
          { command: 'notas.create', title: 'Criar nota' },
          { command: 'notas.reply', title: 'Responder' },
          { command: 'notas.edit', title: 'Editar', icon: '$(edit)' },
          { command: 'notas.delete', title: 'Apagar', icon: '$(trash)' },
          { command: 'notas.save', title: 'Salvar' },
          { command: 'notas.cancel', title: 'Cancelar' },
        ],
        menus: {
          'comments/commentThread/context': [
            { command: 'notas.create', when: 'commentController == notas && commentThreadIsEmpty', group: 'inline' },
            { command: 'notas.reply', when: 'commentController == notas && !commentThreadIsEmpty', group: 'inline' },
          ],
          'comments/comment/title': [
            { command: 'notas.edit', when: 'commentController == notas && comment == propria', group: 'inline@1' },
            { command: 'notas.delete', when: 'commentController == notas && comment == propria', group: 'inline@2' },
          ],
          'comments/comment/context': [
            { command: 'notas.save', when: 'commentController == notas', group: 'inline@1' },
            { command: 'notas.cancel', when: 'commentController == notas', group: 'inline@2' },
          ],
        },
      },
    },
    `const vscode = require('vscode');
exports.activate = (context) => {
  const ctl = vscode.comments.createCommentController('notas', 'Notas');
  ctl.options = { prompt: 'Comece uma discussão', placeHolder: 'Escreva uma nota' };
  ctl.commentingRangeProvider = { provideCommentingRanges: (doc) => [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] };
  const add = ({ thread, text }) => {
    const c = { body: new vscode.MarkdownString(text), mode: vscode.CommentMode.Preview, author: { name: 'eu' }, contextValue: 'propria', parent: thread };
    thread.comments = [...thread.comments, c];
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('notas.create', add),
    vscode.commands.registerCommand('notas.reply', add),
    vscode.commands.registerCommand('notas.edit', (c) => { c.saved = c.body; c.mode = vscode.CommentMode.Editing; c.parent.comments = [...c.parent.comments]; }),
    vscode.commands.registerCommand('notas.save', (c) => { c.mode = vscode.CommentMode.Preview; c.parent.comments = [...c.parent.comments]; }),
    vscode.commands.registerCommand('notas.cancel', (c) => { c.body = c.saved; c.mode = vscode.CommentMode.Preview; c.parent.comments = [...c.parent.comments]; }),
    vscode.commands.registerCommand('notas.delete', (c) => { const t = c.parent; t.comments = t.comments.filter((x) => x !== c); if (!t.comments.length) t.dispose(); }),
  );
};`,
  );
}

test('comentários: "+" cria thread vazio, responder, editar (corpo atualizado) e apagar a própria nota', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(notesExtension());
    await host.activate(ext.id);
    assert.ok(events.some((e) => e.event === 'commentingRangesChanged' && e.controllerId === 'notas'));
    const file = path.join(workspace, 'a.ts');
    fs.writeFileSync(file, 'a\nb\nc\n');
    const uri = `file://${file}`;
    const ranges = await host.comments.commentingRanges(uri);
    assert.equal(ranges[0].controllerId, 'notas');
    // Fora da faixa / controller errado: recusado.
    assert.equal((await host.comments.createThread({ controllerId: 'notas', uri, range: { start: { line: 50, character: 0 }, end: { line: 50, character: 0 } } })).ok, false);
    assert.equal((await host.comments.createThread({ controllerId: 'outro', uri, range: null })).ok, false);
    const r = await host.comments.createThread({ controllerId: 'notas', uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } });
    assert.equal(r.ok, true);
    await wait(1);
    let d = events.filter((e) => e.event === 'commentThread' && e.handle === r.handle).at(-1);
    assert.equal(d.isTemplate, true);
    assert.equal(d.collapsibleState, 1);
    assert.equal(d.path, file);
    assert.equal(d.prompt, 'Comece uma discussão');
    assert.equal(d.placeHolder, 'Escreva uma nota');
    assert.deepEqual(d.replyActions.map((a) => a.command), ['notas.create']);
    // Criar a nota (botão da resposta).
    assert.deepEqual(await host.comments.action({ handle: r.handle, command: 'notas.create', text: 'primeira' }), { ok: true });
    await wait(1);
    d = events.filter((e) => e.event === 'commentThread' && e.handle === r.handle).at(-1);
    assert.equal(d.isTemplate, false);
    assert.equal(d.comments[0].body, 'primeira');
    assert.deepEqual(d.comments[0].actions.map((a) => a.command), ['notas.edit', 'notas.delete']);
    assert.deepEqual(d.replyActions.map((a) => a.command), ['notas.reply']);
    assert.equal(host.comments.disposeTemplate(r.handle), false, 'com comentários: não é mais rascunho');
    // Editar → modo edição → salvar com o texto novo.
    await host.comments.action({ handle: r.handle, command: 'notas.edit', commentIndex: 0 });
    await wait(1);
    d = events.filter((e) => e.event === 'commentThread' && e.handle === r.handle).at(-1);
    assert.equal(d.comments[0].mode, 0);
    await host.comments.action({ handle: r.handle, command: 'notas.save', commentIndex: 0, text: 'editada' });
    await wait(1);
    d = events.filter((e) => e.event === 'commentThread' && e.handle === r.handle).at(-1);
    assert.equal(d.comments[0].body, 'editada');
    assert.equal(d.comments[0].mode, 1);
    assert.equal(host.comments.threads.get(r.handle).comments[0].body.value, 'editada', 'MarkdownString preservado');
    // Apagar a única nota → thread descartado pela extensão.
    await host.comments.action({ handle: r.handle, command: 'notas.delete', commentIndex: 0 });
    assert.ok(events.some((e) => e.event === 'commentThreadDisposed' && e.handle === r.handle));
    // Rascunho cancelado no app.
    const r2 = await host.comments.createThread({ controllerId: 'notas', uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
    assert.equal(host.comments.disposeTemplate(r2.handle), true);
    assert.equal(validateMessage({ method: 'commentCreateThread', params: { controllerId: 'notas', uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } }), null);
    assert.ok(validateMessage({ method: 'commentCreateThread', params: { controllerId: 'notas', uri, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } } }));
    assert.equal(validateMessage({ method: 'commentDisposeTemplate', params: { handle: 'ct1' } }), null);
  } finally {
    await host.stop();
  }
});

// ------------------------------------------------------------- notebooks

test('notebooks: openNotebookDocument lê o .ipynb (só leitura) e showNotebookDocument avisa em pt-BR', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const file = path.join(workspace, 'analise.ipynb');
    fs.writeFileSync(file, JSON.stringify({ nbformat: 4, metadata: { language_info: { name: 'python' } }, cells: [
      { cell_type: 'markdown', source: ['# Título\n', 'texto'], metadata: {} },
      { cell_type: 'code', source: 'print(1)\nx = 2', metadata: {}, outputs: [] },
    ] }));
    const opened = [];
    vscode.workspace.onDidOpenNotebookDocument((d) => opened.push(d));
    const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    assert.equal(nb.notebookType, 'jupyter-notebook');
    assert.equal(nb.cellCount, 2);
    assert.equal(nb.cellAt(0).kind, vscode.NotebookCellKind.Markup);
    assert.equal(nb.cellAt(0).document.getText(), '# Título\ntexto');
    assert.equal(nb.cellAt(1).document.languageId, 'python');
    assert.equal(nb.cellAt(1).document.lineAt(1).text, 'x = 2');
    assert.equal(nb.getCells(new vscode.NotebookRange(1, 2)).length, 1);
    assert.equal(nb.cellAt(1).document.uri.scheme, 'vscode-notebook-cell');
    assert.equal(opened[0], nb);
    assert.equal(vscode.workspace.notebookDocuments.length, 1);
    assert.equal(await vscode.workspace.openNotebookDocument(vscode.Uri.file(file)), nb, 'reaberto = mesmo documento');
    const untitled = await vscode.workspace.openNotebookDocument('jupyter-notebook', new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'a=1', 'python')]));
    assert.equal(untitled.isUntitled, true);
    assert.equal(untitled.cellAt(0).document.getText(), 'a=1');
    const editor = await vscode.window.showNotebookDocument(nb);
    assert.equal(editor.notebook, nb);
    const req = events.find((e) => e.event === 'request' && e.kind === 'showMessage');
    assert.equal(req.params.severity, 'warning');
    assert.match(req.params.message, /não tem editor de notebooks/);
    assert.equal(vscode.window.activeNotebookEditor, undefined);
    const ctl = vscode.notebooks.createNotebookController('k', 'jupyter-notebook', 'Kernel');
    const exec = ctl.createNotebookCellExecution(nb.cellAt(1));
    exec.start(Date.now());
    await exec.replaceOutput([]);
    exec.end(true);
    fs.writeFileSync(path.join(workspace, 'ruim.ipynb'), '{nao json');
    await assert.rejects(vscode.workspace.openNotebookDocument(vscode.Uri.file(path.join(workspace, 'ruim.ipynb'))), /Notebook inválido/);
  } finally {
    await host.stop();
  }
});

module.exports = { writeExtension, hostWith, wait, plainExtension };
