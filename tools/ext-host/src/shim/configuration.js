// workspace.getConfiguration(): defaults vêm de `contributes.configuration` de
// cada extensão carregada; overrides do usuário ficam num JSON próprio do host
// (<dataDir>/settings.json) — NUNCA no settings.json do VS Code do usuário.
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('./types');

/** Extrai `{ "chave.completa": default }` de um package.json. */
function collectDefaults(packageJson) {
  const out = {};
  const conf = packageJson && packageJson.contributes && packageJson.contributes.configuration;
  const blocks = Array.isArray(conf) ? conf : conf ? [conf] : [];
  for (const block of blocks) {
    const props = (block && block.properties) || {};
    for (const [key, schema] of Object.entries(props)) {
      if (schema && Object.prototype.hasOwnProperty.call(schema, 'default')) out[key] = schema.default;
      else if (schema && schema.type) out[key] = defaultForType(schema.type);
    }
  }
  return out;
}

function defaultForType(type) {
  const t = Array.isArray(type) ? type[0] : type;
  switch (t) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'string':
      return '';
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

class ConfigurationStore {
  constructor(settingsFile) {
    this.settingsFile = settingsFile;
    this.defaults = {};
    this.user = {};
    this._onDidChange = new EventEmitter();
    this.onDidChangeConfiguration = this._onDidChange.event;
    if (settingsFile) {
      try {
        this.user = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
      } catch {
        this.user = {};
      }
    }
  }

  addDefaults(packageJson) {
    Object.assign(this.defaults, collectDefaults(packageJson));
  }

  /** Valor efetivo de uma chave completa, ou objeto montado com as subchaves. */
  lookup(full) {
    if (Object.prototype.hasOwnProperty.call(this.user, full)) return clone(this.user[full]);
    if (Object.prototype.hasOwnProperty.call(this.defaults, full)) return clone(this.defaults[full]);
    const prefix = full ? full + '.' : '';
    let obj;
    for (const src of [this.defaults, this.user]) {
      for (const [k, v] of Object.entries(src)) {
        if (prefix && !k.startsWith(prefix)) continue;
        obj = obj || {};
        setDeep(obj, k.slice(prefix.length).split('.'), clone(v));
      }
    }
    return obj;
  }

  getConfiguration(section) {
    const store = this;
    const full = (key) => (section ? (key ? `${section}.${key}` : section) : key);
    const base = store.lookup(section || '') || {};
    const cfg = typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    Object.assign(cfg, {
      get(key, defaultValue) {
        const v = store.lookup(full(key));
        return v === undefined ? defaultValue : v;
      },
      has(key) {
        return store.lookup(full(key)) !== undefined;
      },
      inspect(key) {
        const k = full(key);
        return {
          key: k,
          defaultValue: clone(store.defaults[k]),
          globalValue: clone(store.user[k]),
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
        };
      },
      update(key, value) {
        store.set(full(key), value);
        return Promise.resolve();
      },
    });
    return cfg;
  }

  set(key, value) {
    if (value === undefined) delete this.user[key];
    else this.user[key] = clone(value);
    this.persist();
    this._onDidChange.fire({
      affectsConfiguration: (s) => key === s || key.startsWith(s + '.') || s.startsWith(key + '.'),
    });
  }

  persist() {
    if (!this.settingsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.user, null, 2));
    } catch (err) {
      console.error('[ext-host] falha ao gravar settings:', err.message);
    }
  }
}

function setDeep(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

module.exports = { ConfigurationStore, collectDefaults };
