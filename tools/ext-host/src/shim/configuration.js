// workspace.getConfiguration(): as MESMAS camadas do app (src/settings/):
//   default < user < workspace < workspaceFolder, com overrides `[lang]` por
//   cima de todas (precedência do VS Code).
//
// O app manda o snapshot das camadas (`configuration` no protocolo) antes de
// qualquer extensão ativar e a cada mudança (UI, settings.json editado, watcher)
// — e `onDidChangeConfiguration` dispara com as chaves alteradas. O
// `update(key, value, target)` de uma extensão vira o evento
// `configurationUpdate` para o app gravar na camada certa (User settings.json,
// `settings` do workspace ou `.fluent/settings.json` da pasta).
//
// Sem app (scripts headless/testes) o host cai no modo antigo: overrides num
// JSON próprio (<dataDir>/settings.json) — NUNCA o settings.json do VS Code.
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

/** `contributes.configurationDefaults` (inclusive `[lang]`). */
function collectConfigurationDefaults(packageJson) {
  const cd = packageJson && packageJson.contributes && packageJson.contributes.configurationDefaults;
  return isObj(cd) ? cd : {};
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

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Fallback dos padrões do VS Code que as extensões consultam, usado só até o
 * app mandar o snapshot (ou sem app). Os valores BATEM com os defaults do app
 * (`src/settings/coreSettings.ts`) — antes este arquivo dizia `tabSize: 4`
 * enquanto o editor usava 2.
 */
const CORE_DEFAULTS = {
  'files.autoSave': 'off',
  'files.eol': 'auto',
  'files.encoding': 'utf8',
  'files.exclude': { '**/.git': true, '**/.svn': true, '**/.hg': true, '**/.DS_Store': true, '**/Thumbs.db': true, '**/bin': true, '**/obj': true },
  'files.watcherExclude': { '**/.git/objects/**': true, '**/node_modules/*/**': true },
  'editor.tabSize': 2,
  'editor.insertSpaces': true,
  'editor.detectIndentation': true,
  'editor.fontSize': 14,
  'editor.fontFamily': '',
  'editor.wordWrap': 'off',
  'workbench.colorTheme': 'Fluent Escuro',
  'terminal.integrated.defaultProfile.linux': null,
  'terminal.integrated.defaultProfile.windows': null,
  'terminal.integrated.defaultProfile.osx': null,
  'search.exclude': { '**/node_modules': true, '**/bower_components': true, '**/*.code-search': true },
  'http.proxy': '',
  'http.proxyStrictSSL': true,
  'git.enabled': true,
  'chat.agent.enabled': false,
};

const LANG_KEY = /^\[([^\]]+)\](?:\[[^\]]+\])*$/;

function emptyLayer() {
  return { settings: {}, overrides: {} };
}

/** Objeto bruto (`{ "[ts]": {...}, "a.b": 1 }`) → camada. */
function toLayer(raw) {
  const layer = emptyLayer();
  for (const [k, v] of Object.entries(raw || {})) {
    if (LANG_KEY.test(k)) {
      if (!isObj(v)) continue;
      for (const m of k.matchAll(/\[([^\]]+)\]/g)) layer.overrides[m[1]] = { ...(layer.overrides[m[1]] || {}), ...v };
    } else layer.settings[k] = v;
  }
  return layer;
}

function normLayer(l) {
  if (!isObj(l)) return emptyLayer();
  return { settings: isObj(l.settings) ? l.settings : {}, overrides: isObj(l.overrides) ? l.overrides : {} };
}

function mergeValue(base, over) {
  if (isObj(base) && isObj(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = mergeValue(base[k], v);
    return out;
  }
  return over;
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Caminho + linguagem de um `ConfigurationScope` (Uri, TextDocument, WorkspaceFolder, {uri, languageId}). */
function resolveScope(scope) {
  if (!scope) return { resource: null, languageId: null };
  const uriOf = (u) => (u && typeof u === 'object' && typeof u.fsPath === 'string' ? u.fsPath : typeof u === 'string' ? u : null);
  if (typeof scope.fsPath === 'string') return { resource: scope.fsPath, languageId: null };
  if (scope.uri) return { resource: uriOf(scope.uri), languageId: typeof scope.languageId === 'string' ? scope.languageId : null };
  if (typeof scope.languageId === 'string') return { resource: null, languageId: scope.languageId };
  return { resource: null, languageId: null };
}

/** `vscode.ConfigurationTarget` (1 Global, 2 Workspace, 3 WorkspaceFolder) ou boolean → camada. */
function targetName(target, hasWorkspace) {
  if (target === true || target === 1) return 'user';
  if (target === 3) return 'folder';
  if (target === false || target === 2) return 'workspace';
  return hasWorkspace ? 'workspace' : 'user';
}

class ConfigurationStore {
  constructor(settingsFile) {
    this.settingsFile = settingsFile;
    /** Defaults das extensões carregadas (o app manda os do core + os dele no snapshot). */
    this.extDefaults = {};
    this.extLangDefaults = emptyLayer();
    this.appDefaults = null; // camada vinda do app
    this.user = emptyLayer();
    this.workspace = emptyLayer();
    this.folders = []; // [{root, layer}]
    /** `(req) => void` — encaminha `update()` ao app. Null = modo arquivo próprio. */
    this.writer = null;
    this._onDidChange = new EventEmitter();
    this.onDidChangeConfiguration = this._onDidChange.event;
    if (settingsFile) {
      try {
        this.user = toLayer(JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {});
      } catch {
        this.user = emptyLayer();
      }
    }
  }

  get defaults() {
    // Compat: `config.defaults[k]` (testes antigos e inspect).
    return { ...CORE_DEFAULTS, ...this.extDefaults, ...(this.appDefaults ? this.appDefaults.settings : {}) };
  }

  addDefaults(packageJson) {
    this._defCache = null;
    Object.assign(this.extDefaults, collectDefaults(packageJson));
    const extra = toLayer(collectConfigurationDefaults(packageJson));
    Object.assign(this.extDefaults, extra.settings);
    for (const [lang, o] of Object.entries(extra.overrides)) {
      this.extLangDefaults.overrides[lang] = { ...(this.extLangDefaults.overrides[lang] || {}), ...o };
    }
  }

  _defaultLayer() {
    if (this._defCache) return this._defCache;
    const app = this.appDefaults || emptyLayer();
    const overrides = { ...this.extLangDefaults.overrides };
    for (const [lang, o] of Object.entries(app.overrides)) overrides[lang] = { ...(overrides[lang] || {}), ...o };
    this._defCache = { settings: { ...CORE_DEFAULTS, ...this.extDefaults, ...app.settings }, overrides };
    return this._defCache;
  }

  _folderFor(resource) {
    if (!resource) return undefined;
    const r = normPath(resource);
    let best;
    for (const f of this.folders) {
      const root = normPath(f.root);
      const win = /^[a-zA-Z]:\//.test(root);
      const a = win ? r.toLowerCase() : r;
      const b = win ? root.toLowerCase() : root;
      if ((a === b || a.startsWith(b + '/')) && (!best || root.length > normPath(best.root).length)) best = f;
    }
    return best;
  }

  _chain(opts) {
    const folder = this._folderFor(opts && opts.resource);
    const general = [this._defaultLayer(), this.user, this.workspace];
    if (folder) general.push(folder.layer);
    return general;
  }

  /** Valor efetivo de uma chave completa, ou objeto montado com as subchaves. */
  lookup(full, opts = {}) {
    const chain = this._chain(opts);
    let value;
    let found = false;
    const apply = (v) => {
      value = found ? mergeValue(value, v) : clone(v);
      found = true;
    };
    for (const l of chain) if (Object.prototype.hasOwnProperty.call(l.settings, full)) apply(l.settings[full]);
    if (opts.languageId) {
      for (const l of chain) {
        const o = l.overrides[opts.languageId];
        if (o && Object.prototype.hasOwnProperty.call(o, full)) apply(o[full]);
      }
    }
    if (found) return value;
    // Seção: monta o objeto com as subchaves (`getConfiguration('editor')`).
    const prefix = full ? full + '.' : '';
    let obj;
    const keys = new Set();
    for (const l of chain) {
      for (const k of Object.keys(l.settings)) if (!prefix || k.startsWith(prefix)) keys.add(k);
      if (opts.languageId && l.overrides[opts.languageId]) {
        for (const k of Object.keys(l.overrides[opts.languageId])) if (!prefix || k.startsWith(prefix)) keys.add(k);
      }
    }
    for (const k of keys) {
      if (k === full) continue;
      obj = obj || {};
      setDeep(obj, k.slice(prefix.length).split('.'), this.lookup(k, opts));
    }
    return obj;
  }

  getConfiguration(section, scope) {
    const store = this;
    const opts = resolveScope(scope);
    const full = (key) => (section ? (key ? `${section}.${key}` : section) : key);
    const base = store.lookup(section || '', opts) || {};
    const cfg = isObj(base) ? { ...base } : {};
    Object.assign(cfg, {
      get(key, defaultValue) {
        const v = store.lookup(full(key), opts);
        return v === undefined ? defaultValue : v;
      },
      has(key) {
        return store.lookup(full(key), opts) !== undefined;
      },
      inspect(key) {
        return store.inspect(full(key), opts);
      },
      update(key, value, target, overrideInLanguage) {
        return store.update(full(key), value, target, { ...opts, overrideInLanguage: !!overrideInLanguage });
      },
    });
    return cfg;
  }

  inspect(k, opts = {}) {
    const folder = this._folderFor(opts.resource);
    const def = this._defaultLayer();
    const own = (l) => (l && Object.prototype.hasOwnProperty.call(l.settings, k) ? clone(l.settings[k]) : undefined);
    const lang = (l) => {
      if (!l || !opts.languageId) return undefined;
      const o = l.overrides[opts.languageId];
      return o && Object.prototype.hasOwnProperty.call(o, k) ? clone(o[k]) : undefined;
    };
    const languageIds = new Set();
    for (const l of [def, this.user, this.workspace, folder && folder.layer]) {
      if (!l) continue;
      for (const [id, o] of Object.entries(l.overrides)) if (Object.prototype.hasOwnProperty.call(o, k)) languageIds.add(id);
    }
    return {
      key: k,
      defaultValue: own(def),
      globalValue: own(this.user),
      workspaceValue: own(this.workspace),
      workspaceFolderValue: own(folder && folder.layer),
      defaultLanguageValue: lang(def),
      globalLanguageValue: lang(this.user),
      workspaceLanguageValue: lang(this.workspace),
      workspaceFolderLanguageValue: lang(folder && folder.layer),
      languageIds: languageIds.size ? [...languageIds] : undefined,
    };
  }

  /** `update()` de uma extensão: grava na camada certa (via app, quando conectado). */
  update(key, value, target, opts = {}) {
    const hasWorkspace = this.folders.length > 0 || Object.keys(this.workspace.settings).length > 0 || !!this.hasWorkspace;
    const name = targetName(target, hasWorkspace);
    const before = this._effectiveKeys();
    const layer =
      name === 'user'
        ? this.user
        : name === 'folder'
          ? (this._folderFor(opts.resource) || this.folders[0] || { layer: this.workspace }).layer
          : this.workspace;
    const bucket = opts.overrideInLanguage && opts.languageId ? (layer.overrides[opts.languageId] = layer.overrides[opts.languageId] || {}) : layer.settings;
    if (value === undefined) delete bucket[key];
    else bucket[key] = clone(value);
    if (this.writer) {
      this.writer({ key, value, target: name, resource: opts.resource || null, languageId: opts.overrideInLanguage ? opts.languageId || null : null });
    } else if (name === 'user') {
      this.persist();
    }
    this._fireDiff(before);
    return Promise.resolve();
  }

  /** Compat (testes antigos): grava no escopo global. */
  set(key, value) {
    return this.update(key, value, true);
  }

  /** Snapshot das camadas vindo do app. */
  setSnapshot(snap) {
    const before = this._effectiveKeys();
    if (snap.defaults) this.appDefaults = normLayer(snap.defaults);
    this._defCache = null;
    this.user = normLayer(snap.user);
    this.workspace = normLayer(snap.workspace);
    this.folders = Array.isArray(snap.folders)
      ? snap.folders.filter((f) => f && typeof f.root === 'string').map((f) => ({ root: f.root, layer: normLayer(f.layer) }))
      : [];
    this.hasWorkspace = !!snap.hasWorkspace;
    this._fireDiff(before);
  }

  /** Mapa chave → JSON efetivo (por escopo de pasta/linguagem) para diffs. */
  _effectiveKeys() {
    const out = new Map();
    const layers = [this._defaultLayer(), this.user, this.workspace, ...this.folders.map((f) => f.layer)];
    const tag = ['d', 'u', 'w', ...this.folders.map((f) => 'f:' + f.root)];
    layers.forEach((l, i) => {
      for (const [k, v] of Object.entries(l.settings)) out.set(`${tag[i]}|${k}`, JSON.stringify(v));
      for (const [lang, o] of Object.entries(l.overrides)) for (const [k, v] of Object.entries(o)) out.set(`${tag[i]}|[${lang}]${k}`, JSON.stringify(v));
    });
    return out;
  }

  _fireDiff(before) {
    const after = this._effectiveKeys();
    const keys = new Set();
    const strip = (k) => k.slice(k.indexOf('|') + 1).replace(/^\[[^\]]+\]/, '');
    for (const [k, v] of before) if (after.get(k) !== v) keys.add(strip(k));
    for (const k of after.keys()) if (!before.has(k)) keys.add(strip(k));
    if (keys.size === 0) return;
    this._onDidChange.fire({
      affectsConfiguration: (s) => {
        for (const key of keys) if (key === s || key.startsWith(s + '.') || s.startsWith(key + '.')) return true;
        return false;
      },
    });
  }

  persist() {
    if (!this.settingsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      const out = { ...this.user.settings };
      for (const [lang, o] of Object.entries(this.user.overrides)) out[`[${lang}]`] = o;
      fs.writeFileSync(this.settingsFile, JSON.stringify(out, null, 2));
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

module.exports = { ConfigurationStore, collectDefaults, CORE_DEFAULTS };
