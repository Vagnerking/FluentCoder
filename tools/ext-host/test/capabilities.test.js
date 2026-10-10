'use strict';
// src/extensions/capabilities.json (lido pelo classificador da view Extensões)
// tem de refletir o shim ATUAL: mudou o shim → rode
// `node tools/ext-host/discovery/capabilities.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { build } = require('../discovery/capabilities');
const { scanExtension } = require('../discovery/api-scan');
const os = require('os');

test('capabilities.json em dia com o shim', () => {
  const file = path.join(__dirname, '..', '..', '..', 'src', 'extensions', 'capabilities.json');
  const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(build())));
  assert.equal(committed.apis['window.createWebviewPanel'], 'implemented');
  assert.equal(committed.apis['languages.registerHoverProvider'], 'stub');
  assert.equal(committed.apis['window.tabGroups'], 'partial');
  assert.equal(committed.apis['chat.createChatParticipant'], undefined, 'propostas ausentes');
});

test('api-scan: vários arquivos, apelidos, escritas e chamadas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-scan-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: './src/extension', browser: './web.js' }));
  fs.writeFileSync(path.join(dir, 'src', 'extension.js'), "const vscode = require('vscode');\nconst util = require('./util');\nvscode.commands.registerCommand('a', () => {});\n");
  fs.writeFileSync(path.join(dir, 'src', 'util.js'), "var vscode = require('vscode');\nvar window = vscode.window;\nwindow.cache = window.createOutputChannel('x');\nif (window.flag) {}\n");
  fs.writeFileSync(path.join(dir, 'web.js'), "const v = require('vscode'); v.env.webOnly();\n");
  const s = scanExtension(dir);
  const paths = Object.fromEntries(s.paths);
  assert.equal(s.filesWithApi, 2, 'o bundle web fica de fora');
  assert.equal(paths['commands.registerCommand'], 1);
  assert.equal(paths['window.createOutputChannel'], 1);
  assert.equal(paths['window.cache'], undefined, 'propriedade gravada pela extensão');
  assert.ok(s.called.includes('window.createOutputChannel'));
  assert.ok(!s.called.includes('window.flag'));
  assert.equal(paths['env.webOnly'], undefined);
});
