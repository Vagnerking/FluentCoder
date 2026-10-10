// Lê o `contributes` do package.json de uma extensão e normaliza o que o
// Fluent Coder honra: comandos (Paleta), keybindings (best effort), menus
// `editor/title` (aceitar/rejeitar diff), views/viewsContainers (metadados).
// Títulos `%chave%` são resolvidos pelo package.nls(.pt-br).json.
'use strict';
const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Mensagens localizadas da extensão (pt-br > padrão). */
function loadNls(extensionPath, language = 'pt-br') {
  const base = readJson(path.join(extensionPath, 'package.nls.json')) || {};
  const loc = readJson(path.join(extensionPath, `package.nls.${language}.json`)) || {};
  return { ...base, ...loc };
}

function localize(value, nls) {
  if (typeof value !== 'string') return value && typeof value === 'object' && value.value ? value.value : value;
  const m = /^%(.+)%$/.exec(value);
  if (!m) return value;
  const v = nls[m[1]];
  return typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.message === 'string' ? v.message : value;
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
      return {
        command: x.command,
        title: String(localize(x.title, nls) || x.command),
        category: x.category ? String(localize(x.category, nls)) : undefined,
        enablement: x.enablement,
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
  const viewsContainers = {};
  for (const [loc, list] of Object.entries(c.viewsContainers || {})) {
    viewsContainers[loc] = (list || []).map((v) => ({ id: v.id, title: String(localize(v.title, nls) || v.id), icon: v.icon }));
  }
  const views = [];
  for (const [container, list] of Object.entries(c.views || {})) {
    for (const v of list || []) views.push({ id: v.id, name: String(localize(v.name, nls) || v.id), type: v.type || 'tree', container, when: v.when });
  }
  return { commands, keybindings, editorTitle, viewsContainers, views };
}

module.exports = { readContributions, localize, loadNls, platformKey };
