'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const types = require('../src/shim/types');
const { ConfigurationStore, collectDefaults } = require('../src/shim/configuration');
const { JsonMemento } = require('../src/shim/memento');
const { TextDocument } = require('../src/shim/documents');
const { globToRegExp } = require('../src/shim/api');
const { buildPreamble, injectPreamble, cssVars } = require('../src/preamble');
const { compareVersions } = require('../src/installed');

const { Uri, EventEmitter, Disposable, Position, Range, Selection } = types;

test('Uri.file/parse/joinPath/with/toString', () => {
  const u = Uri.file('/home/user/my project/a.ts');
  assert.equal(u.scheme, 'file');
  assert.equal(u.path, '/home/user/my project/a.ts');
  assert.equal(u.fsPath, '/home/user/my project/a.ts');
  assert.equal(u.toString(), 'file:///home/user/my%20project/a.ts');
  const p = Uri.parse('https://example.com:8080/a/b?x=1#frag');
  assert.equal(p.scheme, 'https');
  assert.equal(p.authority, 'example.com:8080');
  assert.equal(p.path, '/a/b');
  assert.equal(p.query, 'x=1');
  assert.equal(p.fragment, 'frag');
  assert.equal(Uri.joinPath(Uri.file('/ext'), 'webview', 'index.js').fsPath, '/ext/webview/index.js');
  assert.equal(Uri.joinPath(Uri.file('/ext/a'), '..', 'b').path, '/ext/b');
  assert.equal(u.with({ scheme: 'untitled' }).scheme, 'untitled');
  assert.equal(Uri.parse('claude-diff:/tmp/x.ts?id=1').scheme, 'claude-diff');
  assert.deepEqual(Uri.revive(JSON.parse(JSON.stringify(u))).toString(), u.toString());
  assert.ok(Uri.isUri(u));
  assert.ok(!Uri.isUri({ scheme: 'file' }));
});

test('Uri.file com drive do Windows vira caminho POSIX com barra inicial', () => {
  const u = Uri.file('C:\\Users\\me\\a.cs');
  assert.equal(u.path, '/C:/Users/me/a.cs');
  assert.equal(u.toString(), 'file:///C%3A/Users/me/a.cs');
});

test('EventEmitter: listeners, thisArgs, disposables e dispose', () => {
  const em = new EventEmitter();
  const got = [];
  const bag = [];
  const ctx = { tag: 'ctx' };
  const d = em.event(function (v) {
    got.push([this.tag, v]);
  }, ctx, bag);
  assert.equal(bag.length, 1);
  em.fire(1);
  d.dispose();
  em.fire(2);
  assert.deepEqual(got, [['ctx', 1]]);
  // um listener que lança não impede os outros
  const errLog = console.error;
  console.error = () => {};
  em.event(() => {
    throw new Error('x');
  });
  let ok = false;
  em.event(() => (ok = true));
  em.fire(3);
  console.error = errLog;
  assert.ok(ok);
  em.dispose();
  em.event(() => assert.fail('não deveria registrar após dispose'));
  em.fire(4);
});

test('Disposable.from descarta tudo uma vez só', () => {
  let n = 0;
  const d = Disposable.from({ dispose: () => n++ }, { dispose: () => n++ });
  d.dispose();
  d.dispose();
  assert.equal(n, 2);
});

test('Position/Range/Selection', () => {
  const r = new Range(5, 2, 1, 0); // invertido → normaliza
  assert.deepEqual([r.start.line, r.end.line], [1, 5]);
  assert.ok(r.contains(new Position(3, 0)));
  assert.ok(!r.isEmpty);
  const s = new Selection(4, 0, 2, 3);
  assert.ok(s.isReversed);
  assert.equal(s.anchor.line, 4);
  assert.equal(s.start.line, 2);
  assert.equal(new Position(1, 1).compareTo(new Position(1, 2)), -1);
});

test('configuração: defaults do package.json + overrides persistidos', () => {
  const pkg = {
    contributes: {
      configuration: [
        { properties: { 'claudeCode.useTerminal': { type: 'boolean', default: false }, 'claudeCode.environmentVariables': { type: 'array', default: [] } } },
        { properties: { 'chatgpt.openOnStartup': { type: 'boolean', default: true }, 'chatgpt.noDefault': { type: 'string' } } },
      ],
    },
  };
  assert.deepEqual(collectDefaults(pkg), {
    'claudeCode.useTerminal': false,
    'claudeCode.environmentVariables': [],
    'chatgpt.openOnStartup': true,
    'chatgpt.noDefault': '',
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'settings.json');
  const store = new ConfigurationStore(file);
  store.addDefaults(pkg);
  const cfg = store.getConfiguration('claudeCode');
  assert.equal(cfg.get('useTerminal'), false);
  assert.equal(cfg.get('inexistente', 'padrão'), 'padrão');
  assert.equal(store.getConfiguration().get('chatgpt.openOnStartup'), true);
  assert.deepEqual(store.getConfiguration('chat.editor').get('fontFamily'), undefined);
  // objeto montado a partir das subchaves
  assert.deepEqual(store.getConfiguration().get('chatgpt'), { openOnStartup: true, noDefault: '' });
  let changed = null;
  store.onDidChangeConfiguration((e) => (changed = e));
  cfg.update('useTerminal', true);
  assert.equal(store.getConfiguration('claudeCode').get('useTerminal'), true);
  assert.ok(changed.affectsConfiguration('claudeCode'));
  assert.ok(changed.affectsConfiguration('claudeCode.useTerminal'));
  assert.ok(!changed.affectsConfiguration('chatgpt'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'claudeCode.useTerminal': true });
  // getConfiguration devolve cópias (mutar não altera o store)
  store.getConfiguration().get('claudeCode.environmentVariables').push('x');
  assert.deepEqual(store.getConfiguration('claudeCode').get('environmentVariables'), []);
});

test('Memento persiste em JSON', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'state.json');
  const m = new JsonMemento(file);
  await m.update('a', { b: 1 });
  assert.deepEqual(new JsonMemento(file).get('a'), { b: 1 });
  await m.update('a', undefined);
  assert.deepEqual(new JsonMemento(file).keys(), []);
  assert.equal(m.get('x', 7), 7);
});

test('TextDocument: linhas, offsets e getText(range)', () => {
  const doc = new TextDocument(Uri.file('/x/a.ts'), 'abc\r\ndef\nghi');
  assert.equal(doc.languageId, 'typescript');
  assert.equal(doc.lineCount, 3);
  assert.equal(doc.lineAt(1).text, 'def');
  assert.equal(doc.offsetAt(new Position(1, 1)), 6);
  assert.deepEqual(doc.positionAt(6), new Position(1, 1));
  assert.equal(doc.getText(new Range(0, 1, 1, 2)), 'bc\r\nde');
  assert.equal(doc.getWordRangeAtPosition(new Position(2, 1)).end.character, 3);
});

test('globToRegExp cobre os padrões usados por findFiles', () => {
  assert.ok(globToRegExp('**/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/*.ts').test('b.ts'));
  assert.ok(!globToRegExp('**/*.ts').test('b.tsx'));
  assert.ok(globToRegExp('**/*.{ts,tsx}').test('a/b.tsx'));
  assert.ok(globToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/x/a.js'));
  assert.ok(globToRegExp('**/node_modules/**').test('a/node_modules/b/c.js'));
});

test('compareVersions', () => {
  assert.ok(compareVersions('2.1.296', '2.1.30') > 0);
  assert.ok(compareVersions('26.1007.21434', '26.930.1') > 0);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
});

// ------------------------------------------------------------- preâmbulo
function runPreamble(opts) {
  const html = buildPreamble({ handle: 'wv9', viewType: 'v', state: { saved: true }, themeVars: {}, themeKind: 'dark', ...opts });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const posted = [];
  const winListeners = {};
  const docListeners = {};
  const rootVars = {};
  const classes = new Set();
  const attrs = {};
  const window = {
    parent: { postMessage: (d, o) => posted.push({ d: JSON.parse(JSON.stringify(d)), o }) },
    addEventListener: (t, f) => (winListeners[t] = winListeners[t] || []).push(f),
  };
  const document = {
    addEventListener: (t, f) => (docListeners[t] = docListeners[t] || []).push(f),
    documentElement: { style: { setProperty: (k, v) => (rootVars[k] = v) } },
    body: { classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)) }, setAttribute: (k, v) => (attrs[k] = v) },
  };
  vm.runInNewContext(script, { window, document, console });
  return { window, posted, winListeners, docListeners, rootVars, classes, attrs };
}

test('acquireVsCodeApi: postMessage/getState/setState relayados ao parent', () => {
  const env = runPreamble();
  const api = env.window.acquireVsCodeApi();
  assert.throws(() => env.window.acquireVsCodeApi(), /already been acquired/);
  assert.deepEqual(JSON.parse(JSON.stringify(api.getState())), { saved: true }); // objeto de outro realm (vm)
  api.postMessage({ type: 'request', requestId: 'r1' });
  api.setState({ n: 2 });
  assert.deepEqual(api.getState(), { n: 2 });
  assert.deepEqual(env.posted.map((p) => p.d), [
    { type: 'message', message: { type: 'request', requestId: 'r1' }, __fluentExt: 1, handle: 'wv9' },
    { type: 'setState', state: { n: 2 }, __fluentExt: 1, handle: 'wv9' },
  ]);
});

test('preâmbulo consome mensagens de controle e deixa as da extensão passarem', () => {
  const env = runPreamble();
  env.docListeners.DOMContentLoaded.forEach((f) => f());
  assert.ok(env.classes.has('vscode-dark'));
  assert.equal(env.attrs['data-vscode-theme-kind'], 'vscode-dark');
  assert.deepEqual(env.posted.at(-1).d, { type: 'ready', __fluentExt: 1, handle: 'wv9' });
  let stopped = false;
  env.winListeners.message[0]({ data: { __fluentCtl: 1, type: 'theme', vars: { '--vscode-foreground': 'red', 'bad key': 'x' }, kind: 'light' }, stopImmediatePropagation: () => (stopped = true) });
  assert.ok(stopped);
  assert.equal(env.rootVars['--vscode-foreground'], 'red');
  assert.equal(env.rootVars['bad key'], undefined);
  assert.ok(env.classes.has('vscode-light'));
  assert.ok(!env.classes.has('vscode-dark'));
  stopped = false;
  env.winListeners.message[0]({ data: { type: 'from-extension' }, stopImmediatePropagation: () => (stopped = true) });
  assert.ok(!stopped, 'mensagem da extensão não pode ser engolida');
});

test('injectPreamble entra antes do CSP <meta> da extensão', () => {
  const html = '<!DOCTYPE html><html><head lang="x"><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-a\'"></head><body></body></html>';
  const out = injectPreamble(html, '<script>PRE</script>');
  assert.ok(out.indexOf('PRE') < out.indexOf('Content-Security-Policy'));
  assert.ok(out.startsWith('<!DOCTYPE html><html><head lang="x"><script>PRE'));
  assert.match(injectPreamble('<p>x</p>', 'P'), /^<!DOCTYPE html><html><head>P<\/head><body><p>x<\/p>/);
});

test('estado com </script> não quebra o preâmbulo', () => {
  const env = runPreamble({ state: { s: '</script><script>alert(1)</script>' } });
  assert.equal(env.window.acquireVsCodeApi().getState().s, '</script><script>alert(1)</script>');
  const html = buildPreamble({ handle: 'h', viewType: 'v', state: { s: '</script>' } });
  assert.equal(html.match(/<\/script>/g).length, 1);
});

test('cssVars descarta chaves/valores inseguros', () => {
  assert.equal(cssVars({ '--a': 'red', 'b': 'x', '--c': 'x;}body{', '--d': 1 }), '--a:red');
});

test('preâmbulo gerado é JavaScript válido (escapes do template não quebram o script)', () => {
  const vm = require('node:vm');
  for (const debug of [false, true]) {
    const html = buildPreamble({ handle: 'wv1', viewType: 'v', state: { s: "a'b\n</script>" }, themeVars: { '--vscode-foreground': '#fff' }, themeKind: 'dark', debug });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0);
    // Só compila (não executa): um `\n` literal dentro de string vira SyntaxError aqui.
    for (const src of scripts) assert.doesNotThrow(() => new vm.Script(src), SyntaxError);
  }
});

test('bincodec: binário sobrevive ao JSON nos dois sentidos (como o structured clone do VS Code)', () => {
  const { encodeBinary, decodeBinary } = require('../src/bincodec');
  const msg = { type: 'rpc', message: ['bytes', Buffer.from('{"a":1}')], ab: new Uint8Array([1, 2, 3]).buffer, f: new Float32Array([1.5]), keep: { n: 1, s: 'x', d: null } };
  const wire = JSON.parse(JSON.stringify(encodeBinary(msg)));
  assert.equal(wire.message[1].__fluentBin, 'Uint8Array');
  const back = decodeBinary(wire);
  assert.ok(back.message[1] instanceof Uint8Array);
  assert.equal(Buffer.from(back.message[1]).toString(), '{"a":1}');
  assert.ok(back.ab instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(back.ab)], [1, 2, 3]);
  assert.ok(back.f instanceof Float32Array);
  assert.equal(back.f[0], 1.5);
  assert.deepEqual(back.keep, msg.keep);
  // Sem binário: a mesma referência (nada de cópia à toa no caminho quente).
  const plain = { a: [1, { b: 'c' }] };
  assert.equal(encodeBinary(plain), plain);
  assert.equal(decodeBinary(plain), plain);
});
