'use strict';
// Descoberta: pasta gerenciada pelo app (índice extensions.json) + VS Code
// (somente leitura) e o portão de compatibilidade (supported).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listInstalled } = require('../src/installed');
const { VSCODE_VERSION } = require('../src/shim/api');

function makeExt(root, folder, pkg) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { vscode: '^1.80.0' }, ...pkg }));
  return dir;
}

function setup() {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-managed-'));
  const vscode = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-vscode-'));
  return { managed, vscode };
}

const gate = (verdict, version, hostVersion = VSCODE_VERSION) => ({ verdict, version, hostVersion, evaluatedAt: 1 });

test('gerenciada vence a do VS Code; embutidas liberadas por padrão', () => {
  const { managed, vscode } = setup();
  makeExt(vscode, 'anthropic.claude-code-2.1.0', { publisher: 'anthropic', name: 'claude-code', version: '2.1.0' });
  makeExt(vscode, 'acme.tool-1.0.0', { publisher: 'acme', name: 'tool', version: '1.0.0' });
  makeExt(managed, 'acme.tool-1.2.0', { publisher: 'acme', name: 'tool', version: '1.2.0', contributes: { views: { x: [{ id: 'acme.view', type: 'webview', name: 'V' }] } }, activationEvents: ['onStartupFinished'] });
  fs.writeFileSync(
    path.join(managed, 'extensions.json'),
    JSON.stringify({ version: 1, extensions: { 'acme.tool': { id: 'acme.tool', version: '1.2.0', dir: 'acme.tool-1.2.0', targetPlatform: 'universal', enabled: true, gate: gate('compatible', '1.2.0') } }, vscode: {} }),
  );
  const list = listInstalled({ managed, vscodeDirs: [vscode] });
  const tool = list.find((e) => e.id === 'acme.tool');
  assert.equal(tool.source, 'app');
  assert.equal(tool.version, '1.2.0');
  assert.equal(tool.supported, true);
  assert.deepEqual(tool.viewIds, ['acme.view']);
  assert.equal(tool.activateOnStartup, true);
  assert.ok(Array.isArray(tool.commands));
  const claude = list.find((e) => e.id === 'anthropic.claude-code');
  assert.equal(claude.source, 'vscode');
  assert.equal(claude.supported, true);
  assert.equal(claude.label, 'Claude Code');
  assert.equal(claude.activateOnStartup, false);
});

test('portão: sem veredito, incompatível, versão/host diferente ou desabilitada não roda', () => {
  const { managed, vscode } = setup();
  makeExt(vscode, 'acme.a-1.0.0', { publisher: 'acme', name: 'a', version: '1.0.0' });
  makeExt(vscode, 'acme.b-1.0.0', { publisher: 'acme', name: 'b', version: '1.0.0' });
  makeExt(vscode, 'acme.c-1.0.0', { publisher: 'acme', name: 'c', version: '1.0.0' });
  makeExt(vscode, 'acme.d-1.0.0', { publisher: 'acme', name: 'd', version: '1.0.0' });
  makeExt(vscode, 'acme.e-1.0.0', { publisher: 'acme', name: 'e', version: '1.0.0' });
  makeExt(vscode, 'openai.chatgpt-26.1.0', { publisher: 'openai', name: 'chatgpt', version: '26.1.0' });
  fs.writeFileSync(
    path.join(managed, 'extensions.json'),
    JSON.stringify({
      version: 1,
      extensions: {},
      vscode: {
        'acme.b': { enabled: true, gate: gate('incompatible', '1.0.0') },
        'acme.c': { enabled: true, gate: gate('partial', '0.9.0') },
        'acme.d': { enabled: true, gate: gate('compatible', '1.0.0', '1.0.0') },
        'acme.e': { enabled: true, gate: gate('partial', '1.0.0') },
        'openai.chatgpt': { enabled: false },
      },
    }),
  );
  const by = Object.fromEntries(listInstalled({ managed, vscodeDirs: [vscode] }).map((e) => [e.id, e]));
  assert.equal(by['acme.a'].supported, false);
  assert.equal(by['acme.a'].blockedReason, 'disabled');
  assert.equal(by['acme.b'].blockedReason, 'incompatible');
  assert.equal(by['acme.c'].supported, false, 'veredito de outra versão não vale');
  assert.equal(by['acme.d'].supported, false, 'veredito de outro shim não vale');
  assert.equal(by['acme.e'].supported, true, 'Parcial habilitada roda');
  assert.equal(by['openai.chatgpt'].supported, false, 'embutida desabilitada');
  assert.equal(by['acme.e'].commands !== undefined, true);
  assert.equal(by['acme.a'].commands, undefined);
});

test('portão: "Não avaliada" só roda com liberação explícita da MESMA versão e do MESMO shim', () => {
  const { managed, vscode } = setup();
  for (const n of ['u1', 'u2', 'u3', 'u4', 'u5']) makeExt(vscode, `acme.${n}-1.0.0`, { publisher: 'acme', name: n, version: '1.0.0' });
  const trust = (version, hostVersion = VSCODE_VERSION) => ({ version, hostVersion, grantedAt: 1 });
  fs.writeFileSync(
    path.join(managed, 'extensions.json'),
    JSON.stringify({
      version: 1,
      extensions: {},
      vscode: {
        'acme.u1': { enabled: true, gate: gate('unknown', '1.0.0') },
        'acme.u2': { enabled: true, gate: gate('unknown', '1.0.0'), trust: trust('1.0.0') },
        'acme.u3': { enabled: true, gate: gate('unknown', '1.0.0'), trust: trust('0.9.0') },
        'acme.u4': { enabled: true, gate: gate('incompatible', '1.0.0'), trust: trust('1.0.0') },
        'acme.u5': { enabled: true, gate: gate('unknown', '1.0.0'), trust: trust('1.0.0', '1.0.0') },
      },
    }),
  );
  const by = Object.fromEntries(listInstalled({ managed, vscodeDirs: [vscode] }).map((e) => [e.id, e]));
  assert.equal(by['acme.u1'].supported, false, 'Não avaliada sem liberação não roda');
  assert.equal(by['acme.u1'].blockedReason, 'unknown');
  assert.equal(by['acme.u2'].supported, true, 'liberação explícita da mesma versão');
  assert.equal(by['acme.u2'].trusted, true);
  assert.equal(by['acme.u3'].supported, false, 'liberação de outra versão não vale');
  assert.equal(by['acme.u4'].supported, false, 'Incompatível nunca é liberável');
  assert.equal(by['acme.u5'].supported, false, 'liberação de outro shim não vale');
});

test('índice com pasta insegura ou id divergente é ignorado', () => {
  const { managed } = setup();
  makeExt(managed, 'acme.x-1.0.0', { publisher: 'acme', name: 'outra', version: '1.0.0' });
  fs.writeFileSync(
    path.join(managed, 'extensions.json'),
    JSON.stringify({
      version: 1,
      extensions: {
        'acme.x': { dir: 'acme.x-1.0.0', enabled: true },
        'acme.y': { dir: '../../etc', enabled: true },
      },
    }),
  );
  assert.deepEqual(listInstalled({ managed, vscodeDirs: [] }), []);
});
