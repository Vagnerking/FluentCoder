// Varredura estática de uma extensão INSTALADA para o classificador de
// compatibilidade — espelho JS de `scan_extension` em
// src-tauri/src/extensions/store.rs (o app usa o Rust; este serve os scripts
// headless e a conferência cruzada). Em relação a `static-scan.js` (que gera a
// tabela de docs/research): vários arquivos (.js/.cjs, inclusive node_modules),
// apelidos de namespace (`const window = vscode.window`) e propriedades que a
// própria extensão grava no namespace (`window.x = …`, que não são API).
// Uso: node api-scan.js <pasta-da-extensão>
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_SCAN_BYTES = 64 << 20;
const MAX_SCAN_FILE = 16 << 20;
const SKIP_DIRS = new Set(['@types', 'typescript', '.git', 'webview', 'webview-ui', 'media']);
const esc = (s) => s.replace(/[$]/g, '\\$');

function scanInto(src, acc) {
  const bind = /([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\()?require\(\s*["']vscode["']\s*\)/g;
  const names = [...new Set([...src.matchAll(bind)].map((m) => m[1]))].sort();
  if (!names.length) return;
  acc.files++;
  acc.bindings += names.length;
  const aliases = [];
  for (const n of names) {
    for (const m of src.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${esc(n)}\\.([a-z][\\w$]*)\\s*[;,)\\n]`, 'g'))) aliases.push([m[1], m[2]]);
  }
  const lookups = [...names.map((n) => [n, null]), ...aliases];
  for (const [n, ns] of lookups) {
    const re = new RegExp(`(?:^|[^\\w$.])${esc(n)}\\.([A-Za-z_$][\\w$]*)(?:\\.([A-Za-z_$][\\w$]*))?(\\s*=)?`, 'gd');
    for (const m of src.matchAll(re)) {
      const first = ns || m[1];
      const second = ns ? m[1] : m[2];
      const key = second && /^[a-z]/.test(first) ? `${first}.${second}` : first;
      const after = src[m.index + m[0].length];
      const assigned = !!m[3] && after !== '=' && after !== '>';
      if (assigned && (ns || m[2])) acc.writes.add(key);
      else {
        const end = (m.indices[2] || m.indices[1])[1];
        if (/^\s*\(/.test(src.slice(end, end + 64))) acc.called.add(key);
        acc.paths.set(key, (acc.paths.get(key) || 0) + 1);
      }
    }
  }
}

function resolveEntry(dir, raw) {
  if (typeof raw !== 'string') return null;
  const rel = raw.replace(/^\.\//, '');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  let f = path.join(dir, rel);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) f = `${f}.js`;
  try {
    const real = fs.realpathSync(f);
    return real.startsWith(fs.realpathSync(dir) + path.sep) ? real : null;
  } catch {
    return null;
  }
}

function scanExtension(dir, pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))) {
  if (typeof pkg.main !== 'string') return { file: null, filesWithApi: 0, bindings: 0, paths: [], truncated: false, error: null };
  const main = resolveEntry(dir, pkg.main);
  if (!main) return { file: null, filesWithApi: 0, bindings: 0, paths: [], truncated: false, error: 'arquivo `main` não encontrado dentro da extensão' };
  const browser = resolveEntry(dir, pkg.browser);
  const queue = [main];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(d, e.name));
      } else if (e.isFile() && /\.c?js$/.test(e.name) && !e.name.endsWith('.min.js')) queue.push(path.join(d, e.name));
    }
  }
  const acc = { files: 0, bindings: 0, paths: new Map(), writes: new Set(), called: new Set() };
  const seen = new Set();
  let budget = MAX_SCAN_BYTES;
  let truncated = false;
  for (const f of queue) {
    let real;
    try {
      real = fs.realpathSync(f);
    } catch {
      continue;
    }
    if (seen.has(real) || real === browser) continue;
    seen.add(real);
    const size = fs.statSync(real).size;
    if (size > MAX_SCAN_FILE && real !== main) continue;
    if (size > budget) {
      truncated = true;
      break;
    }
    budget -= size;
    scanInto(fs.readFileSync(real, 'utf8'), acc);
  }
  const paths = [...acc.paths.entries()].filter(([k]) => !acc.writes.has(k)).sort((a, b) => a[0].localeCompare(b[0]));
  const called = [...acc.called].filter((k) => !acc.writes.has(k)).sort();
  return { file: path.relative(fs.realpathSync(dir), main), filesWithApi: acc.files, bindings: acc.bindings, paths, called, truncated, error: null };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(scanExtension(path.resolve(process.argv[2])), null, 2) + '\n');
}
module.exports = { scanExtension, scanInto };
