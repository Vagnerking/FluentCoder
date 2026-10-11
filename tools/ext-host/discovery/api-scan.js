// Varredura estática de uma extensão para o classificador de compatibilidade —
// espelho JS de `scan_extension`/`scan_sources` em
// src-tauri/src/extensions/store.rs (o app usa o Rust; este serve os scripts
// headless, a matriz de compatibilidade e a conferência cruzada: os dois
// passam pelos MESMOS fixtures em tools/ext-host/test/fixtures/api-scan/).
//
// O que reconhece como ligação ao namespace `vscode`:
//   - `x = require("vscode")`, com embrulho (`__importStar(require(…))`,
//     `__toESM(require(…), 1)`), `vscode_1 = require(…)` do tsc;
//   - desestruturação: `{ window, Uri: U } = require("vscode")`;
//   - `import * as vscode from "vscode"`, `import { window as w } from "vscode"`;
//   - módulos do webpack: `1398(e){e.exports=require("vscode")}`,
//     `1398:e=>{…}`, `"vscode":function(e){…}` → as variáveis `i=r(1398)`,
//     `s=n(o(1398))`, `{window:e}=r(1398)` e o acesso direto `r(1398).window.x`;
//   - `require("vscode").window.x` direto.
// Cada `require("vscode")` / `from "vscode"` é um SÍTIO; o que não foi ligado a
// nada vira `unresolved` — o classificador trata como "não analisado" (nunca
// positivo por omissão).
//
// Só conta como API o que está no universo (`src/extensions/vscode-api-surface.json`,
// gerado do vscode.d.ts): ruído de minificação e ids de comando em strings
// (`"vscode.diff"`) ficam em `ignored`. Literais: o caminho não pode vir colado
// a uma aspa/crase (`"vscode.open"`).
// Uso: node api-scan.js <pasta-da-extensão>
'use strict';
const fs = require('fs');
const path = require('path');

/** Mudou o algoritmo → suba (invalida caches de varredura, inclusive a pré-avaliação da loja). */
const SCANNER_VERSION = 2;
const MAX_SCAN_BYTES = 64 << 20;
const MAX_SCAN_FILE = 16 << 20;
const SKIP_DIRS = new Set(['@types', 'typescript', '.git', 'webview', 'webview-ui', 'media']);

const SURFACE = require('../../../src/extensions/vscode-api-surface.json');
const NAMESPACES = new Map();
for (const src of [SURFACE.namespaces, SURFACE.proposed.namespaces]) {
  for (const [ns, members] of Object.entries(src)) {
    if (!NAMESPACES.has(ns)) NAMESPACES.set(ns, new Set());
    for (const m of members) NAMESPACES.get(ns).add(m);
  }
}
const TOP = new Set([...SURFACE.top, ...SURFACE.proposed.top]);

const ID = '[A-Za-z_$][\\w$]*';
const REQ = 'require\\(\\s*["\']vscode["\']\\s*\\)';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARAMS = `\\(?\\s*(?:${ID}(?:\\s*,\\s*${ID})*)?\\s*\\)?`;
/**
 * Fim de `MOD(e){e.exports=` / `MOD:e=>{"use strict";e.exports=` /
 * `"vscode":function(e){…` / `"vscode": /*! external *\/ ((module) => {…` —
 * o módulo do webpack que reexporta `require("vscode")`. Ancorado no fim: só
 * vale colado ao `require`.
 */
const MODULE_DEF = new RegExp(
  `(?:^|[{,\\s])(\\d+|"[^"\\n]{1,200}"|'[^'\\n]{1,200}')\\s*(?::\\s*(?:/\\*(?:[^*]|\\*[^/])*\\*/\\s*)*\\(?\\s*(?:function\\s*)?${PARAMS}\\s*(?:=>\\s*)?|\\(\\s*(?:${ID}(?:\\s*,\\s*${ID})*)?\\s*\\)\\s*)\\{\\s*(?:(?:"use strict"|'use strict');?\\s*)?${ID}\\.exports\\s*=\\s*$`,
);
/** Módulos em ARRAY (webpack sem ids nomeados): `/* 2 *\/ /***\/ ((module) => { module.exports = require("vscode")`. */
const MODULE_DEF_ARRAY = new RegExp(
  `/\\*\\s*(\\d+)\\s*\\*/\\s*(?:/\\*+/\\s*)*\\(?\\s*(?:function\\s*)?${PARAMS}\\s*(?:=>\\s*)?\\{\\s*(?:(?:"use strict"|'use strict');?\\s*)?${ID}\\.exports\\s*=\\s*$`,
);

/** O caminho `a.b` está no universo da API? (namespace + membro, ou topo). */
function inSurface(first, second) {
  if (NAMESPACES.has(first)) return !second || NAMESPACES.get(first).has(second);
  return TOP.has(first);
}

/** `window, Uri: U, workspace = x` / `commands as c` → [[chave, apelido]]. */
function destructured(body) {
  const out = [];
  for (const part of body.split(',')) {
    const m = new RegExp(`^\\s*(${ID})\\s*(?:(?::|\\bas\\b)\\s*(${ID}))?\\s*(?:=[^,]*)?$`).exec(part);
    if (m) out.push([m[1], m[2] || m[1]]);
  }
  return out;
}

function newAcc() {
  return { files: 0, bindings: 0, sites: 0, unresolved: 0, ignored: 0, typeCommand: false, paths: new Map(), writes: new Set(), called: new Set() };
}

function addPath(acc, first, second, called) {
  if (!inSurface(first, second)) {
    acc.ignored++;
    return;
  }
  const key = second && NAMESPACES.has(first) ? `${first}.${second}` : first;
  acc.paths.set(key, (acc.paths.get(key) || 0) + 1);
  if (called) acc.called.add(key);
}

/** Próximo caractere útil é `(` → chamada; `(0,x.y)(` (estilo webpack) também. */
function isCall(src, start, end) {
  const after = src.slice(end, end + 64);
  if (/^\s*\(/.test(after)) return true;
  return /^\s*\)\s*\(/.test(after) && /\(\s*0\s*,\s*$/.test(src.slice(Math.max(0, start - 8), start));
}

function scanInto(src, acc) {
  // Sítios: cada `require("vscode")` e cada `… from "vscode"`.
  const sites = [];
  for (const m of src.matchAll(new RegExp(REQ, 'g'))) sites.push(m.index);
  const esm = [...src.matchAll(/\bimport\s+([^;'"`]{1,2000}?)\s+from\s*["']vscode["']/g)];
  if (!sites.length && !esm.length) return;
  acc.files++;
  acc.sites += sites.length + esm.length;
  if (/registerCommand\(\s*["']type["']/.test(src)) acc.typeCommand = true;
  const resolved = new Set();
  const names = new Set();
  /** apelido → namespace (`w = vscode.window`, `{ window: w }`). */
  const nsAlias = new Map();
  /** apelido → classe/enum do topo (`{ Uri: U }`). */
  const topAlias = new Map();
  const bindKey = (key, alias) => {
    if (NAMESPACES.has(key)) nsAlias.set(alias, key);
    else topAlias.set(alias, key);
    addPath(acc, key, null, false);
  };

  // 1. diretos
  for (const m of src.matchAll(new RegExp(`(?:^|[^\\w$.])(${ID})\\s*=\\s*(?:${ID}\\()?(${REQ})`, 'g'))) {
    names.add(m[1]);
    resolved.add(m.index + m[0].length - m[2].length);
  }
  for (const m of src.matchAll(new RegExp(`\\{([^{}]{1,2000})\\}\\s*=\\s*(?:${ID}\\()?(${REQ})`, 'g'))) {
    for (const [k, a] of destructured(m[1])) bindKey(k, a);
    resolved.add(m.index + m[0].length - m[2].length);
  }
  for (const m of src.matchAll(new RegExp(`(${REQ})\\.(${ID})(?:\\.(${ID}))?`, 'g'))) {
    addPath(acc, m[2], m[3], isCall(src, m.index, m.index + m[0].length));
    resolved.add(m.index);
  }
  for (const m of esm) {
    const clause = m[1].trim();
    const star = new RegExp(`^(?:(${ID})\\s*,\\s*)?\\*\\s*as\\s+(${ID})$`).exec(clause);
    const named = /\{([^}]*)\}/.exec(clause);
    const def = new RegExp(`^(${ID})(?:\\s*,|$)`).exec(clause);
    if (star) names.add(star[2]);
    if (named) for (const [k, a] of destructured(named[1])) bindKey(k, a);
    if (def && !star) names.add(def[1]);
    if (!star && !named && !def) acc.unresolved++;
  }

  // 2. módulos do webpack (`ID.exports = require("vscode")` dentro de `MOD(e){…}` / `MOD:e=>{…}`)
  const modIds = new Map(); // id do módulo → posições dos sítios
  for (const pos of sites) {
    if (resolved.has(pos)) continue;
    const win = src.slice(Math.max(0, pos - 400), pos);
    const def = MODULE_DEF.exec(win) || MODULE_DEF_ARRAY.exec(win);
    if (!def) continue;
    const mod = def[1];
    const key = /^\d+$/.test(mod) ? mod : mod.slice(1, -1);
    if (!modIds.has(key)) modIds.set(key, []);
    modIds.get(key).push(pos);
  }
  for (const [mod, positions] of modIds) {
    const arg = /^\d+$/.test(mod) ? esc(mod) : `["']${esc(mod)}["']`;
    const call = `${ID}\\(\\s*(?:/\\*[^*]*\\*/\\s*)?${arg}\\s*\\)`;
    let used = false;
    for (const m of src.matchAll(new RegExp(`(?:^|[^\\w$.])(${ID})\\s*=\\s*(?:${ID}\\()?${call}`, 'g'))) {
      names.add(m[1]);
      used = true;
    }
    for (const m of src.matchAll(new RegExp(`\\{([^{}]{1,2000})\\}\\s*=\\s*(?:${ID}\\()?${call}`, 'g'))) {
      for (const [k, a] of destructured(m[1])) bindKey(k, a);
      used = true;
    }
    for (const m of src.matchAll(new RegExp(`(?:^|[^\\w$.])${call}\\.(${ID})(?:\\.(${ID}))?`, 'g'))) {
      addPath(acc, m[1], m[2], isCall(src, m.index, m.index + m[0].length));
      used = true;
    }
    if (used) for (const p of positions) resolved.add(p);
  }
  acc.unresolved += sites.filter((p) => !resolved.has(p)).length;
  acc.bindings += names.size + nsAlias.size + topAlias.size;

  // 3. apelidos de namespace: `X = vscode.window` (sem acesso encadeado depois)
  for (const n of names) {
    for (const m of src.matchAll(new RegExp(`(?:^|[^\\w$.])(${ID})\\s*=\\s*${esc(n)}\\.([a-z][\\w$]*)\\s*[;,)\\n]`, 'g'))) {
      if (NAMESPACES.has(m[2])) nsAlias.set(m[1], m[2]);
    }
  }

  // 4. acessos. Prefixo sem `.`/aspa/crase: `x.vscode.window` e `"vscode.diff"` não contam.
  const lookups = [...[...names].map((n) => [n, null, false]), ...[...nsAlias].map(([a, ns]) => [a, ns, false]), ...[...topAlias].map(([a, t]) => [a, t, true])];
  for (const [n, base, isTop] of lookups) {
    const re = new RegExp(`(?:^|[^\\w$.'"\`])(${esc(n)})\\.(${ID})(?:\\.(${ID}))?(\\s*=)?`, 'gd');
    for (const m of src.matchAll(re)) {
      const start = m.indices[1][0];
      const after = src[m.index + m[0].length];
      const assigned = !!m[4] && after !== '=' && after !== '>';
      // `{ Uri: U }` → `U.file(…)` é uso de `Uri`.
      const first = base && !isTop ? base : isTop ? base : m[2];
      const second = base && !isTop ? m[2] : isTop ? null : m[3];
      if (assigned && isTop) continue;
      if (assigned && (base || m[3])) {
        if (inSurface(first, second)) acc.writes.add(second && NAMESPACES.has(first) ? `${first}.${second}` : first);
        continue;
      }
      const end = (m.indices[3] && !base ? m.indices[3] : m.indices[2])[1];
      addPath(acc, first, second, isCall(src, start, end));
    }
  }
}

/** Resultado final (mesmo formato do `ApiScan` do Rust). */
function finish(acc, file, truncated) {
  const paths = [...acc.paths.entries()].filter(([k]) => !acc.writes.has(k)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const called = [...acc.called].filter((k) => !acc.writes.has(k)).sort();
  return {
    scannerVersion: SCANNER_VERSION,
    file,
    filesWithApi: acc.files,
    bindings: acc.bindings,
    sites: acc.sites,
    unresolved: acc.unresolved,
    ignored: acc.ignored,
    typeCommand: acc.typeCommand,
    paths,
    called,
    truncated,
    error: null,
  };
}

/** Varre fontes em memória (`[nome, texto]`), na ordem dada (o `main` primeiro). */
function scanSources(entries, file = null, truncated = false) {
  const acc = newAcc();
  for (const [, text] of entries) scanInto(text, acc);
  return finish(acc, file, truncated);
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

const empty = (error = null) => ({ scannerVersion: SCANNER_VERSION, file: null, filesWithApi: 0, bindings: 0, sites: 0, unresolved: 0, ignored: 0, typeCommand: false, paths: [], called: [], truncated: false, error });

function scanExtension(dir, pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))) {
  if (typeof pkg.main !== 'string') return empty();
  const main = resolveEntry(dir, pkg.main);
  if (!main) return empty('arquivo `main` não encontrado dentro da extensão');
  // O bundle do navegador não roda neste host — a não ser que seja o próprio `main` (ex.: ErrorLens).
  const browserRaw = resolveEntry(dir, pkg.browser);
  const browser = browserRaw && browserRaw !== main ? browserRaw : null;
  // Ordem determinística (o `main` primeiro, depois os demais em ordem de caminho):
  // o teto de bytes corta sempre no mesmo ponto.
  const rest = [];
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
      } else if (e.isFile() && /\.c?js$/.test(e.name) && !e.name.endsWith('.min.js')) rest.push(path.join(d, e.name));
    }
  }
  rest.sort();
  const acc = newAcc();
  const seen = new Set();
  let budget = MAX_SCAN_BYTES;
  let truncated = false;
  for (const f of [main, ...rest]) {
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
  return finish(acc, path.relative(fs.realpathSync(dir), main).split(path.sep).join('/'), truncated);
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(scanExtension(path.resolve(process.argv[2])), null, 2) + '\n');
}
module.exports = { scanExtension, scanInto, scanSources, inSurface, SCANNER_VERSION };
