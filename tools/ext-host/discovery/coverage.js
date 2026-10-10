// Tabela de cobertura (markdown): caminhos `vscode.*` referenciados no bundle de
// cada extensão (varredura estática) × o que o shim implementa.
// Uso: node tools/ext-host/discovery/coverage.js <ext1/main.js> [<ext2/main.js> …]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSource } = require('./static-scan');
const { ExtensionHost } = require('../src/host');
const { createVscodeApi } = require('../src/shim/api');

const files = process.argv.slice(2);
const scans = files.map((f) => scanSource(fs.readFileSync(f, 'utf8')).paths);
const host = new ExtensionHost({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-cov-')) });
const api = createVscodeApi(host, { id: 'coverage', packageJSON: {}, extensionPath: '/' });

function status(key) {
  const parts = key.split('.');
  let cur = api;
  for (const p of parts) {
    if (cur == null || !(p in Object(cur))) return 'ausente';
    cur = cur[p];
  }
  return 'ok';
}

const keys = [...new Set(scans.flatMap((s) => [...s.keys()]))].sort((a, b) => a.localeCompare(b));
console.log(`| API | ${files.map((f) => path.basename(path.dirname(f.replace(/\/out\//, '/'))).replace(/-\d.*$/, '')).join(' | ')} | shim |`);
console.log(`|---|${files.map(() => '---:').join('|')}|---|`);
for (const k of keys) console.log(`| \`${k}\` | ${scans.map((s) => s.get(k) || '–').join(' | ')} | ${status(k)} |`);
process.exit(0);
