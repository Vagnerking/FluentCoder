import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, reviewErrors, main } from './pr-check.mjs';

const valid = { title: 'fix(git): validar host', body: '## Descrição\nValida o hostname.\n## Como testar\n1. npm run test:unit passou.' };
test('limite inclui lockfiles e bloqueia o primeiro arquivo excedente', () => {
  assert.deepEqual(reviewErrors(Array(100).fill('arquivo'), valid), []);
  assert.match(reviewErrors(Array(101).fill('arquivo'), valid)[0], /divida/);
});
test('template vazio e título automático são rejeitados', () => {
  const errors = reviewErrors([], { title: 'Feat/git fluent workspace polish', body: '## Descrição\n<!-- preencher -->\n## Como testar\n1.\n2.\nCloses #\n## Checklist\n- [x] pronto' });
  assert.equal(errors.length, 4);
  assert.deepEqual(reviewErrors([], { ...valid, title: 'feat(api)!: mudar contrato' }), []);
});
test('base obrigatória e opções desconhecidas falham', () => {
  assert.throws(() => main([]), /--base/);
  assert.throws(() => main(['--unknown', 'x']), /Uso/);
});
test('diff usa merge-base, inclui trabalho local e preserva nomes incomuns', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-check-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const name = 'arquivo com espaço\ne quebra.txt';
  writeFileSync(join(cwd, name), 'primeiro');
  git('add', '--', name);
  git('commit', '-q', '-m', 'feature');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', base);
  writeFileSync(join(cwd, 'base-only'), 'outro');
  git('add', '.');
  git('commit', '-q', '-m', 'base avançou');
  const advancedBase = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', head);
  writeFileSync(join(cwd, 'local.txt'), 'local');
  assert.deepEqual(changedFiles(advancedBase, head, cwd), [name]);
  assert.deepEqual(changedFiles(advancedBase, undefined, cwd).sort(), [name, 'local.txt'].sort());
  assert.throws(() => changedFiles('--invalid', head, cwd));
});
