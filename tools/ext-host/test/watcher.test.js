'use strict';
// Watcher frugal do ext-host: walk assíncrono, orçamento global, pastas
// pesadas/gitignore/watcherExclude puladas e fallback de polling no ENOSPC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WatchService, GitIgnore, compileExcludes, isSkippedRel } = require('../src/shim/watcher');

function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-watch-'));
  for (const rel of spec) {
    const abs = path.join(root, rel);
    if (rel.endsWith('/')) fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '');
    }
  }
  return root;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const watched = (ws) => {
  const dirs = [];
  for (const e of ws.roots.values()) if (e.dirWatch) dirs.push(...e.dirWatch.watchers.keys());
  return dirs;
};

test('gitignore mínimo: âncora, pasta, glob, negação', () => {
  const gi = new GitIgnore();
  gi.add('# comentário\nout/\n/build\n*.tmp\nlogs/**\n!logs/keep\n', '');
  gi.add('gen\n', 'pkg');
  assert.equal(gi.ignores('out'), true);
  assert.equal(gi.ignores('src/out'), true, 'sem barra no meio casa em qualquer nível');
  assert.equal(gi.ignores('build'), true);
  assert.equal(gi.ignores('src/build'), false, '/build é ancorado na raiz');
  assert.equal(gi.ignores('a.tmp'), true);
  assert.equal(gi.ignores('logs/x'), true);
  assert.equal(gi.ignores('logs/keep'), false, 'negação vence');
  assert.equal(gi.ignores('pkg/gen'), true, '.gitignore aninhado vale abaixo da sua pasta');
  assert.equal(gi.ignores('gen'), false);
  assert.equal(gi.ignores('src'), false);
});

test('watcherExclude e pastas puladas por caminho', () => {
  const ex = compileExcludes({ '**/.git/objects/**': true, '**/node_modules/*/**': true, '**/tmp': true, '**/off': false });
  assert.ok(ex.some((r) => r.test('tmp')));
  assert.ok(ex.some((r) => r.test('a/tmp/b')));
  assert.ok(!ex.some((r) => r.test('off')));
  assert.ok(isSkippedRel('.claude/worktrees'));
  assert.ok(isSkippedRel('.claude/worktrees/wt/src'));
  assert.ok(isSkippedRel('a/node_modules/b'));
  assert.ok(!isSkippedRel('.claude'));
});

test('walk assíncrono pula pesadas, worktrees, gitignore e watcherExclude', async () => {
  const root = tree(['src/a/', 'src/b/', 'node_modules/x/', 'target/debug/', '.claude/worktrees/wt/src/', '.claude/x/', 'out/deep/', 'tmp/', '.gitignore']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'out/\n');
  const ws = new WatchService(() => {}, { nativeRecursive: false, excludes: () => ({ '**/tmp': true }) });
  const t0 = process.hrtime.bigint();
  const off = ws.subscribe(root, /.*/, true, () => {});
  const syncMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(syncMs < 50, `subscribe não pode fazer o walk síncrono (${syncMs} ms)`);
  await ws.whenIdle();
  const rels = watched(ws).map((d) => path.relative(root, d).split(path.sep).join('/')).sort();
  assert.deepEqual(rels, ['', '.claude', '.claude/x', 'src', 'src/a', 'src/b']);
  off();
  assert.equal(ws.watchCount, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('orçamento é GLOBAL: duas raízes somadas não passam do teto; um aviso', async () => {
  const a = tree(['1/', '2/', '3/', '4/']);
  const b = tree(['1/', '2/', '3/', '4/']);
  const logs = [];
  const ws = new WatchService((m) => logs.push(m), { nativeRecursive: false, maxWatches: 6, pollMs: 60_000 });
  const offA = ws.subscribe(a, /.*/, true, () => {});
  await ws.whenIdle();
  const offB = ws.subscribe(b, /.*/, true, () => {});
  await ws.whenIdle();
  assert.ok(ws.watchCount <= 6, `watches=${ws.watchCount}`);
  assert.ok(ws.pollingCount >= 1, 'a raiz que estourou o orçamento cai para polling');
  assert.equal(logs.filter((m) => m.includes('limite de 6 pastas')).length, 1);
  offA();
  offB();
  assert.equal(ws.watchCount, 0);
  assert.equal(ws.active, 0, 'o orçamento é devolvido');
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('ENOSPC → polling da raiz + UM aviso sugerindo max_user_watches; eventos continuam', async () => {
  const r1 = tree(['src/']);
  const r2 = tree(['lib/']);
  const logs = [];
  const enospc = () => {
    const e = new Error('ENOSPC: System limit for number of file watchers reached');
    e.code = 'ENOSPC';
    throw e;
  };
  const ws = new WatchService((m) => logs.push(m), { nativeRecursive: false, watchImpl: enospc, pollMs: 40 });
  const seen = [];
  const off1 = ws.subscribe(r1, /\.ts$/, true, (kind, abs) => seen.push([kind, path.basename(abs)]));
  const off2 = ws.subscribe(r2, /.*/, true, () => {});
  await ws.whenIdle();
  assert.equal(ws.watchCount, 0);
  assert.equal(ws.pollingCount, 2);
  const warns = logs.filter((m) => m.includes('ENOSPC'));
  assert.equal(warns.length, 1, 'um aviso só, mesmo com duas raízes');
  if (process.platform === 'linux') assert.match(warns[0], /fs\.inotify\.max_user_watches/);
  await wait(120); // snapshot inicial
  fs.writeFileSync(path.join(r1, 'src', 'novo.ts'), '1');
  await wait(300);
  assert.ok(seen.some(([k, n]) => k === 'create' && n === 'novo.ts'), JSON.stringify(seen));
  fs.rmSync(path.join(r1, 'src', 'novo.ts'));
  await wait(300);
  assert.ok(seen.some(([k, n]) => k === 'delete' && n === 'novo.ts'), JSON.stringify(seen));
  off1();
  off2();
  assert.equal(ws.pollingCount, 0);
  fs.rmSync(r1, { recursive: true, force: true });
  fs.rmSync(r2, { recursive: true, force: true });
});

test('recursivo nativo (macOS/Windows): eventos de pastas puladas são descartados', async () => {
  const root = tree(['src/', 'node_modules/x/']);
  let cb;
  const fakeWatch = (_dir, _opts, listener) => {
    cb = listener;
    return { on() {}, close() {} };
  };
  const ws = new WatchService(() => {}, { nativeRecursive: true, watchImpl: fakeWatch });
  const seen = [];
  const off = ws.subscribe(root, /.*/, true, (k, abs) => seen.push(path.relative(root, abs).split(path.sep).join('/')));
  await ws.whenIdle();
  assert.equal(ws.watchCount, 1, 'um watch nativo para a árvore toda');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'b.js'), '');
  cb('rename', path.join('src', 'a.ts'));
  cb('rename', path.join('node_modules', 'x', 'b.js'));
  await wait(150);
  assert.deepEqual(seen, ['src/a.ts']);
  off();
  fs.rmSync(root, { recursive: true, force: true });
});
