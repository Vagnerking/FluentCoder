'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const { ExtensionHost } = require('../src/host');
const { fsPathToUrlPath, urlPathToFsPath } = require('../src/server');

/** Extensão de teste mínima: webview view que ecoa mensagens. */
function makeFakeExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ext-'));
  fs.mkdirSync(path.join(dir, 'media'));
  fs.writeFileSync(path.join(dir, 'media', 'main.js'), 'console.log("webview")');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fake',
      publisher: 'Fluent',
      version: '1.0.0',
      main: './extension.js',
      engines: { vscode: '^1.90.0' },
      contributes: {
        configuration: { properties: { 'fake.greeting': { type: 'string', default: 'olá' } } },
        views: { fakeContainer: [{ type: 'webview', id: 'fake.view', name: 'Fake' }] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'extension.js'),
    `const vscode = require('vscode');
exports.activate = (context) => {
  console.log('a extensão escreve no stdout');
  context.subscriptions.push(vscode.commands.registerCommand('fake.hello', () => vscode.workspace.getConfiguration('fake').get('greeting')));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('fake-left', { provideTextDocumentContent: () => 'antes' }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('fake.view', {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] };
      const script = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'));
      view.webview.html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; script-src ' + view.webview.cspSource + '"></head><body><script src="' + script + '"></script></body></html>';
      view.webview.onDidReceiveMessage((m) => view.webview.postMessage({ echo: m, version: vscode.version, appName: vscode.env.appName }));
    },
  }));
  return { api: 42 };
};`,
  );
  return dir;
}

test('host: ativa a extensão, resolve a view, serve HTML/recursos e ecoa mensagens', async () => {
  const extDir = makeFakeExtension();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  fs.writeFileSync(path.join(workspace, 'b.ts'), 'depois');
  const events = [];
  const host = new ExtensionHost({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'data-')), workspaceFolders: [workspace], emit: (e) => events.push(e) });
  const stdoutWrite = process.stdout.write;
  process.stdout.write = () => true; // o console.log da extensão
  try {
    await host.start();
    const ext = host.loadExtension(extDir);
    assert.equal(ext.id, 'fluent.fake');
    const exportsValue = await host.activate(ext.id);
    assert.deepEqual(exportsValue, { api: 42 });
    assert.equal(await host.executeCommand('fake.hello'), 'olá');
    assert.equal(host.getExtensionObject('fluent.fake').exports.api, 42);

    const info = await host.resolveView('fake.view');
    assert.equal(info.viewType, 'fake.view');
    assert.ok(info.url.startsWith(host.server.origin));

    // HTML servido com o preâmbulo antes do CSP
    const page = await (await fetch(info.url)).text();
    assert.ok(page.indexOf('acquireVsCodeApi') < page.indexOf('Content-Security-Policy'));
    // asWebviewUri → servidor local com token, caminho do recurso preservado
    const src = /<script src="([^"]+)"/.exec(page)[1];
    assert.ok(src.startsWith(`${host.server.origin}/${host.server.token}/res/`));
    const res = await fetch(src);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(await res.text(), 'console.log("webview")');
    // fora das raízes permitidas → 403; token errado → 404
    assert.equal((await fetch(host.server.resourceUrl('/etc/hostname'))).status, 403);
    assert.equal((await fetch(src.replace(host.server.token, 'x'.repeat(32)))).status, 404);
    // cspSource é a origem do servidor
    assert.ok(page.includes(`script-src ${host.server.origin}`));

    // round trip webview → extensão → webview
    host.webviewMessage(info.handle, { type: 'ping' });
    const reply = events.find((e) => e.event === 'postMessage' && e.handle === info.handle);
    assert.deepEqual(reply.message, { echo: { type: 'ping' }, version: '1.106.0', appName: 'Fluent Coder' });

    // vscode.diff resolve conteúdo de esquema virtual + arquivo
    await host.executeCommand('vscode.diff', 'fake-left:/b.ts', require('../src/shim/types').Uri.file(path.join(workspace, 'b.ts')), 'Diff de teste');
    const diff = events.find((e) => e.event === 'diff');
    assert.equal(diff.title, 'Diff de teste');
    assert.equal(diff.left.content, 'antes');
    assert.equal(diff.right.content, 'depois');
    assert.equal(host.tabGroups.all[0].tabs.length, 1);

    // estado do editor publicado pelo app → activeTextEditor
    const b = path.join(workspace, 'b.ts');
    host.documentOpened({ path: b, text: 'depois', version: 1, languageId: 'typescript' });
    host.editorsChanged({ active: { path: b, selections: [{ start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }] }, visible: [{ path: b }], tabs: [{ path: b, active: true }] });
    assert.equal(host.activeTextEditor.document.getText(host.activeTextEditor.selection), 'ep');
    // aba do arquivo + aba do diff
    assert.equal(host.tabGroups.all[0].tabs.length, 2);
  } finally {
    process.stdout.write = stdoutWrite;
    await host.stop();
  }
});

test('servidor: conversão de caminho ↔ URL', () => {
  assert.equal(fsPathToUrlPath('/a b/c#d.js'), '/a%20b/c%23d.js');
  assert.equal(urlPathToFsPath('/a%20b/c%23d.js'), path.normalize('/a b/c#d.js'));
  assert.equal(fsPathToUrlPath('C:\\x\\y.js'), '/C%3A/x/y.js');
});

test('protocolo stdio: stdout só tem JSON mesmo com a extensão usando console.log', async () => {
  const extDir = makeFakeExtension();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'main.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line); // lança se aparecer algo não-JSON
    lines.push(msg);
    if (msg.id !== undefined && waiters.has(msg.id)) waiters.get(msg.id)(msg);
  });
  child.stderr.resume();
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      waiters.set(myId, resolve);
      child.stdin.write(JSON.stringify({ id: myId, method, params }) + '\n');
    });
  try {
    const before = await call('loadExtension', { path: extDir });
    assert.match(before.error.message, /não inicializado/);
    const init = await call('initialize', { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'd-')), appConnected: false });
    assert.match(init.result.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const loaded = await call('loadExtension', { path: extDir });
    assert.equal(loaded.result.isActive, true);
    const view = await call('resolveView', { viewId: 'fake.view' });
    child.stdin.write(JSON.stringify({ method: 'webviewMessage', params: { handle: view.result.handle, message: 'oi' } }) + '\n');
    const unknown = await call('naoExiste', {});
    assert.match(unknown.error.message, /desconhecido/);
    assert.ok(lines.some((l) => l.event === 'postMessage' && l.message.echo === 'oi'));
    assert.ok(lines.some((l) => l.event === 'hello'));
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  }
});
