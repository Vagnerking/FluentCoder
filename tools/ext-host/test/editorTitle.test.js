'use strict';
// Botões `editor/title` contribuídos no descritor das extensões instaladas
// (ações Claude Code/Codex na barra de ações do editor do app) e o
// `evaluateWhen` do protocolo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listInstalled } = require('../src/installed');
const { SCHEMAS } = require('../src/protocol');

function makeExt(root, folder, pkg) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { vscode: '^1.80.0' }, ...pkg }));
  return dir;
}

test('botões editor/title do grupo navigation (sem os de diff) vão no descritor', () => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-managed-'));
  const vscode = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-vscode-'));
  const dir = makeExt(vscode, 'anthropic.claude-code-2.2.0', {
    publisher: 'anthropic',
    name: 'claude-code',
    version: '2.2.0',
    contributes: {
      views: { side: [{ id: 'claudeVSCodeSidebarSecondary', type: 'webview', name: 'Claude' }] },
      commands: [
        { command: 'claude-vscode.editor.openLast', title: 'Claude Code: Open', icon: { light: 'resources/logo.svg', dark: 'resources/logo.svg' } },
        { command: 'claude-vscode.terminal.open', title: 'Open in Terminal', category: 'Claude Code', icon: '$(terminal)' },
        { command: 'claude-code.acceptProposedDiff', title: 'Accept', icon: '$(check)' },
        { command: 'x.escape', title: 'Fora', icon: '../../../etc/passwd.svg' },
      ],
      menus: {
        'editor/title': [
          { command: 'claude-code.acceptProposedDiff', when: 'claude-code.viewingProposedDiff', group: 'navigation' },
          { command: 'claude-vscode.editor.openLast', when: '!config.claudeCode.useTerminal', group: 'navigation' },
          { command: 'claude-vscode.terminal.open', when: 'config.claudeCode.useTerminal', group: 'navigation@1' },
          { command: 'x.escape', group: 'navigation' },
          { command: 'claude-vscode.editor.openLast', group: '1_more' },
        ],
      },
    },
  });
  fs.mkdirSync(path.join(dir, 'resources'));
  fs.writeFileSync(path.join(dir, 'resources', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const claude = listInstalled({ managed, vscodeDirs: [vscode] }).find((e) => e.id === 'anthropic.claude-code');
  assert.deepEqual(
    claude.editorTitle.map((a) => [a.command, a.title, a.when, a.icon && Object.keys(a.icon)[0]]),
    [
      ['claude-vscode.editor.openLast', 'Claude Code: Open', '!config.claudeCode.useTerminal', 'src'],
      ['claude-vscode.terminal.open', 'Claude Code: Open in Terminal', 'config.claudeCode.useTerminal', 'codicon'],
      // Ícone fora da pasta da extensão é ignorado (sem travessia de caminho).
      ['x.escape', 'Fora', undefined, undefined],
    ],
  );
  assert.equal(claude.editorTitle[1].icon.codicon, 'terminal');
});

test('protocolo: evaluateWhen aceita lista curta de expressões', () => {
  const v = SCHEMAS.evaluateWhen;
  assert.equal(v({ exprs: ['config.a', null] }), true);
  assert.equal(v({ exprs: 'config.a' }), false);
  assert.equal(v({ exprs: new Array(65).fill('a') }), false);
});
