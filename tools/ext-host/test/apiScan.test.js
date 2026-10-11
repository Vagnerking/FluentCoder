'use strict';
// Varredura estática (discovery/api-scan.js): saída dourada dos fixtures — a
// MESMA que o espelho Rust (src-tauri/src/extensions/scan.rs) tem de produzir
// (`cargo test --lib extensions::scan`). Mudou o algoritmo: suba o
// SCANNER_VERSION nos dois e regenere `fixtures/api-scan/expected.json`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanSources, inSurface, SCANNER_VERSION } = require('../discovery/api-scan');
const { build } = require('../discovery/api-surface');
const { VSCODE_VERSION } = require('../src/shim/api');

const FIX = path.join(__dirname, 'fixtures', 'api-scan');

test('api-scan: saída dourada dos fixtures (paridade com o Rust)', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  const files = fs.readdirSync(FIX).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(Object.keys(expected).sort(), files, 'todo fixture tem saída dourada');
  for (const f of files) {
    const got = scanSources([[f, fs.readFileSync(path.join(FIX, f), 'utf8')]], f);
    assert.deepEqual(got, expected[f], f);
  }
  assert.equal(expected['esm-imports.js'].scannerVersion, SCANNER_VERSION);
});

test('api-scan: webpack, strings e ruído minificado', () => {
  const g = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  const paths = (f) => Object.fromEntries(g[f].paths);
  // `1398(e){e.exports=require("vscode")}` → `i=r(1398)`, `{window:w}=r(1398)`, `r(1398).env…`
  assert.equal(g['webpack5-object.js'].unresolved, 0);
  assert.ok(paths('webpack5-object.js')['window.createTreeView']);
  assert.ok(paths('webpack5-object.js')['env.openExternal']);
  assert.equal(paths('webpack5-object.js').Uri, 3, '`{Uri: U}` → `U.file`/`U.parse`');
  // módulos em array (webpack dev) e arrow (`398:e=>{…}`)
  assert.ok(paths('webpack-dev-array.js')['window.registerTreeDataProvider']);
  assert.equal(g['webpack-arrow.js'].typeCommand, true);
  // ids de comando em strings e identificadores minificados
  const noise = paths('strings-noise.js');
  for (const k of ['diff', 'open', 'openFolder', '_', '__esModule', 'glsl', 'deflate', 'affectsConfiguration']) assert.equal(noise[k], undefined, k);
  assert.ok(g['strings-noise.js'].ignored >= 5);
  // `require("vscode")` solto → não analisado
  assert.equal(g['unresolved.js'].unresolved, 1);
});

test('universo da API: em dia com o vscode.d.ts e >= a versão anunciada pelo shim', () => {
  const file = path.join(__dirname, '..', '..', '..', 'src', 'extensions', 'vscode-api-surface.json');
  const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(committed, build(), 'rode node tools/ext-host/discovery/api-surface.js');
  const [a, b] = [committed.vscodeVersion, VSCODE_VERSION].map((v) => v.split('.').map(Number));
  assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]))), `d.ts ${committed.vscodeVersion} < shim ${VSCODE_VERSION}`);
  assert.ok(inSurface('window', 'createWebviewPanel'));
  assert.ok(inSurface('Uri'));
  assert.ok(!inSurface('diff'));
  assert.ok(!inSurface('window', 'minhaPropriedade'));
});
