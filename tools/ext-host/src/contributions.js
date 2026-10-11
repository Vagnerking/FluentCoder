// Lê o `contributes` do package.json de uma extensão e normaliza o que o
// Fluent Coder honra: comandos (Paleta), keybindings (best effort), menus
// `editor/title` (aceitar/rejeitar diff), `comments/*` (botões dos threads),
// views/viewsContainers (metadados).
//
// NLS: `localizeManifest` é a ÚNICA tradução do manifesto (espelho de
// `store::localize_manifest` no Rust; mesma cadeia, mesma saída — teste de
// paridade em tools/ext-host/test/fixtures/nls/). Todo leitor do package.json
// (installed.js, host.js, contributions.js) recebe o manifesto já traduzido.
'use strict';
const fs = require('fs');
const path = require('path');

/** Teto de cada package.nls*.json (o mesmo do package.json). */
const NLS_MAX_BYTES = 4 << 20;
const MAX_DEPTH = 32;
const MAX_NODES = 50000;
const PLACEHOLDER = /^%([^%]+)%$/;

function readJson(file, max = Infinity) {
  try {
    if (fs.statSync(file).size > max) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Arquivos de mensagens, do mais genérico ao mais específico:
 * `package.nls.json` → `package.nls.pt.json` → `package.nls.pt-br.json`
 * (nomes em minúsculas, como o VS Code grava). O mais específico vence.
 */
function nlsChain(language = 'pt-br') {
  const loc = String(language || '').toLowerCase().replace(/_/g, '-');
  const out = ['package.nls.json'];
  const lang = loc.split('-')[0];
  if (lang && /^[a-z]{2,3}$/.test(lang)) out.push(`package.nls.${lang}.json`);
  if (loc && loc !== lang && /^[a-z]{2,3}(-[a-z0-9]{2,8})+$/.test(loc)) out.push(`package.nls.${loc}.json`);
  return out;
}

/** Mensagens localizadas da extensão (cadeia `pt-br` → `pt` → padrão). */
function loadNls(extensionPath, language = 'pt-br') {
  let nls = {};
  for (const f of nlsChain(language)) {
    const v = readJson(path.join(extensionPath, f), NLS_MAX_BYTES);
    if (v && typeof v === 'object' && !Array.isArray(v)) nls = { ...nls, ...v };
  }
  return nls;
}

/** Texto de uma mensagem: `"texto"` ou `{ message, comment }`. */
function message(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.message === 'string') return v.message;
  return undefined;
}

function localize(value, nls) {
  if (typeof value !== 'string') return value && typeof value === 'object' && value.value ? value.value : value;
  const m = PLACEHOLDER.exec(value);
  if (!m) return value;
  const v = message(nls[m[1]]);
  return v === undefined ? value : v;
}

/** `%chave%` que sobrou (chave ausente no NLS)? */
function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value);
}

/**
 * Manifesto traduzido: TODA string que seja exatamente `%chave%` vira a
 * mensagem do NLS (travessia profunda limitada: profundidade ≤ 32, ≤ 50 000
 * nós). Chave ausente: fica `%chave%` (os campos de exibição caem para o
 * `name`, ver `displayNameOf`). Devolve um objeto NOVO (o original não muda).
 */
function localizeManifest(pkg, extensionPath, language = 'pt-br', nls = extensionPath ? loadNls(extensionPath, language) : {}) {
  if (!pkg || typeof pkg !== 'object') return pkg;
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return v;
    if (typeof v === 'string') return localize(v, nls);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
      return out;
    }
    return v;
  };
  return walk(pkg, 0);
}

/** Nome para exibição: `displayName` traduzido; placeholder sem tradução → `name`. */
function displayNameOf(pkg) {
  const d = pkg && pkg.displayName;
  return typeof d === 'string' && d && !isPlaceholder(d) ? d : (pkg && pkg.name) || '';
}

/** Descrição para exibição (placeholder sem tradução → vazio). */
function descriptionOf(pkg) {
  const d = pkg && pkg.description;
  return typeof d === 'string' && !isPlaceholder(d) ? d : '';
}

function platformKey(kb, platform = process.platform) {
  if (platform === 'darwin' && kb.mac) return kb.mac;
  if (platform === 'win32' && kb.win) return kb.win;
  if (platform === 'linux' && kb.linux) return kb.linux;
  return kb.key;
}

/**
 * @param {object} packageJSON
 * @param {string} extensionPath
 */
function readContributions(packageJSON, extensionPath, language) {
  const c = (packageJSON && packageJSON.contributes) || {};
  const nls = extensionPath ? loadNls(extensionPath, language) : {};
  const paletteWhen = new Map();
  for (const m of (c.menus && c.menus.commandPalette) || []) {
    if (m && m.command) paletteWhen.set(m.command, m.when);
  }
  const commands = (Array.isArray(c.commands) ? c.commands : c.commands ? [c.commands] : [])
    .filter((x) => x && typeof x.command === 'string')
    .map((x) => {
      const when = paletteWhen.get(x.command);
      const title = localize(x.title, nls);
      const category = x.category ? localize(x.category, nls) : undefined;
      return {
        command: x.command,
        title: String(title && !isPlaceholder(title) ? title : x.command),
        category: category && !isPlaceholder(category) ? String(category) : undefined,
        enablement: x.enablement,
        icon: typeof x.icon === 'string' ? x.icon : undefined,
        // `"when": "false"` no commandPalette = escondido da Paleta.
        paletteWhen: when,
        hidden: when === 'false',
      };
    });
  const keybindings = (Array.isArray(c.keybindings) ? c.keybindings : c.keybindings ? [c.keybindings] : [])
    .filter((k) => k && typeof k.command === 'string' && platformKey(k))
    .map((k) => ({ command: k.command, key: String(platformKey(k)).toLowerCase(), when: k.when, args: k.args }));
  const editorTitle = ((c.menus && c.menus['editor/title']) || [])
    .filter((m) => m && typeof m.command === 'string')
    .map((m) => ({ command: m.command, when: m.when, group: m.group }));
  // Menus de comentários (botões dos threads no editor) — ver shim/comments.js.
  const menus = {};
  for (const key of ['comments/commentThread/title', 'comments/commentThread/context', 'comments/comment/title', 'comments/comment/context']) {
    menus[key] = ((c.menus && c.menus[key]) || []).filter((m) => m && typeof m.command === 'string').map((m) => ({ command: m.command, when: m.when, group: m.group }));
  }
  const viewsContainers = {};
  for (const [loc, list] of Object.entries(c.viewsContainers || {})) {
    viewsContainers[loc] = (list || []).map((v) => {
      const title = localize(v.title, nls);
      return { id: v.id, title: String(title && !isPlaceholder(title) ? title : v.id), icon: v.icon };
    });
  }
  const views = [];
  for (const [container, list] of Object.entries(c.views || {})) {
    for (const v of list || []) {
      const name = localize(v.name, nls);
      views.push({ id: v.id, name: String(name && !isPlaceholder(name) ? name : v.id), type: v.type || 'tree', container, when: v.when });
    }
  }
  return { commands, keybindings, editorTitle, menus, viewsContainers, views };
}

module.exports = { readContributions, localize, loadNls, nlsChain, localizeManifest, displayNameOf, descriptionOf, isPlaceholder, platformKey };
