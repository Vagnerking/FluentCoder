'use strict';
// Testes das peças de integração do shim: editor espelhado, edições, diffs com
// comandos da extensão, terminais, watcher, segredos no cofre, URI handler,
// cláusulas `when`, contribuições, validação do protocolo e segurança do
// servidor de recursos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ExtensionHost, sanitizeDecorationOptions } = require('../src/host');
const { TextDocument, snippetToText } = require('../src/shim/documents');
const { KeyringSecretStorage } = require('../src/shim/memento');
const { WatchService } = require('../src/shim/watcher');
const { applyEnvCollections, quoteArg } = require('../src/shim/terminal');
const { evaluateWhen, configKeysIn } = require('../src/when');
const { readContributions } = require('../src/contributions');
const { validateMessage } = require('../src/protocol');
const { ResourceServer, urlPathToFsPath } = require('../src/server');
const types = require('../src/shim/types');

const { Uri, Range, Position, Selection, WorkspaceEdit } = types;

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Extensão de teste com diff, terminal, URI handler, status bar e comandos. */
function makeExtension(extra = '') {
  const dir = tmp('fake-ext2-');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'flows',
      publisher: 'fluent',
      version: '1.0.0',
      main: './extension.js',
      contributes: {
        commands: [
          { command: 'flows.accept', title: 'Accept' },
          { command: 'flows.reject', title: 'Reject' },
          { command: 'flows.hidden', title: 'Hidden' },
          { command: 'flows.hello', title: '%hello.title%', category: 'Flows' },
        ],
        menus: {
          'editor/title': [
            { command: 'flows.accept', when: 'flows.viewingDiff' },
            { command: 'flows.reject', when: 'flows.viewingDiff' },
          ],
          commandPalette: [{ command: 'flows.hidden', when: 'false' }],
        },
        keybindings: [{ command: 'flows.hello', key: 'ctrl+alt+h', mac: 'cmd+alt+h', when: 'editorTextFocus' }],
      },
    }),
  );
  fs.writeFileSync(path.join(dir, 'package.nls.json'), JSON.stringify({ 'hello.title': 'Olá' }));
  fs.writeFileSync(
    path.join(dir, 'extension.js'),
    `const vscode = require('vscode');
const files = new Map();
exports.state = { decisions: [], uris: [], hello: 0 };
exports.activate = (context) => {
  const st = exports.state;
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('flows-right', {
    onDidChangeFile: new vscode.EventEmitter().event,
    watch: () => new vscode.Disposable(() => {}),
    stat: (u) => ({ type: 1, ctime: 0, mtime: 0, size: (files.get(u.toString()) || '').length }),
    readFile: (u) => Buffer.from(files.get(u.toString()) || ''),
    writeFile: (u, c) => files.set(u.toString(), Buffer.from(c).toString()),
    readDirectory: () => [], createDirectory() {}, delete() {}, rename() {},
  }));
  const decide = (accepted) => () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    st.decisions.push({ accepted, isDiff: tab && tab.input instanceof vscode.TabInputTextDiff, text: tab ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === tab.input.modified.toString()).getText() : null });
  };
  context.subscriptions.push(vscode.commands.registerCommand('flows.accept', decide(true)));
  context.subscriptions.push(vscode.commands.registerCommand('flows.reject', decide(false)));
  context.subscriptions.push(vscode.commands.registerCommand('flows.hello', () => { st.hello++; }));
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((eds) => {
    vscode.commands.executeCommand('setContext', 'flows.viewingDiff', eds.some((e) => e.document.uri.scheme === 'flows-right'));
  }));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri(u) { st.uris.push(u.toString()); } }));
  exports.openDiff = async (left, text) => {
    const right = vscode.Uri.from({ scheme: 'flows-right', path: left.path });
    files.set(right.toString(), text);
    await vscode.commands.executeCommand('vscode.diff', left, right, 'proposta', { preview: false });
    return right;
  };
  ${extra}
  return exports;
};`,
  );
  return dir;
}

async function hostWith(opts = {}) {
  const events = [];
  const workspace = tmp('ws2-');
  const host = new ExtensionHost({ dataDir: tmp('data2-'), workspaceFolders: [workspace], emit: (e) => events.push(e), appConnected: !!opts.appConnected, secretsBackend: opts.secretsBackend });
  await host.start();
  return { host, events, workspace };
}

test('editor espelhado: documentOpened/Changed incremental, undo, editorsChanged e seleção', async () => {
  const { host, workspace } = await hostWith();
  try {
    const file = path.join(workspace, 'a.ts');
    const changes = [];
    host.events.changeDocument.event((e) => changes.push(e));
    host.documentOpened({ path: file, text: 'linha1\nlinha2\n', version: 1, languageId: 'typescript' });
    const doc = host._docForPath(file);
    assert.equal(doc.languageId, 'typescript');
    assert.ok(doc._appOwned);
    // Monaco: duas mudanças no mesmo evento (aplicadas em sequência, como o VS Code).
    host.documentChanged({
      path: file,
      version: 2,
      dirty: true,
      changes: [
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, text: 'LINHA' },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '// ' },
      ],
    });
    assert.equal(doc.getText(), '// linha1\nLINHA2\n');
    assert.equal(doc.version, 2);
    assert.ok(doc.isDirty);
    assert.equal(changes.at(-1).contentChanges.length, 2);
    assert.equal(changes.at(-1).contentChanges[0].text, 'LINHA');
    // Versão repetida é ignorada.
    host.documentChanged({ path: file, version: 2, changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'X' }] });
    assert.equal(doc.getText(), '// linha1\nLINHA2\n');
    host.documentChanged({ path: file, version: 3, reason: 'undo', changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, text: '' }] });
    assert.equal(changes.at(-1).reason, types.TextDocumentChangeReason.Undo);

    const sels = [];
    host.events.textEditorSelection.event((e) => sels.push(e));
    host.editorsChanged({ active: { path: file, selections: [{ anchor: { line: 0, character: 0 }, active: { line: 0, character: 5 } }] }, visible: [{ path: file }], tabs: [{ path: file, dirty: true, active: true }] });
    assert.equal(host.activeTextEditor.document, doc);
    assert.equal(host.activeTextEditor.document.getText(host.activeTextEditor.selection), 'linha');
    host.selectionChanged({ path: file, selections: [{ anchor: { line: 1, character: 0 }, active: { line: 1, character: 2 } }], kind: 'keyboard' });
    assert.equal(sels.at(-1).kind, types.TextEditorSelectionChangeKind.Keyboard);
    assert.equal(host.tabGroups.activeTabGroup.activeTab.isDirty, true);

    const saved = [];
    host.events.saveDocument.event((d) => saved.push(d));
    host.documentSaved({ path: file });
    assert.equal(saved.length, 1);
    assert.equal(doc.isDirty, false);
    host.documentClosed({ path: file });
    assert.equal(doc._appOwned, false);
  } finally {
    await host.stop();
  }
});

test('diagnósticos do app + coleções das extensões em getDiagnostics', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const file = path.join(workspace, 'b.ts');
    const fired = [];
    host.events.diagnostics.event((e) => fired.push(e));
    host.setDiagnostics([{ path: file, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'erro', severity: 0, source: 'ts' }] }]);
    const ext = host.loadExtension(makeExtension());
    await host.activate(ext.id);
    const coll = ext.api.languages.createDiagnosticCollection('lint');
    coll.set(Uri.file(file), [new types.Diagnostic(new Range(1, 0, 1, 2), 'aviso', 1)]);
    const list = ext.api.languages.getDiagnostics(Uri.file(file));
    assert.deepEqual(list.map((d) => d.message), ['erro', 'aviso']);
    assert.equal(list[0].source, 'ts');
    assert.ok(fired.length >= 2);
    const markers = events.find((e) => e.event === 'extDiagnostics');
    assert.equal(markers.owner, 'ext:lint');
    assert.equal(markers.path, file);
  } finally {
    await host.stop();
  }
});

test('TextEditor.edit / workspace.applyEdit vão ao modelo do app (com undo), não ao disco', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const file = path.join(workspace, 'c.ts');
    fs.writeFileSync(file, 'disco');
    host.documentOpened({ path: file, text: 'buffer', version: 5 });
    host.editorsChanged({ active: { path: file, selections: [] }, visible: [{ path: file }], tabs: [] });
    const ext = host.loadExtension(makeExtension());
    await host.activate(ext.id);
    // Responde como o app (editorBridge): aplica e devolve o texto final.
    const pending = ext.api.window.activeTextEditor.edit((b) => b.replace(new Range(0, 0, 0, 6), 'BUF'));
    const req = events.find((e) => e.event === 'request' && e.kind === 'applyEdit');
    assert.ok(req, 'pedido applyEdit ao app');
    assert.equal(req.params.edits[0].path, file);
    assert.deepEqual(req.params.edits[0].edits[0], { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'BUF' });
    assert.equal(req.params.undoStopBefore, true);
    host.respond(req.requestId, { applied: true, docs: [{ path: file, text: 'BUF', version: 6, dirty: true }] });
    assert.equal(await pending, true);
    assert.equal(host._docForPath(file).getText(), 'BUF', 'documento já atualizado quando a promise resolve');
    assert.equal(fs.readFileSync(file, 'utf8'), 'disco', 'nada gravado no disco');

    // WorkspaceEdit com criação de arquivo + edição
    const created = path.join(workspace, 'novo', 'd.ts');
    const we = new WorkspaceEdit();
    we.createFile(Uri.file(created), { ignoreIfExists: true });
    we.insert(Uri.file(file), new Position(0, 0), '>');
    const p2 = ext.api.workspace.applyEdit(we);
    await wait(20);
    const req2 = events.filter((e) => e.event === 'request' && e.kind === 'applyEdit')[1];
    host.respond(req2.requestId, { applied: true, docs: [{ path: file, text: '>BUF', version: 7 }] });
    assert.equal(await p2, true);
    assert.ok(fs.existsSync(created));
  } finally {
    await host.stop();
  }
});

test('sem app conectado, applyEdit cai no disco (headless)', async () => {
  const { host, workspace } = await hostWith();
  try {
    const file = path.join(workspace, 'e.txt');
    fs.writeFileSync(file, 'abc');
    const ext = host.loadExtension(makeExtension());
    await host.activate(ext.id);
    const we = new WorkspaceEdit();
    we.replace(Uri.file(file), new Range(0, 1, 0, 2), 'X');
    assert.equal(await ext.api.workspace.applyEdit(we), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'aXc');
  } finally {
    await host.stop();
  }
});

test('diff: tabGroups/visibleTextEditors como no VS Code e Aceitar/Rejeitar pelos comandos da extensão', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const file = path.join(workspace, 'f.ts');
    fs.writeFileSync(file, 'antes');
    const ext = host.loadExtension(makeExtension());
    const mod = await host.activate(ext.id);
    await mod.openDiff(Uri.file(file), 'depois');
    const diff = events.find((e) => e.event === 'diff');
    assert.equal(diff.left.content, 'antes');
    assert.equal(diff.right.content, 'depois');
    assert.equal(diff.filePath, file);
    assert.equal(diff.reviewable, true);
    assert.equal(diff.extensionId, 'fluent.flows');
    const active = ext.api.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(active.input instanceof ext.api.TabInputTextDiff);
    assert.equal(host.contexts.get('flows.viewingDiff'), true, 'visibleTextEditors inclui o lado direito');

    const r = await host.diffAction(diff.diffId, 'accept', 'editado');
    assert.deepEqual(r, { ok: true, via: 'flows.accept' });
    assert.deepEqual(mod.state.decisions.at(-1), { accepted: true, isDiff: true, text: 'editado' });

    const r2 = await host.diffAction(diff.diffId, 'reject');
    assert.equal(r2.via, 'flows.reject');

    // A extensão fecha a aba → closeDiff ao app e o contexto desliga.
    await ext.api.window.tabGroups.close(ext.api.window.tabGroups.activeTabGroup.activeTab);
    assert.ok(events.some((e) => e.event === 'closeDiff' && e.diffId === diff.diffId));
    assert.equal(host.contexts.get('flows.viewingDiff'), false);
    assert.equal((await host.diffAction(diff.diffId, 'accept')).ok, false);
  } finally {
    await host.stop();
  }
});

test('diff sem comando aplicável: aceitar = salvar o lado direito; rejeitar = fechar a aba', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const file = path.join(workspace, 'g.ts');
    fs.writeFileSync(file, '1');
    const ext = host.loadExtension(makeExtension());
    const mod = await host.activate(ext.id);
    const right = await mod.openDiff(Uri.file(file), '2');
    host.contexts.set('flows.viewingDiff', false); // nenhum `when` vale
    const willSave = [];
    ext.api.workspace.onWillSaveTextDocument((e) => willSave.push(e.document.getText()));
    const diff = events.find((e) => e.event === 'diff');
    const r = await host.diffAction(diff.diffId, 'accept', '22');
    assert.equal(r.via, 'save');
    assert.deepEqual(willSave, ['22']);
    assert.equal(host.documents.get(right.toString()).getText(), '22');
    const r2 = await host.diffAction(diff.diffId, 'reject');
    assert.equal(r2.via, 'close');
    assert.ok(events.some((e) => e.event === 'closeDiff'));
  } finally {
    await host.stop();
  }
});

test('terminal: createTerminal → app, pid, shell integration, sendText e onDidCloseTerminal', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(makeExtension());
    await host.activate(ext.id);
    ext.context.environmentVariableCollection.replace('CLAUDE_CODE_SSE_PORT', '1234');
    ext.context.environmentVariableCollection.prepend('PATH', '/x:');
    const opened = [];
    const closed = [];
    const integrations = [];
    const starts = [];
    ext.api.window.onDidOpenTerminal((t) => opened.push(t));
    ext.api.window.onDidCloseTerminal((t) => closed.push(t));
    ext.api.window.onDidChangeTerminalShellIntegration((e) => integrations.push(e));
    ext.api.window.onDidStartTerminalShellExecution((e) => starts.push(e));
    const term = ext.api.window.createTerminal({ name: 'Claude Code', env: { FOO: 'bar' } });
    const create = events.find((e) => e.event === 'terminalCreate');
    assert.equal(create.name, 'Claude Code');
    assert.equal(create.cwd, workspace);
    assert.equal(create.env.FOO, 'bar');
    assert.equal(create.env.CLAUDE_CODE_SSE_PORT, '1234', 'environmentVariableCollection aplicado');
    assert.ok(create.env.PATH.startsWith('/x:'));
    assert.equal(opened.length, 1);
    term.show();
    assert.ok(events.some((e) => e.event === 'terminalShow' && e.id === term.id));
    assert.equal(ext.api.window.activeTerminal, term);
    host.terminalOpened(term.id, 999);
    assert.equal(await term.processId, 999);
    assert.equal(integrations.length, 1);
    term.shellIntegration.executeCommand('claude', ['--resume', 'a b']);
    const sent = events.filter((e) => e.event === 'terminalSendText').at(-1);
    assert.equal(sent.text, "claude --resume 'a b'\r");
    await wait(5);
    assert.equal(starts.length, 1);
    term.sendText('echo 1\necho 2', true);
    assert.equal(events.filter((e) => e.event === 'terminalSendText').at(-1).text, 'echo 1\recho 2\r');
    term.dispose();
    assert.ok(events.some((e) => e.event === 'terminalDispose'));
    host.terminalClosed(term.id, 0);
    assert.equal(closed.length, 1);
    assert.deepEqual(term.exitStatus, { code: 0, reason: types.TerminalExitReason.Process });
    assert.equal(ext.api.window.terminals.length, 0);
  } finally {
    await host.stop();
  }
});

test('applyEnvCollections e quoteArg', () => {
  const coll = new Map([
    ['A', { value: '1', type: 1 }],
    ['B', { value: ':z', type: 2 }],
  ]);
  assert.deepEqual(applyEnvCollections({ B: 'y' }, [coll]), { A: '1', B: 'y:z' });
  assert.equal(quoteArg('simples'), 'simples');
  assert.equal(quoteArg("it's"), `'it'\\''s'`);
});

test('URI handler: ativa a extensão dona da autoridade (onUri) e entrega a URI', async () => {
  const { host } = await hostWith();
  try {
    const ext = host.loadExtension(makeExtension());
    assert.equal(ext.isActive, false);
    assert.equal(await host.handleUri('fluent-coder://fluent.flows/connector/oauth_callback?code=42'), true);
    assert.ok(ext.isActive);
    assert.deepEqual(ext.exports.state.uris, ['fluent-coder://fluent.flows/connector/oauth_callback?code%3D42'.replace('%3D', '=')]);
    assert.equal(await host.handleUri('fluent-coder://outra.extensao/x'), false);
    assert.equal(ext.api.env.uriScheme, 'fluent-coder');
  } finally {
    await host.stop();
  }
});

test('comandos contribuídos: Paleta (nls, escondidos), ativação por comando e atalhos com when', async () => {
  const { host } = await hostWith();
  try {
    const ext = host.loadExtension(makeExtension());
    const cmds = host.contributedCommands();
    assert.ok(cmds.some((c) => c.command === 'flows.hello' && c.title === 'Olá' && c.category === 'Flows'));
    assert.ok(!cmds.some((c) => c.command === 'flows.hidden'));
    await host.executeCommand('flows.hello');
    assert.ok(ext.isActive, 'onCommand ativa a extensão');
    assert.equal(ext.exports.state.hello, 1);
    assert.deepEqual(await host.runKeybinding('ctrl+alt+h', { editorTextFocus: false }), { handled: false });
    assert.equal((await host.runKeybinding('ctrl+alt+h', { editorTextFocus: true })).handled, process.platform !== 'darwin');
  } finally {
    await host.stop();
  }
});

test('status bar, decorações e output channel viram eventos para o app', async () => {
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(makeExtension());
    await host.activate(ext.id);
    const item = ext.api.window.createStatusBarItem('flows.status', ext.api.StatusBarAlignment.Right, 10);
    item.text = '$(sparkle) Claude';
    item.command = 'flows.hello';
    item.show();
    await wait(0);
    const ev = events.filter((e) => e.event === 'statusBarItem').at(-1);
    assert.deepEqual([ev.visible, ev.alignment, ev.priority, ev.text, ev.command.command], [true, 'right', 10, '$(sparkle) Claude', 'flows.hello']);
    item.dispose();
    assert.equal(events.filter((e) => e.event === 'statusBarItem').at(-1).visible, false);

    const deco = ext.api.window.createTextEditorDecorationType({ backgroundColor: new ext.api.ThemeColor('editor.findMatchBackground'), after: { contentText: 'dica', color: 'red;}body{' }, isWholeLine: true });
    const typeEv = events.find((e) => e.event === 'decorationType');
    assert.deepEqual(typeEv.options.backgroundColor, { themeColor: 'editor.findMatchBackground' });
    assert.equal(typeEv.options.after.color, undefined, 'valor inseguro descartado');
    const file = path.join(workspace, 'h.ts');
    host.documentOpened({ path: file, text: 'x\ny', version: 1 });
    host.editorsChanged({ active: { path: file }, visible: [{ path: file }] });
    ext.api.window.activeTextEditor.setDecorations(deco, [new Range(0, 0, 0, 1), { range: new Range(1, 0, 1, 1), hoverMessage: new ext.api.MarkdownString('oi') }]);
    const decos = events.find((e) => e.event === 'decorations');
    assert.equal(decos.items.length, 2);
    assert.equal(decos.items[1].hoverMessage, 'oi');
    deco.dispose();
    assert.ok(events.some((e) => e.event === 'decorationTypeDisposed' && e.key === typeEv.key));

    const ch = ext.api.window.createOutputChannel('Flows');
    ch.appendLine('linha 1');
    ch.show();
    host._flushOutput();
    assert.ok(events.some((e) => e.event === 'output' && e.channel === 'Flows' && e.text.includes('linha 1')));
    assert.ok(events.some((e) => e.event === 'outputShow' && e.channel === 'Flows'));

    const progress = ext.api.window.withProgress({ location: 15, title: 'Trabalhando' }, async (p) => {
      p.report({ message: 'meio' });
      return 7;
    });
    assert.equal(await progress, 7);
    const msgs = events.filter((e) => e.event === 'statusMessage');
    assert.ok(msgs.some((m) => m.text === 'Trabalhando: meio'));
    assert.equal(msgs.at(-1).text, null);
  } finally {
    await host.stop();
  }
});

test('sanitizeDecorationOptions mantém só estilo conhecido', () => {
  const o = sanitizeDecorationOptions({ backgroundColor: 'rgba(0,0,0,.2)', gutterIconPath: '/etc/passwd', color: 'x{', light: { color: 'blue' } });
  assert.deepEqual(o, { backgroundColor: 'rgba(0,0,0,.2)', light: { color: 'blue' } });
});

test('workspace.fs completo (stat com permissões, copy/rename sem sobrescrever, delete, provider)', async () => {
  const { host, workspace } = await hostWith();
  try {
    const ext = host.loadExtension(makeExtension());
    const mod = await host.activate(ext.id);
    const wfs = ext.api.workspace.fs;
    const a = Uri.file(path.join(workspace, 'a.txt'));
    const b = Uri.file(path.join(workspace, 'sub', 'b.txt'));
    await wfs.writeFile(a, Buffer.from('oi'));
    const st = await wfs.stat(a);
    assert.equal(st.type, types.FileType.File);
    assert.equal(st.size, 2);
    await wfs.copy(a, b);
    await assert.rejects(wfs.copy(a, b), (e) => e.code === 'FileExists');
    await wfs.rename(b, Uri.file(path.join(workspace, 'c.txt')));
    assert.deepEqual((await wfs.readDirectory(Uri.file(workspace))).map(([n]) => n).sort(), ['a.txt', 'c.txt', 'sub']);
    await wfs.delete(Uri.file(path.join(workspace, 'sub')), { recursive: true });
    await assert.rejects(wfs.stat(b), (e) => e.code === 'FileNotFound');
    const right = await mod.openDiff(a, 'virtual');
    assert.equal(Buffer.from(await wfs.readFile(right)).toString(), 'virtual');
    assert.equal(wfs.isWritableFileSystem('flows-right'), true);
  } finally {
    await host.stop();
  }
});

test('FileSystemWatcher: create/change/delete sem polling, filtrado pelo glob', async () => {
  const { host, workspace } = await hostWith();
  try {
    const ext = host.loadExtension(makeExtension());
    await host.activate(ext.id);
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.mkdirSync(path.join(workspace, 'node_modules', 'x'), { recursive: true });
    const seen = [];
    const w = ext.api.workspace.createFileSystemWatcher(new ext.api.RelativePattern(workspace, '**/*.ts'));
    w.onDidCreate((u) => seen.push(['create', path.basename(u.fsPath)]));
    w.onDidChange((u) => seen.push(['change', path.basename(u.fsPath)]));
    w.onDidDelete((u) => seen.push(['delete', path.basename(u.fsPath)]));
    await wait(50);
    const f = path.join(workspace, 'src', 'novo.ts');
    fs.writeFileSync(f, '1');
    fs.writeFileSync(path.join(workspace, 'src', 'ignorado.md'), 'x');
    fs.writeFileSync(path.join(workspace, 'node_modules', 'x', 'dep.ts'), 'x');
    await wait(250);
    fs.writeFileSync(f, '2');
    await wait(250);
    fs.rmSync(f);
    await wait(250);
    w.dispose();
    const kinds = seen.filter(([, n]) => n === 'novo.ts').map(([k]) => k);
    assert.equal(kinds[0], 'create');
    assert.ok(kinds.includes('change'));
    assert.equal(kinds.at(-1), 'delete');
    assert.ok(!seen.some(([, n]) => n === 'ignorado.md' || n === 'dep.ts'), 'glob e pastas pesadas filtrados');
    assert.equal(host.watchers.watchCount, 0, 'dispose libera os watches');
  } finally {
    await host.stop();
  }
});

test('WatchService: pasta-base inexistente não lança', () => {
  const ws = new WatchService();
  const off = ws.subscribe(path.join(os.tmpdir(), 'nao-existe-' + Date.now()), /.*/, true, () => {});
  off();
  ws.closeAll();
});

test('segredos: cofre do SO via backend, índice de chaves, migração do JSON e fallback', async () => {
  const dir = tmp('secrets-');
  const legacy = path.join(dir, 'secrets.json');
  fs.writeFileSync(legacy, JSON.stringify({ antigo: 'v0' }));
  const vault = new Map();
  const calls = [];
  const backend = async (op, account, value) => {
    calls.push([op, account]);
    if (op === 'store') vault.set(account, value);
    if (op === 'delete') vault.delete(account);
    return { ok: true, value: vault.get(account) ?? null };
  };
  const s = new KeyringSecretStorage({ extensionId: 'a.b', indexFile: path.join(dir, 'keys.json'), legacyFile: legacy, backend });
  const changes = [];
  s.onDidChange((e) => changes.push(e.key));
  assert.equal(await s.get('antigo'), 'v0', 'migrado');
  assert.ok(!fs.existsSync(legacy), 'JSON legado apagado após migrar');
  await s.store('token', 'segredo');
  assert.equal(vault.get('a.b/token'), 'segredo');
  assert.deepEqual((await s.keys()).sort(), ['antigo', 'token']);
  assert.ok(!fs.readFileSync(path.join(dir, 'keys.json'), 'utf8').includes('segredo'), 'índice sem valores');
  await s.delete('token');
  assert.equal(await s.get('token'), undefined);
  assert.deepEqual(changes, ['token', 'token']);

  // Cofre indisponível → arquivo 0600.
  const broken = new KeyringSecretStorage({ extensionId: 'c.d', indexFile: path.join(dir, 'k2.json'), legacyFile: path.join(dir, 's2.json'), backend: async () => ({ ok: false, error: 'sem secret service' }), log: () => {} });
  await broken.store('x', '1');
  assert.equal(await broken.get('x'), '1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 's2.json'), 'utf8')).x, '1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 's2.json')).mode & 0o777, 0o600);
});

test('rustRequest: linha começa com {"event":"secrets" (o Rust desvia pelo prefixo)', async () => {
  const lines = [];
  const host = new ExtensionHost({ dataDir: tmp('data3-'), emit: (e) => lines.push(JSON.stringify(e)), secretsBackend: 'keyring' });
  const p = host.rustRequest('secrets', { op: 'get', account: 'a.b/k' });
  assert.ok(lines[0].startsWith('{"event":"secrets","requestId":'));
  host.respond(JSON.parse(lines[0]).requestId, { ok: true, value: 'v' });
  assert.deepEqual(await p, { ok: true, value: 'v' });
});

test('cláusulas when', () => {
  const ctx = { a: true, b: false, n: 3, s: 'claudeVSCodePanel', list: ['x', 'y'], 'config.x.useTerminal': false };
  const L = (k) => ctx[k];
  assert.equal(evaluateWhen(undefined, L), true);
  assert.equal(evaluateWhen('a && !b', L), true);
  assert.equal(evaluateWhen('b || a', L), true);
  assert.equal(evaluateWhen("s == 'claudeVSCodePanel'", L), true);
  assert.equal(evaluateWhen('s == claudeVSCodePanel', L), true);
  assert.equal(evaluateWhen('s != claudeVSCodePanel', L), false);
  assert.equal(evaluateWhen('n >= 3 && n < 4', L), true);
  assert.equal(evaluateWhen('s =~ /^claude/i', L), true);
  assert.equal(evaluateWhen('item in list', (k) => (k === 'item' ? 'y' : ctx[k])), true);
  assert.equal(evaluateWhen('item not in list', (k) => (k === 'item' ? 'z' : ctx[k])), true);
  assert.equal(evaluateWhen('!config.x.useTerminal && (a || b)', L), true);
  assert.equal(evaluateWhen('desconhecida', L), false);
  assert.equal(evaluateWhen('a &&', L), false, 'erro de sintaxe → false');
  assert.equal(evaluateWhen('false', L), false);
  assert.deepEqual(configKeysIn('config.claudeCode.useTerminal && !config.a'), ['claudeCode.useTerminal', 'a']);
});

test('contribuições: comandos, keybindings por plataforma e editor/title', () => {
  const c = readContributions(
    {
      contributes: {
        commands: [{ command: 'a', title: 'A' }],
        keybindings: [{ command: 'a', key: 'ctrl+escape', mac: 'cmd+escape', linux: 'ctrl+alt+escape' }],
        menus: { 'editor/title': [{ command: 'a', when: 'x' }] },
        views: { c: [{ id: 'v', name: 'V', type: 'webview' }] },
      },
    },
    null,
  );
  assert.equal(c.commands[0].title, 'A');
  assert.equal(c.keybindings[0].key, process.platform === 'darwin' ? 'cmd+escape' : process.platform === 'linux' ? 'ctrl+alt+escape' : 'ctrl+escape');
  assert.deepEqual(c.editorTitle, [{ command: 'a', when: 'x', group: undefined }]);
  assert.equal(c.views[0].type, 'webview');
});

test('protocolo: mensagens validadas antes de tocar o host', () => {
  assert.equal(validateMessage({ id: 1, method: 'initialize', params: {} }), null);
  assert.equal(validateMessage({ id: 'w:1', method: 'listCommands' }), null);
  assert.match(validateMessage({ method: 'eval', params: {} }), /desconhecido/);
  assert.match(validateMessage({ method: 'resolveView', params: {} }), /inválidos/);
  assert.match(validateMessage({ method: 'documentChanged', params: { path: '/a', changes: [{ range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, text: '' }] } }), /inválidos/);
  assert.match(validateMessage({ method: 'handleUri', params: { uri: 'javascript:alert(1)' } }), /inválidos/);
  assert.equal(validateMessage({ method: 'handleUri', params: { uri: 'fluent-coder://a.b/c' } }), null);
  assert.match(validateMessage({ method: 'diffAction', params: { diffId: 'd1', action: 'delete' } }), /inválidos/);
  assert.match(validateMessage({ method: 'documentOpened', params: { path: 'a\0b', text: '' } }), /inválidos/);
  assert.match(validateMessage([]), /objeto/);
  assert.match(validateMessage({ id: {}, method: 'shutdown' }), /id/);
});

test('servidor: só raízes permitidas, sem escapar por symlink nem por separador codificado; CORS só da própria origem', async () => {
  const root = tmp('srv-root-');
  const outside = tmp('srv-out-');
  fs.writeFileSync(path.join(root, 'ok.js'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'segredo');
  if (process.platform !== 'win32') fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const srv = new ResourceServer({ log: () => {} });
  await srv.listen();
  try {
    srv.allowRoot(root, 'pub.ext');
    const ok = await fetch(srv.resourceUrl(path.join(root, 'ok.js')), { headers: { Origin: srv.origin } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), srv.origin);
    assert.match(ok.headers.get('cache-control'), /immutable/);
    const etag = ok.headers.get('etag');
    assert.equal((await fetch(srv.resourceUrl(path.join(root, 'ok.js')), { headers: { 'If-None-Match': etag } })).status, 304);
    const evil = await fetch(srv.resourceUrl(path.join(root, 'ok.js')), { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(srv.resourceUrl(path.join(outside, 'secret.txt')))).status, 403);
    if (process.platform !== 'win32') assert.equal((await fetch(srv.resourceUrl(path.join(root, 'link.txt')))).status, 403, 'symlink para fora');
    const encoded = `${srv.origin}/${srv.token}/res${encodeURI(root)}/..%2F${path.basename(outside)}%2Fsecret.txt`;
    assert.notEqual((await fetch(encoded)).status, 200);
    assert.equal((await fetch(`${srv.origin}/${srv.token}/res${encodeURI(root)}/ok.js`, { method: 'POST' })).status, 404);
    assert.throws(() => urlPathToFsPath('/a/b%2F..%2F..%2Fetc'));
    assert.throws(() => urlPathToFsPath('/a/b%00c'));
  } finally {
    await srv.close();
  }
});

test('snippetToText e TextDocument._update com mudança mínima', () => {
  assert.equal(snippetToText('for (${1:i} = 0; $2) {$0}'), 'for (i = 0; ) {}');
  const d = new TextDocument(Uri.file('/x.ts'), 'abc def');
  const ch = d._update('abc XYZ def');
  assert.equal(ch.length, 1);
  assert.deepEqual([ch[0].rangeOffset, ch[0].rangeLength, ch[0].text], [4, 0, 'XYZ ']);
  assert.equal(d._update('abc XYZ def'), null);
  assert.throws(() => d.lineAt(5));
  assert.equal(new Selection(0, 1, 0, 2).isEqual(new Selection(0, 1, 0, 2)), true);
});

test('CodeLens: provider da extensão → lentes por documento; clique executa o comando com os argumentos', async () => {
  const extra = `context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
    provideCodeLenses(doc) {
      const out = [];
      for (let i = 0; i < doc.lineCount; i++) if (/TODO/.test(doc.lineAt(i).text)) out.push(new vscode.CodeLens(new vscode.Range(i, 0, i, 4)));
      return out;
    },
    resolveCodeLens(lens) { lens.command = { title: 'Implementar', command: 'flows.hello', arguments: [lens.range.start.line] }; return lens; },
  }));`;
  const { host, events, workspace } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(makeExtension(extra));
    const mod = await host.activate(ext.id);
    assert.deepEqual(events.filter((e) => e.event === 'codeLensProviders').at(-1), { event: 'codeLensProviders', count: 1 });
    const file = path.join(workspace, 'todo.ts');
    host.documentOpened({ path: file, text: 'a\n// TODO: x\n', version: 1 });
    const lenses = await host.provideCodeLenses(file);
    assert.equal(lenses.length, 1);
    assert.equal(lenses[0].title, 'Implementar');
    assert.deepEqual(lenses[0].range.start, { line: 1, character: 0 });
    await host.executeCodeLens(lenses[0].id);
    assert.equal(mod.state.hello, 1);
    assert.equal(await host.executeCodeLens('desconhecida'), undefined);
  } finally {
    await host.stop();
  }
});
