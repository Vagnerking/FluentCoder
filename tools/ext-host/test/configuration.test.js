'use strict';
// ConfigurationStore do host: as mesmas camadas do app (src/settings/).
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConfigurationStore } = require('../src/shim/configuration');
const { validateMessage } = require('../src/protocol');

const layer = (settings = {}, overrides = {}) => ({ settings, overrides });

test('defaults batem com o app (tabSize 2, não 4)', () => {
  const c = new ConfigurationStore(null);
  assert.equal(c.getConfiguration('editor').get('tabSize'), 2);
});

test('snapshot do app: precedência default < user < workspace < pasta; linguagem por cima', () => {
  const c = new ConfigurationStore(null);
  c.setSnapshot({
    defaults: layer({ 'editor.tabSize': 2 }, { python: { 'editor.tabSize': 4 } }),
    user: layer({ 'editor.tabSize': 3 }),
    workspace: layer({ 'editor.tabSize': 5 }),
    folders: [{ root: '/w/a', layer: layer({ 'editor.tabSize': 7 }) }],
  });
  assert.equal(c.getConfiguration('editor').get('tabSize'), 5);
  const fileA = { fsPath: '/w/a/x.ts' };
  assert.equal(c.getConfiguration('editor', fileA).get('tabSize'), 7);
  assert.equal(c.getConfiguration('editor', { uri: { fsPath: '/w/b/x.py' }, languageId: 'python' }).get('tabSize'), 4);
  const i = c.getConfiguration('editor', fileA).inspect('tabSize');
  assert.equal(i.defaultValue, 2);
  assert.equal(i.globalValue, 3);
  assert.equal(i.workspaceValue, 5);
  assert.equal(i.workspaceFolderValue, 7);
  // Seção montada com as subchaves.
  assert.equal(c.getConfiguration('editor').tabSize, 5);
});

test('onDidChangeConfiguration dispara para mudanças vindas do app, com affectsConfiguration', () => {
  const c = new ConfigurationStore(null);
  c.setSnapshot({ user: layer({ 'editor.fontSize': 14 }), workspace: layer() });
  const events = [];
  c.onDidChangeConfiguration((e) => events.push(e));
  c.setSnapshot({ user: layer({ 'editor.fontSize': 16 }), workspace: layer() });
  assert.equal(events.length, 1);
  assert.equal(events[0].affectsConfiguration('editor'), true);
  assert.equal(events[0].affectsConfiguration('editor.fontSize'), true);
  assert.equal(events[0].affectsConfiguration('files'), false);
  // Snapshot igual não dispara.
  c.setSnapshot({ user: layer({ 'editor.fontSize': 16 }), workspace: layer() });
  assert.equal(events.length, 1);
});

test('update() com o app conectado vai para a camada pedida (writer)', async () => {
  const c = new ConfigurationStore(null);
  const sent = [];
  c.writer = (req) => sent.push(req);
  c.setSnapshot({ user: layer(), workspace: layer(), folders: [{ root: '/w', layer: layer() }], hasWorkspace: true });
  await c.getConfiguration('ext').update('a', 1, true);
  await c.getConfiguration('ext').update('b', 2, 2);
  await c.getConfiguration('ext', { fsPath: '/w/x' }).update('c', 3, 3);
  await c.getConfiguration('ext', { uri: { fsPath: '/w/x.ts' }, languageId: 'typescript' }).update('d', 4, 1, true);
  assert.deepEqual(
    sent.map((r) => [r.key, r.target, r.resource, r.languageId]),
    [
      ['ext.a', 'user', null, null],
      ['ext.b', 'workspace', null, null],
      ['ext.c', 'folder', '/w/x', null],
      ['ext.d', 'user', '/w/x.ts', 'typescript'],
    ],
  );
  // Otimista: já vale antes do snapshot de volta.
  assert.equal(c.getConfiguration('ext').get('a'), 1);
  assert.equal(c.getConfiguration('ext', { fsPath: '/w/x' }).get('c'), 3);
});

test('configurationDefaults [lang] das extensões', () => {
  const c = new ConfigurationStore(null);
  c.addDefaults({ contributes: { configurationDefaults: { '[markdown]': { 'editor.wordWrap': 'on' } } } });
  assert.equal(c.getConfiguration('editor', { languageId: 'markdown' }).get('wordWrap'), 'on');
  assert.equal(c.getConfiguration('editor').get('wordWrap'), 'off');
});

test('protocolo valida o método configuration', () => {
  assert.equal(validateMessage({ method: 'configuration', params: { user: layer(), workspace: layer(), folders: [] } }), null);
  assert.ok(validateMessage({ method: 'configuration', params: { user: {}, workspace: layer() } }));
});
