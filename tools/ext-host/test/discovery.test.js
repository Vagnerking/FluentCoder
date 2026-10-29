'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
const cli = path.resolve(__dirname, '../discovery/run.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temp = path.join(root, 'tmp');
  const extension = path.join(root, 'extension');
  fs.mkdirSync(temp);
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({
    name: 'discovery-test', publisher: 'fluent', version: '1.0.0',
    engines: { vscode: '^1.90.0' }, main: './extension.js',
  }));
  fs.writeFileSync(path.join(extension, 'extension.js'), `
    const fs = require('fs');
    const path = require('path');
    const vscode = require('vscode');
    let dataDir;
    exports.activate = (context) => {
      dataDir = path.resolve(context.globalStorageUri.fsPath, '../../..');
      fs.writeFileSync(process.env.DISCOVERY_REPORT, JSON.stringify({
        dataDir, machineId: vscode.env.machineId,
        mode: fs.statSync(dataDir).mode & 0o777,
      }));
    };
    exports.deactivate = () => {
      fs.writeFileSync(process.env.DISCOVERY_REPORT + '.stopped', String(fs.existsSync(dataDir)));
    };
  `);
  async function run(name, args = [], ext = extension) {
    const report = path.join(root, name + '.json');
    const result = await execute(process.execPath, [cli, ext, '--wait', '0', ...args], {
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, DISCOVERY_REPORT: report },
      timeout: 15000,
    });
    assert.equal(JSON.parse(result.stdout).extension, 'fluent.discovery-test');
    assert.equal(fs.readFileSync(report + '.stopped', 'utf8'), 'true', 'stop precedes cleanup');
    return JSON.parse(fs.readFileSync(report, 'utf8'));
  }
  return { root, temp, extension, run };
}

test('discovery: private default state ignores planted paths and is cleaned after shutdown', async (t) => {
  const f = fixture(t);
  const planted = path.join(f.temp, 'fluent-ext-host-discovery');
  fs.mkdirSync(planted);
  const target = path.join(f.root, 'victim-file');
  if (process.platform !== 'win32') fs.symlinkSync(target, path.join(planted, 'machine-id'));
  else fs.writeFileSync(path.join(planted, 'machine-id'), 'attacker-controlled');
  const [first, second] = await Promise.all([f.run('first'), f.run('second')]);
  assert.equal(fs.existsSync(target), false, 'dangling link must not create victim file');
  assert.notEqual(first.dataDir, planted);
  assert.notEqual(first.dataDir, second.dataDir);
  assert.notEqual(first.machineId, 'attacker-controlled');
  assert.match(first.machineId, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(first.mode, 0o700);
  assert.equal(fs.existsSync(first.dataDir), false);
  assert.equal(fs.existsSync(second.dataDir), false);
  assert.deepEqual(fs.readdirSync(f.temp), ['fluent-ext-host-discovery']);
});

test('discovery: a planted legacy directory symlink is never followed', { skip: process.platform === 'win32' }, async (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'other-directory');
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.temp, 'fluent-ext-host-discovery'), 'dir');
  await f.run('directory-link');
  assert.deepEqual(fs.readdirSync(target), []);
});

test('discovery: failed extension load cleans default state', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('failed', [], path.join(f.root, 'missing-extension')));
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test('discovery: explicit --data remains persistent across successful and failed runs', async (t) => {
  const f = fixture(t);
  const data = path.join(f.root, 'persistent-data');
  const first = await f.run('explicit-first', ['--data', data]);
  const second = await f.run('explicit-second', ['--data', data]);
  assert.equal(first.dataDir, data);
  assert.equal(first.machineId, second.machineId);
  await assert.rejects(f.run('explicit-failure', ['--data', data], path.join(f.root, 'missing')));
  assert.equal(fs.readFileSync(path.join(data, 'machine-id'), 'utf8'), first.machineId);
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test('discovery: missing --data value still fails without allocating default state', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('missing-data-value', ['--data']));
  assert.deepEqual(fs.readdirSync(f.temp), []);
});
