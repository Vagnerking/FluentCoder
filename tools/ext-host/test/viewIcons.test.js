'use strict';
// Ícone da view no descritor das extensões instaladas (aba da view `ext:<id>`
// e activity bar no app).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listInstalled, iconSpec } = require('../src/installed');

function makeExt(root, folder, pkg) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { vscode: '^1.80.0' }, ...pkg }));
  return dir;
}

test('ícone do contêiner da view vai no descritor como data URI; fora da pasta é ignorado', () => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-managed-'));
  const vscode = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-vscode-'));
  const dir = makeExt(vscode, 'anthropic.claude-code-2.2.0', {
    publisher: 'anthropic',
    name: 'claude-code',
    version: '2.2.0',
    icon: 'resources/logo.png',
    contributes: {
      viewsContainers: { secondarySidebar: [{ id: 'side', title: 'Claude', icon: 'resources/logo.svg' }] },
      views: { side: [{ id: 'claudeVSCodeSidebarSecondary', type: 'webview', name: 'Claude' }] },
    },
  });
  fs.mkdirSync(path.join(dir, 'resources'));
  fs.writeFileSync(path.join(dir, 'resources', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const claude = listInstalled({ managed, vscodeDirs: [vscode] }).find((e) => e.id === 'anthropic.claude-code');
  assert.match(claude.icon, /^data:image\/svg\+xml;base64,/);
  assert.equal(iconSpec(dir, '../../../etc/passwd.svg'), undefined);
  assert.equal(iconSpec(dir, 'resources/nao-existe.svg'), undefined);
  assert.deepEqual(iconSpec(dir, '$(terminal)'), { codicon: 'terminal' });
  assert.match(iconSpec(dir, { light: 'x.svg', dark: 'resources/logo.svg' }).src, /^data:image\/svg/);
});
