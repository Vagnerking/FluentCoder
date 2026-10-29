'use strict';
// `languages.getLanguages` (registro real do Monaco via `setLanguages`) e
// `languages.match` (algoritmo de pontuação do VS Code).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExtensionHost, scoreSelector, DEFAULT_LANGUAGE_IDS } = require('../src/host');
const { createVscodeApi, VSCODE_VERSION } = require('../src/shim/api');
const { validateMessage } = require('../src/protocol');
const { Uri } = require('../src/shim/types');

const doc = (p, languageId, scheme) => ({ uri: scheme ? Uri.parse(`${scheme}:${p}`) : Uri.file(p), languageId });

test('languages.match: pontuação do VS Code (10 exato, 5 curinga, 0 não casa)', () => {
  const py = doc('/w/src/app.py', 'python');
  assert.equal(scoreSelector('python', py), 10);
  assert.equal(scoreSelector('*', py), 5);
  assert.equal(scoreSelector('javascript', py), 0);
  assert.equal(scoreSelector({ language: 'python', scheme: 'file' }, py), 10);
  assert.equal(scoreSelector({ language: '*', scheme: 'file' }, py), 10, 'esquema exato vale 10');
  assert.equal(scoreSelector({ language: '*' }, py), 5);
  assert.equal(scoreSelector({ scheme: 'untitled', language: 'python' }, py), 0);
  assert.equal(scoreSelector({ pattern: '**/*.py' }, py), 10);
  assert.equal(scoreSelector({ pattern: '**/*.ts' }, py), 0);
  assert.equal(scoreSelector({ language: 'python', pattern: { baseUri: Uri.file('/w'), pattern: 'src/*.py' } }, py), 10);
  assert.equal(scoreSelector({ language: 'python', notebookType: 'jupyter-notebook' }, py), 0, 'sem notebooks');
  assert.equal(scoreSelector(['javascript', { language: '*' }, 'python'], py), 10, 'lista = maior');
  assert.equal(scoreSelector(['javascript', '*'], py), 5);
  assert.equal(scoreSelector(null, py), 0);
});

test('languages.getLanguages = registro do app; match exposto na API', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-lang-'));
  const host = new ExtensionHost({ dataDir, appConnected: false });
  const ext = { id: 'acme.lang', packageJSON: { name: 'lang', publisher: 'acme', version: '1.0.0' }, extensionPath: dataDir, extensionUri: Uri.file(dataDir), contributions: { commands: [], keybindings: [], views: [], viewsContainers: {}, editorTitle: [], menus: {} } };
  const api = createVscodeApi(host, ext);
  assert.deepEqual(await api.languages.getLanguages(), DEFAULT_LANGUAGE_IDS);
  host.setLanguages([{ id: 'python' }, { id: 'rust' }, { id: 'python' }, 'yaml', { id: '' }]);
  assert.deepEqual(await api.languages.getLanguages(), ['python', 'rust', 'yaml']);
  assert.equal(api.languages.match({ language: 'rust' }, doc('/a.rs', 'rust')), 10);
  assert.equal(api.version, VSCODE_VERSION);
  // `Location` (ErrorLens e o vscode-languageclient constroem): posição vira faixa vazia
  const loc = new api.Location(Uri.file('/a.rs'), new api.Position(3, 4));
  assert.ok(loc.range instanceof api.Range);
  assert.deepEqual([loc.range.start.line, loc.range.end.character], [3, 4]);
  assert.equal(new api.DiagnosticRelatedInformation(loc, 'veja').location, loc);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('protocolo: setLanguages validado', () => {
  assert.equal(validateMessage({ method: 'setLanguages', params: { languages: [{ id: 'python', aliases: ['Python'], extensions: ['.py'] }, { id: 'c++' }] } }), null);
  for (const bad of [{ languages: [{ id: 'a b' }] }, { languages: 'x' }, { languages: [{ id: 1 }] }]) {
    assert.match(String(validateMessage({ method: 'setLanguages', params: bad })), /parâmetros inválidos/, JSON.stringify(bad));
  }
});
