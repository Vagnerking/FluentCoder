// Memento (globalState/workspaceState) e SecretStorage persistidos em JSON
// dentro do diretório de dados do host (nunca nos diretórios do VS Code).
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('./types');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class JsonMemento {
  constructor(file) {
    this.file = file;
    this.data = file ? readJson(file) : {};
    this._syncKeys = [];
  }
  keys() {
    return Object.keys(this.data);
  }
  get(key, defaultValue) {
    const v = this.data[key];
    return v === undefined ? defaultValue : JSON.parse(JSON.stringify(v));
  }
  update(key, value) {
    if (value === undefined) delete this.data[key];
    else this.data[key] = JSON.parse(JSON.stringify(value));
    if (this.file) {
      try {
        writeJson(this.file, this.data);
      } catch (err) {
        console.error('[ext-host] falha ao gravar memento:', err.message);
      }
    }
    return Promise.resolve();
  }
  setKeysForSync(keys) {
    this._syncKeys = keys;
  }
}

/**
 * SecretStorage do PoC: arquivo JSON com permissão 0600 no dataDir.
 * TODO(produção): trocar pelo keyring do SO (via backend Rust).
 */
class FileSecretStorage {
  constructor(file) {
    this.file = file;
    this.data = file ? readJson(file) : {};
    this._onDidChange = new EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  get(key) {
    return Promise.resolve(this.data[key]);
  }
  keys() {
    return Promise.resolve(Object.keys(this.data));
  }
  store(key, value) {
    this.data[key] = String(value);
    this._flush();
    this._onDidChange.fire({ key });
    return Promise.resolve();
  }
  delete(key) {
    delete this.data[key];
    this._flush();
    this._onDidChange.fire({ key });
    return Promise.resolve();
  }
  _flush() {
    if (!this.file) return;
    try {
      writeJson(this.file, this.data);
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      console.error('[ext-host] falha ao gravar secrets:', err.message);
    }
  }
}

module.exports = { JsonMemento, FileSecretStorage };
