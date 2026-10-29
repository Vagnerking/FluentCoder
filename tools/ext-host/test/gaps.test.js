'use strict';
// Lacunas de compatibilidade fechadas depois do hardening: Comments API
// (barra de hunks do Claude Code), Tasks/notebooks mínimos, QuickPick/InputBox
// completos, painéis de webview como abas do editor e shell integration real
// (OSC 633) nos terminais das extensões.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ExtensionHost } = require('../src/host');
const { validateMessage } = require('../src/protocol');
const { readContributions } = require('../src/contributions');
const types = require('../src/shim/types');

const { Uri, Range } = types;

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function writeExtension(pkg, code) {
  const dir = tmp('fake-ext-gaps-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ publisher: 'fluent', version: '1.0.0', main: './extension.js', ...pkg }));
  fs.writeFileSync(path.join(dir, 'extension.js'), code);
  return dir;
}

async function hostWith(opts = {}) {
  const events = [];
  const workspace = tmp('ws-gaps-');
  const host = new ExtensionHost({ dataDir: tmp('data-gaps-'), workspaceFolders: [workspace], emit: (e) => events.push(e), appConnected: !!opts.appConnected });
  await host.start();
  return { host, events, workspace };
}

/**
 * Réplica do fluxo de hunks do Claude Code (2.1.x): o lado direito do diff
 * (`hunks-right:`) ganha um CommentThread por hunk (controller
 * `claude-code-hunks`, botões no menu `comments/commentThread/title`);
 * aceitar descarta o thread, rejeitar desfaz o hunk com `workspace.applyEdit`.
 */
function hunkExtension() {
  return writeExtension(
    {
      name: 'hunks',
      contributes: {
        commands: [
          { command: 'hunks.acceptFromBar', title: 'Accept this change', icon: '$(check)' },
          { command: 'hunks.rejectFromBar', title: 'Reject this change', icon: '$(discard)' },
          { command: 'hunks.other', title: 'Other' },
        ],
        menus: {
          'comments/commentThread/title': [
            { command: 'hunks.acceptFromBar', when: 'commentController == claude-code-hunks', group: 'inline@1' },
            { command: 'hunks.rejectFromBar', when: 'commentController == claude-code-hunks', group: 'inline@2' },
            { command: 'hunks.other', when: 'commentController == outro' },
          ],
        },
      },
    },
    `const vscode = require('vscode');
const files = new Map();
exports.state = { accepted: [], rejected: [] };
exports.activate = (context) => {
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('hunks-right', {
    onDidChangeFile: new vscode.EventEmitter().event,
    watch: () => new vscode.Disposable(() => {}),
    stat: () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
    readFile: (u) => Buffer.from(files.get(u.toString()) || ''),
    writeFile: (u, c) => files.set(u.toString(), Buffer.from(c).toString()),
    readDirectory: () => [], createDirectory() {}, delete() {}, rename() {},
  }));
  const ctl = vscode.comments.createCommentController('claude-code-hunks', 'Claude Code proposed changes');
  const threads = new Map();
  const sync = () => {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== 'hunks-right' || threads.size) continue;
      for (const line of [0, 2]) {
        const t = ctl.createCommentThread(ed.document.uri, new vscode.Range(line, 0, line, 0), []);
        t.canReply = false;
        t.label = ' ';
        t.contextValue = 'hunk:' + line + ':1';
        t.state = vscode.CommentThreadState.Resolved;
        t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        threads.set(line, t);
      }
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(sync));
  context.subscriptions.push(vscode.commands.registerCommand('hunks.acceptFromBar', (t) => {
    if (!(t.uri instanceof vscode.Uri) || !(t.range instanceof vscode.Range)) throw new Error('thread inválido');
    exports.state.accepted.push(t.contextValue);
    t.dispose();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('hunks.rejectFromBar', async (t) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === t.uri.toString());
    const e = new vscode.WorkspaceEdit();
    e.replace(doc.uri, new vscode.Range(t.range.start.line, 0, t.range.start.line, doc.lineAt(t.range.start.line).text.length), 'ORIGINAL');
    exports.state.rejected.push(await vscode.workspace.applyEdit(e));
    t.dispose();
  }));
  exports.openDiff = async (left, text) => {
    const right = vscode.Uri.from({ scheme: 'hunks-right', path: left.path });
    files.set(right.toString(), text);
    await vscode.commands.executeCommand('vscode.diff', left, right, 'proposta');
    return right;
  };
  exports.ctl = ctl;
  return exports;
};`,
  );
}

test('contributions: menus de comentários e ícone dos comandos', () => {
  const c = readContributions(JSON.parse(fs.readFileSync(path.join(hunkExtension(), 'package.json'), 'utf8')), null);
  assert.equal(c.menus['comments/commentThread/title'].length, 3);
  assert.equal(c.commands.find((x) => x.command === 'hunks.acceptFromBar').icon, '$(check)');
});

test('Comments API: threads da barra de hunks com ações, aceitar e rejeitar pelo app', async () => {
  const { host, events, workspace } = await hostWith();
  try {
    const left = path.join(workspace, 'a.ts');
    fs.writeFileSync(left, 'a\nb\nc\n');
    const ext = host.loadExtension(hunkExtension());
    const api = await host.activate(ext.id);
    const right = await api.openDiff(Uri.file(left), 'A\nb\nC\n');
    await wait(5);
    const threads = events.filter((e) => e.event === 'commentThread');
    assert.equal(threads.length, 2, 'um thread por hunk');
    const t0 = threads.find((t) => t.contextValue === 'hunk:0:1');
    assert.equal(t0.uri, right.toString());
    assert.equal(t0.controllerId, 'claude-code-hunks');
    assert.equal(t0.collapsibleState, 1);
    assert.equal(t0.canReply, false);
    assert.deepEqual(t0.range.start, { line: 0, character: 0 });
    // Só as ações cujo `when` vale, com título e codicon.
    assert.deepEqual(
      t0.actions.map((a) => [a.command, a.title, a.icon]),
      [
        ['hunks.acceptFromBar', 'Accept this change', 'check'],
        ['hunks.rejectFromBar', 'Reject this change', 'discard'],
      ],
    );
    // Comando fora do menu do thread é recusado.
    assert.equal((await host.comments.action({ handle: t0.handle, command: 'hunks.other' })).ok, false);
    // Aceitar: o comando recebe o CommentThread real.
    assert.deepEqual(await host.comments.action({ handle: t0.handle, command: 'hunks.acceptFromBar' }), { ok: true });
    assert.deepEqual(ext.exports.state.accepted, ['hunk:0:1']);
    assert.ok(events.some((e) => e.event === 'commentThreadDisposed' && e.handle === t0.handle));
    // Rejeitar: applyEdit no lado direito virtual → o app recebe o novo texto.
    const t2 = threads.find((t) => t.contextValue === 'hunk:2:1');
    assert.deepEqual(await host.comments.action({ handle: t2.handle, command: 'hunks.rejectFromBar' }), { ok: true });
    assert.deepEqual(ext.exports.state.rejected, [true]);
    const content = events.filter((e) => e.event === 'diffContent').at(-1);
    assert.equal(content.text, 'A\nb\nORIGINAL\n');
    assert.equal(host.comments.snapshot().length, 0);
    // Edição do usuário na revisão chega ao documento do host.
    const diffId = events.find((e) => e.event === 'diff').diffId;
    const changed = [];
    host.events.changeDocument.event((e) => changed.push(e.document.uri.toString()));
    assert.equal(host.diffEdited(diffId, 'A\nB\nORIGINAL\n'), true);
    assert.deepEqual(changed, [right.toString()]);
    // Controller.dispose descarta os threads restantes.
    api.ctl.createCommentThread(right, new Range(1, 0, 1, 0), [{ body: new types.MarkdownString('**oi**'), author: { name: 'Claude' }, mode: 1 }]);
    await wait(1);
    const last = events.filter((e) => e.event === 'commentThread').at(-1);
    assert.equal(last.comments[0].body, '**oi**');
    assert.equal(last.comments[0].author, 'Claude');
    api.ctl.dispose();
    assert.ok(events.some((e) => e.event === 'commentThreadDisposed' && e.handle === last.handle));
  } finally {
    await host.stop();
  }
});

test('Comments API: decorações do lado direito do diff vão ao app com o uri', async () => {
  const { host, events, workspace } = await hostWith();
  try {
    const left = path.join(workspace, 'd.ts');
    fs.writeFileSync(left, 'x\n');
    const ext = host.loadExtension(hunkExtension());
    const api = await host.activate(ext.id);
    const right = await api.openDiff(Uri.file(left), 'y\n');
    const type = ext.api.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: new types.ThemeColor('editorGutter.modifiedBackground') });
    const ed = ext.api.window.visibleTextEditors.find((e) => e.document.uri.toString() === right.toString());
    ed.setDecorations(type, [new Range(0, 0, 0, 0)]);
    const deco = events.filter((e) => e.event === 'decorations').at(-1);
    assert.equal(deco.uri, right.toString());
    assert.ok(deco.diffId);
    assert.equal(deco.items.length, 1);
  } finally {
    await host.stop();
  }
});

test('protocolo: métodos novos validados', () => {
  assert.equal(validateMessage({ method: 'commentAction', params: { handle: 'ct1', command: 'x' } }), null);
  assert.ok(validateMessage({ method: 'commentAction', params: { handle: 'ct1' } }));
  assert.equal(validateMessage({ method: 'commentReaction', params: { handle: 'ct1', commentIndex: 0, reaction: '👍' } }), null);
  assert.equal(validateMessage({ method: 'diffEdited', params: { diffId: 'diff1', text: '' } }), null);
  assert.ok(validateMessage({ method: 'diffEdited', params: { diffId: 'diff1' } }));
  assert.equal(validateMessage({ method: 'commentingRanges', params: { uri: 'file:///a.ts' } }), null);
});

// ---------------------------------------------------------------- tarefas

const taskExtension = () =>
  writeExtension(
    { name: 'tasks' },
    `const vscode = require('vscode');
exports.activate = (context) => {
  context.subscriptions.push(vscode.tasks.registerTaskProvider('fluent', {
    provideTasks: () => [new vscode.Task({ type: 'fluent' }, vscode.TaskScope.Workspace, 'sair 3', 'fluent', new vscode.ShellExecution('exit 3'))],
    resolveTask: (t) => t,
  }));
  return { vscode };
};`,
  );

test('Tasks API: provider + executeTask (headless) com onDidStart/EndTaskProcess e exitCode', async () => {
  const { host } = await hostWith();
  try {
    const ext = host.loadExtension(taskExtension());
    const { vscode } = await host.activate(ext.id);
    const tasks = await vscode.tasks.fetchTasks({ type: 'fluent' });
    assert.equal(tasks.length, 1);
    assert.equal((await vscode.tasks.fetchTasks({ type: 'outro' })).length, 0);
    const started = [];
    vscode.tasks.onDidStartTaskProcess((e) => started.push(e.processId));
    const ended = new Promise((resolve) => vscode.tasks.onDidEndTaskProcess(resolve));
    const execution = await vscode.tasks.executeTask(tasks[0]);
    assert.equal(execution.task, tasks[0]);
    assert.equal(vscode.tasks.taskExecutions.length, 1);
    const end = await ended;
    assert.equal(end.execution, execution);
    assert.equal(end.exitCode, 3);
    assert.ok(started[0] > 0, 'pid real');
    assert.equal(vscode.tasks.taskExecutions.length, 0);
    // ProcessExecution e o construtor legado de Task.
    const p = new vscode.Task({ type: 'x' }, 'eco', 'fluent', new vscode.ProcessExecution(process.execPath, ['-e', 'process.exit(0)']));
    const done = new Promise((resolve) => vscode.tasks.onDidEndTaskProcess(resolve));
    await vscode.tasks.executeTask(p);
    assert.equal((await done).exitCode, 0);
    await assert.rejects(vscode.tasks.executeTask(new vscode.Task({ type: 'x' }, 1, 'c', 's', new vscode.CustomExecution(async () => ({})))), /CustomExecution/);
  } finally {
    await host.stop();
  }
});

test('Tasks API com o app: a tarefa vira um terminal integrado e o exitCode vem do PTY', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(taskExtension());
    const { vscode } = await host.activate(ext.id);
    // Igual ao instalador WSL do Codex: ShellExecution(command, args).
    const task = new vscode.Task({ type: 'shell', id: 'x' }, vscode.TaskScope.Global, 'Instalar', 'Codex', new vscode.ShellExecution('echo', ['olá mundo']));
    const ended = new Promise((resolve) => vscode.tasks.onDidEndTaskProcess(resolve));
    const pids = [];
    vscode.tasks.onDidStartTaskProcess((e) => pids.push(e.processId));
    const execution = await vscode.tasks.executeTask(task);
    const created = events.find((e) => e.event === 'terminalCreate');
    assert.equal(created.name, 'Tarefa: Instalar');
    assert.deepEqual(created.shellArgs.slice(-1), ["echo 'olá mundo'"]);
    host.terminalOpened(created.id, 777);
    await wait(1);
    assert.deepEqual(pids, [777]);
    host.terminalClosed(created.id, 0);
    const end = await ended;
    assert.equal(end.execution, execution);
    assert.equal(end.exitCode, 0);
  } finally {
    await host.stop();
  }
});

test('notebooks: APIs presentes e inertes (sem lançar no acesso)', async () => {
  const { host } = await hostWith();
  try {
    const ext = host.loadExtension(taskExtension());
    const { vscode } = await host.activate(ext.id);
    assert.equal(vscode.window.activeNotebookEditor, undefined);
    assert.deepEqual(vscode.workspace.notebookDocuments, []);
    await assert.rejects(vscode.workspace.openNotebookDocument(Uri.file('/nao-existe.ipynb')), /ENOENT/);
    const ctl = vscode.notebooks.createNotebookController('c', 'jupyter-notebook', 'C');
    assert.equal(ctl.id, 'c');
    ctl.dispose();
    assert.equal(await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [] }), undefined);
    assert.ok(new vscode.NotebookData([]).cells);
  } finally {
    await host.stop();
  }
});

// ------------------------------------------------------- QuickPick/InputBox

const plainExtension = () => writeExtension({ name: 'plain' }, `exports.activate = () => ({ vscode: require('vscode') });`);
const lastQuickInput = (events) => events.filter((e) => e.event === 'quickInput').at(-1);

test('showQuickPick com canPickMany: itens picked pré-selecionados e devolve a lista', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const items = [{ label: 'a', picked: true }, { label: '', kind: vscode.QuickPickItemKind.Separator }, { label: 'b', description: 'desc' }, { label: 'c' }];
    const pending = vscode.window.showQuickPick(Promise.resolve(items), { canPickMany: true, title: 'Escolha', placeHolder: 'filtro' });
    await wait(5);
    const ev = lastQuickInput(events);
    assert.equal(ev.kind, 'pick');
    assert.equal(ev.canSelectMany, true);
    assert.equal(ev.title, 'Escolha');
    assert.equal(ev.busy, false, 'itens carregados');
    assert.deepEqual(ev.selectedIndexes, [0]);
    assert.equal(ev.items[1].kind, -1);
    // Separador não entra na seleção.
    host.quickInputs.event({ id: ev.id, type: 'accept', indexes: [0, 1, 2] });
    assert.deepEqual(await pending, [items[0], items[2]]);
    assert.ok(events.some((e) => e.event === 'quickInputHide' && e.id === ev.id));
  } finally {
    await host.stop();
  }
});

test('showQuickPick de strings, onDidSelectItem e Esc (hide) = undefined', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const seen = [];
    const p1 = vscode.window.showQuickPick(['x', 'y'], { onDidSelectItem: (i) => seen.push(i) });
    await wait(5);
    const ev = lastQuickInput(events);
    host.quickInputs.event({ id: ev.id, type: 'active', indexes: [1] });
    host.quickInputs.event({ id: ev.id, type: 'accept', indexes: [1] });
    assert.equal(await p1, 'y');
    assert.deepEqual(seen, ['y']);
    const p2 = vscode.window.showQuickPick(['x']);
    await wait(5);
    host.quickInputs.event({ id: lastQuickInput(events).id, type: 'hide' });
    assert.equal(await p2, undefined);
  } finally {
    await host.stop();
  }
});

test('showInputBox com validateInput: mensagem ao vivo e aceitar bloqueado com erro', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    // Como o "Rename session tab" do Claude Code.
    const pending = vscode.window.showInputBox({ prompt: 'Rename session tab', value: 'velho', validateInput: (v) => (v.trim() ? undefined : 'Enter a session name') });
    await wait(5);
    const id = lastQuickInput(events).id;
    assert.equal(lastQuickInput(events).value, 'velho');
    host.quickInputs.event({ id, type: 'value', value: '  ' });
    await wait(5);
    assert.deepEqual(lastQuickInput(events).validationMessage, { text: 'Enter a session name', severity: 3 });
    host.quickInputs.event({ id, type: 'accept' });
    await wait(5);
    assert.ok(!events.some((e) => e.event === 'quickInputHide' && e.id === id), 'continua aberto com erro');
    host.quickInputs.event({ id, type: 'value', value: 'novo' });
    await wait(5);
    assert.equal(lastQuickInput(events).validationMessage, null);
    host.quickInputs.event({ id, type: 'accept' });
    assert.equal(await pending, 'novo');
    // Aviso (severity Warning) não bloqueia; validação assíncrona.
    const p2 = vscode.window.showInputBox({ validateInput: async (v) => ({ message: `aviso ${v}`, severity: vscode.InputBoxValidationSeverity.Warning }) });
    await wait(5);
    const id2 = lastQuickInput(events).id;
    host.quickInputs.event({ id: id2, type: 'value', value: 'z' });
    await wait(5);
    assert.deepEqual(lastQuickInput(events).validationMessage, { text: 'aviso z', severity: 2 });
    host.quickInputs.event({ id: id2, type: 'accept' });
    assert.equal(await p2, 'z');
  } finally {
    await host.stop();
  }
});

test('createQuickPick/createInputBox: objetos com itens, ativos, botões, busy e eventos', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const qp = vscode.window.createQuickPick();
    const log = [];
    qp.onDidChangeValue((v) => log.push(['value', v]));
    qp.onDidChangeActive((a) => log.push(['active', a.map((i) => i.label)]));
    qp.onDidChangeSelection((a) => log.push(['selection', a.map((i) => i.label)]));
    qp.onDidTriggerButton((b) => log.push(['button', b === vscode.QuickInputButtons.Back ? 'back' : b.tooltip]));
    qp.onDidTriggerItemButton((e) => log.push(['itemButton', e.item.label, e.button.tooltip]));
    qp.onDidAccept(() => log.push(['accept']));
    qp.onDidHide(() => log.push(['hide']));
    const del = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Apagar' };
    qp.items = [{ label: 'um', buttons: [del] }, { label: 'dois' }];
    qp.buttons = [vscode.QuickInputButtons.Back, { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Atualizar' }];
    qp.busy = true;
    qp.step = 2;
    qp.totalSteps = 3;
    qp.show();
    qp.activeItems = [qp.items[1]];
    await wait(1);
    const ev = lastQuickInput(events);
    assert.equal(ev.busy, true);
    assert.equal(ev.step, 2);
    assert.deepEqual(ev.activeIndexes, [1]);
    assert.deepEqual(ev.buttons.map((b) => [b.icon, b.back]), [['arrow-left', true], ['refresh', false]]);
    assert.deepEqual(ev.items[0].buttons, [{ index: 0, icon: 'trash', tooltip: 'Apagar', back: false }]);
    host.quickInputs.event({ id: ev.id, type: 'value', value: 'do' });
    host.quickInputs.event({ id: ev.id, type: 'active', indexes: [0] });
    host.quickInputs.event({ id: ev.id, type: 'button', button: 0 });
    host.quickInputs.event({ id: ev.id, type: 'itemButton', item: 0, button: 0 });
    host.quickInputs.event({ id: ev.id, type: 'accept', indexes: [1] });
    assert.equal(qp.value, 'do');
    assert.deepEqual(qp.selectedItems.map((i) => i.label), ['dois']);
    qp.hide();
    assert.deepEqual(log, [
      ['value', 'do'],
      ['active', ['um']],
      ['button', 'back'],
      ['itemButton', 'um', 'Apagar'],
      ['selection', ['dois']],
      ['accept'],
      ['hide'],
    ]);
    // Mostrar outro esconde o anterior.
    const box = vscode.window.createInputBox();
    box.prompt = 'Nome';
    box.validationMessage = 'obrigatório';
    box.show();
    await wait(1);
    const a = vscode.window.createQuickPick();
    a.show();
    await wait(1);
    const boxEv = events.filter((e) => e.event === 'quickInput' && e.kind === 'input').at(-1);
    assert.deepEqual(boxEv.validationMessage, { text: 'obrigatório', severity: 3 });
    assert.ok(events.some((e) => e.event === 'quickInputHide' && e.id === boxEv.id));
    a.dispose();
  } finally {
    await host.stop();
  }
});

test('protocolo: quickInputEvent validado', () => {
  assert.equal(validateMessage({ method: 'quickInputEvent', params: { id: 'qi1', type: 'accept', indexes: [0, 2] } }), null);
  assert.ok(validateMessage({ method: 'quickInputEvent', params: { id: 'qi1', type: 'boom' } }));
  assert.ok(validateMessage({ method: 'quickInputEvent', params: { id: 'qi1', type: 'active', indexes: [-1] } }));
});

// ---------------------------------------------- painéis de webview como abas

test('createWebviewPanel: aba da grade (viewColumn/preserveFocus), viewState, tabGroups e dispose', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const panel = vscode.window.createWebviewPanel('claudeVSCodePanel', 'Sessão', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    const created = events.find((e) => e.event === 'webviewPanelCreated');
    assert.equal(created.viewColumn, -2);
    assert.equal(created.preserveFocus, true);
    assert.equal(created.kind, 'panel');
    assert.equal(panel.active, false, 'preserveFocus: não rouba o foco');
    const states = [];
    panel.onDidChangeViewState((e) => states.push([e.webviewPanel.active, e.webviewPanel.visible, e.webviewPanel.viewColumn]));
    // O app abriu a aba na coluna 2 e o usuário a focou.
    host.setWebviewPanelState({ handle: panel.webview.handle, active: true, visible: true, viewColumn: 2 });
    host.setWebviewPanelState({ handle: panel.webview.handle, active: true, visible: true, viewColumn: 2 }); // repetido: sem evento
    assert.deepEqual(states, [[true, true, 2]]);
    assert.equal(panel.viewColumn, 2);
    assert.equal(host.contextValue('activeWebviewPanelId'), 'claudeVSCodePanel');
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.input instanceof vscode.TabInputWebview);
    assert.equal(tab.input.viewType, 'claudeVSCodePanel');
    assert.equal(tab.label, 'Sessão');
    // Outra aba ativa no grupo: o painel fica oculto.
    host.setWebviewPanelState({ handle: panel.webview.handle, active: false, visible: false, viewColumn: 2 });
    assert.deepEqual(states.at(-1), [false, false, 2]);
    assert.equal(host.contextValue('activeWebviewPanelId'), undefined);
    // reveal → app (com a coluna pedida).
    panel.reveal(vscode.ViewColumn.One, false);
    assert.deepEqual(
      (({ handle, viewColumn, preserveFocus }) => ({ handle, viewColumn, preserveFocus }))(events.filter((e) => e.event === 'revealWebview').at(-1)),
      { handle: panel.webview.handle, viewColumn: 1, preserveFocus: false },
    );
    // Fechar a aba pela API das abas = dispose do painel.
    let disposed = 0;
    panel.onDidDispose(() => disposed++);
    const panelTab = vscode.window.tabGroups.all[0].tabs.find((t) => t.input instanceof vscode.TabInputWebview);
    await vscode.window.tabGroups.close(panelTab);
    assert.equal(disposed, 1);
    assert.ok(events.some((e) => e.event === 'webviewDisposed' && e.handle === panel.webview.handle));
    assert.ok(!vscode.window.tabGroups.all[0].tabs.some((t) => t.input instanceof vscode.TabInputWebview));
    // Fechar no app (disposeWebview) também dispara onDidDispose.
    const p2 = vscode.window.createWebviewPanel('claudePlanPreview', 'Plano', vscode.ViewColumn.One, {});
    let d2 = 0;
    p2.onDidDispose(() => d2++);
    assert.equal(p2.active, true);
    host.disposeWebview(p2.webview.handle);
    assert.equal(d2, 1);
    assert.equal(validateMessage({ method: 'webviewPanelState', params: { handle: 'wv1', active: true, visible: true, viewColumn: 2 } }), null);
    assert.ok(validateMessage({ method: 'webviewPanelState', params: { handle: 'wv1', active: 'sim', visible: true } }));
  } finally {
    await host.stop();
  }
});

// ------------------------------------------------- shell integration (OSC 633)

test('shell integration real: cwd, start/end com exitCode, read() e executeCommand', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const term = vscode.window.createTerminal({ name: 'Claude Code' });
    const created = events.find((e) => e.event === 'terminalCreate');
    assert.equal(created.shellIntegration, true, 'pede a integração ao PTY');
    const changes = [];
    vscode.window.onDidChangeTerminalShellIntegration((e) => changes.push(e.shellIntegration.cwd && e.shellIntegration.cwd.fsPath));
    host.terminalOpened(created.id, 321, true);
    assert.equal(term.shellIntegration, undefined, 'espera as sequências reais');
    host.terminalShell({ id: created.id, type: 'ready' });
    host.terminalShell({ id: created.id, type: 'cwd', cwd: '/tmp/proj' });
    assert.ok(term.shellIntegration);
    assert.equal(term.shellIntegration.cwd.fsPath, '/tmp/proj');
    assert.deepEqual(changes.at(-1), '/tmp/proj');
    // Comando digitado pelo usuário.
    const started = [];
    const ended = [];
    vscode.window.onDidStartTerminalShellExecution((e) => started.push(e));
    vscode.window.onDidEndTerminalShellExecution((e) => ended.push(e));
    host.terminalShell({ id: created.id, type: 'start', commandLine: 'ls -la' });
    const exec = started[0].execution;
    assert.equal(exec.commandLine.value, 'ls -la');
    assert.equal(exec.commandLine.confidence, vscode.TerminalShellExecutionCommandLineConfidence.High);
    const reading = (async () => {
      let out = '';
      for await (const chunk of exec.read()) out += chunk;
      return out;
    })();
    host.terminalShell({ id: created.id, type: 'data', data: 'a.txt\r\n' });
    host.terminalShell({ id: created.id, type: 'data', data: 'b.txt\r\n' });
    host.terminalShell({ id: created.id, type: 'end', exitCode: 0 });
    assert.equal(await reading, 'a.txt\r\nb.txt\r\n');
    assert.equal(ended[0].exitCode, 0);
    assert.equal(ended[0].execution, exec);
    // executeCommand: digita a linha e a execução devolvida é a do start/end real
    // (o Claude fecha o terminal quando o `claude` sai com 0).
    const mine = term.shellIntegration.executeCommand('claude', ['--resume', 'a b']);
    const sent = events.filter((e) => e.event === 'terminalSendText').at(-1);
    assert.equal(sent.text, "claude --resume 'a b'\r");
    host.terminalShell({ id: created.id, type: 'start', commandLine: "claude --resume 'a b'" });
    assert.equal(started.at(-1).execution, mine);
    host.terminalShell({ id: created.id, type: 'end', exitCode: 2 });
    assert.equal(ended.at(-1).execution, mine);
    assert.equal(ended.at(-1).exitCode, 2);
    // Fechar o PTY no meio de uma execução termina sem código.
    host.terminalShell({ id: created.id, type: 'start', commandLine: 'sleep 9' });
    host.terminalClosed(created.id, 0);
    assert.equal(ended.at(-1).exitCode, undefined);
  } finally {
    await host.stop();
  }
});

test('shell integration: sem sequências do shell, cai na simulada (executeCommand digita)', async () => {
  const { host, events } = await hostWith({ appConnected: true });
  const { REAL_INTEGRATION_WAIT_MS } = require('../src/shim/terminal');
  try {
    const ext = host.loadExtension(plainExtension());
    const { vscode } = await host.activate(ext.id);
    const term = vscode.window.createTerminal({ name: 'sh', shellPath: '/bin/sh', shellArgs: ['-i'] });
    const created = events.find((e) => e.event === 'terminalCreate');
    assert.equal(created.shellIntegration, false, 'shellArgs próprios: sem integração');
    host.terminalOpened(created.id, 1, false);
    assert.ok(term.shellIntegration, 'simulada na hora');
    const t2 = vscode.window.createTerminal('bash');
    const c2 = events.filter((e) => e.event === 'terminalCreate').at(-1);
    host.terminalOpened(c2.id, 2, true);
    assert.equal(t2.shellIntegration, undefined);
    await wait(REAL_INTEGRATION_WAIT_MS + 50);
    assert.ok(t2.shellIntegration, 'fallback simulado');
    assert.equal(validateMessage({ method: 'terminalShell', params: { id: 't1', type: 'end', exitCode: 1 } }), null);
    assert.ok(validateMessage({ method: 'terminalShell', params: { id: 't1', type: 'boom' } }));
  } finally {
    await host.stop();
  }
});

module.exports = { hostWith, writeExtension, tmp, wait };
