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
 * SecretStorage em arquivo JSON 0600 no dataDir. Só é usado quando o cofre do
 * SO não está disponível (testes headless, sem Secret Service) — ver
 * KeyringSecretStorage.
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

/**
 * SecretStorage no cofre do SO. O sidecar não fala com o cofre: pede ao
 * backend Rust (`backend(op, key, value)` → `{ok, value?, error?}`), que usa o
 * crate `keyring` (ver src-tauri/src/ext_host/secrets.rs). As NOMES das chaves
 * (não os valores) ficam num índice JSON — o cofre não lista por serviço de
 * forma portável. Se o cofre falhar (sem Secret Service, recusado…), cai no
 * FileSecretStorage (0600) e registra o motivo uma vez.
 *
 * Migração: na 1ª operação, segredos do `secrets.json` antigo vão para o cofre
 * e o arquivo é apagado quando todos foram gravados.
 */
class KeyringSecretStorage {
  constructor({ extensionId, indexFile, legacyFile, backend, log }) {
    this.extensionId = extensionId;
    this.indexFile = indexFile;
    this.legacyFile = legacyFile;
    this.backend = backend;
    this.log = log || (() => {});
    this.index = new Set(Object.keys(readJson(indexFile)));
    this.fallback = null;
    this._ready = null;
    this._onDidChange = new EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  _account(key) {
    return `${this.extensionId}/${key}`;
  }
  _useFallback(reason) {
    if (!this.fallback) {
      this.log(`[secrets] cofre do SO indisponível (${reason}); usando arquivo 0600 para ${this.extensionId}`);
      this.fallback = new FileSecretStorage(this.legacyFile);
    }
    return this.fallback;
  }
  _saveIndex() {
    try {
      writeJson(this.indexFile, Object.fromEntries([...this.index].map((k) => [k, true])));
    } catch (err) {
      this.log(`[secrets] falha ao gravar índice: ${err.message}`);
    }
  }
  async _call(op, key, value) {
    let r;
    try {
      r = await this.backend(op, this._account(key), value);
    } catch (err) {
      r = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    if (!r || r.ok !== true) throw new Error((r && r.error) || 'sem resposta do cofre');
    return r;
  }
  /** Migra o JSON legado uma vez (antes da 1ª operação). */
  ready() {
    if (!this._ready) {
      this._ready = (async () => {
        const legacy = this.legacyFile ? readJson(this.legacyFile) : {};
        const keys = Object.keys(legacy);
        if (!keys.length) return;
        let all = true;
        for (const k of keys) {
          try {
            await this._call('store', k, String(legacy[k]));
            this.index.add(k);
          } catch (err) {
            all = false;
            this._useFallback(err.message);
            break;
          }
        }
        this._saveIndex();
        if (all) {
          try {
            fs.rmSync(this.legacyFile, { force: true });
            this.log(`[secrets] ${keys.length} segredo(s) de ${this.extensionId} migrados para o cofre do SO`);
          } catch {
            /* ignora */
          }
        }
      })();
    }
    return this._ready;
  }
  async get(key) {
    await this.ready();
    if (this.fallback) return this.fallback.get(key);
    try {
      const r = await this._call('get', key);
      return r.value == null ? undefined : String(r.value);
    } catch (err) {
      return this._useFallback(err.message).get(key);
    }
  }
  async keys() {
    await this.ready();
    if (this.fallback) return this.fallback.keys();
    return [...this.index];
  }
  async store(key, value) {
    await this.ready();
    if (!this.fallback) {
      try {
        await this._call('store', key, String(value));
        this.index.add(key);
        this._saveIndex();
        this._onDidChange.fire({ key });
        return;
      } catch (err) {
        this._useFallback(err.message);
      }
    }
    await this.fallback.store(key, value);
    this._onDidChange.fire({ key });
  }
  async delete(key) {
    await this.ready();
    if (!this.fallback) {
      try {
        await this._call('delete', key);
        this.index.delete(key);
        this._saveIndex();
        this._onDidChange.fire({ key });
        return;
      } catch (err) {
        this._useFallback(err.message);
      }
    }
    await this.fallback.delete(key);
    this._onDidChange.fire({ key });
  }
}

module.exports = { JsonMemento, FileSecretStorage, KeyringSecretStorage };
