'use strict';
// NLS do manifesto: uma tradução só (`localizeManifest`), aplicada em todo
// leitor do package.json. A saída dourada (`fixtures/nls/expected.json`) é a
// mesma que o Rust (`store::localize_manifest`) tem de produzir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { localizeManifest, nlsChain, readContributions, displayNameOf, descriptionOf } = require('../src/contributions');
const { listInstalled } = require('../src/installed');

const FIX = path.join(__dirname, 'fixtures', 'nls');
const pkg = () => JSON.parse(fs.readFileSync(path.join(FIX, 'demo', 'package.json'), 'utf8'));

test('NLS: saída dourada por locale (paridade com o Rust)', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
  for (const loc of ['pt-br', 'en', 'pt']) assert.deepEqual(localizeManifest(pkg(), path.join(FIX, 'demo'), loc), expected[loc], loc);
});

test('NLS: cadeia pt-br → pt → base, {message}, chave ausente e campos profundos', () => {
  assert.deepEqual(nlsChain('pt-BR'), ['package.nls.json', 'package.nls.pt.json', 'package.nls.pt-br.json']);
  assert.deepEqual(nlsChain('../etc'), ['package.nls.json']);
  const m = localizeManifest(pkg(), path.join(FIX, 'demo'), 'pt-br');
  assert.equal(m.displayName, 'Demo NLS', 'base');
  assert.equal(m.description, 'Descrição em português genérico', 'pt genérico');
  assert.equal(m.contributes.commands[0].title, 'Executar Demo', 'pt-br vence pt');
  assert.equal(m.contributes.configuration[0].properties['demo.mode'].markdownDescription, 'Mode used by **demo**', '{message, comment}');
  assert.deepEqual(m.contributes.configuration[0].properties['demo.mode'].enumDescriptions, ['Modo A (pt)', 'Mode B']);
  assert.equal(m.contributes.walkthroughs[0].steps[0].title, 'First step');
  assert.equal(m.contributes.walkthroughs[0].steps[0].description, 'Literal sem placeholder: 100% pronto');
  assert.equal(m.contributes.commands[1].title, '%command.missing%', 'ausente fica no manifesto');
  const c = readContributions(m, path.join(FIX, 'demo'), 'pt-br');
  assert.equal(c.commands[1].title, 'demo.missing', 'na Paleta, título ausente cai para o id');
  assert.equal(c.views[0].name, 'View Demo (pt)');
  assert.equal(displayNameOf({ name: 'x', displayName: '%nada%' }), 'x');
  assert.equal(descriptionOf({ description: '%nada%' }), '');
  // o original não muda
  assert.equal(pkg().displayName, '%displayName%');
});

test('NLS: a lista do host (installed.js) mostra o nome real (GitLens e cia.)', () => {
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-nls-'));
  const ext = path.join(vdir, 'eamodio.gitlens-17.6.2');
  fs.mkdirSync(ext);
  const lens = path.join(__dirname, 'fixtures', 'compat', 'lens');
  for (const f of ['package.json', 'package.nls.json', 'package.nls.pt.json', 'package.nls.pt-br.json']) fs.copyFileSync(path.join(lens, f), path.join(ext, f));
  const [e] = listInstalled({ managed: null, vscodeDirs: [vdir] });
  assert.equal(e.displayName, 'GitLens — Git supercharged');
  assert.equal(e.label, 'GitLens — Git supercharged');
  fs.rmSync(vdir, { recursive: true, force: true });
});
