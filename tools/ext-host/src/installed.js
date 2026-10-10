// Descobre extensões VS Code instaladas localmente (somente leitura). Não
// copiamos nem redistribuímos nada: carregamos direto da pasta do usuário.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContributions } = require('./contributions');

/** Extensões que o PoC sabe hospedar (as demais são listadas como não suportadas). */
const SUPPORTED = new Map([
  ['anthropic.claude-code', { label: 'Claude Code', viewIds: ['claudeVSCodeSidebarSecondary', 'claudeVSCodeSidebar'] }],
  ['openai.chatgpt', { label: 'Codex', viewIds: ['chatgpt.sidebarSecondaryView', 'chatgpt.sidebarView'] }],
]);

function extensionDirs() {
  const dirs = [];
  if (process.env.FLUENT_VSCODE_EXTENSIONS_DIR) dirs.push(process.env.FLUENT_VSCODE_EXTENSIONS_DIR);
  dirs.push(path.join(os.homedir(), '.vscode', 'extensions'));
  return dirs;
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function platformTag() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  const plat = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${plat}-${arch}`;
}

/** Lista a versão mais nova de cada extensão encontrada. */
function listInstalled(dirs = extensionDirs()) {
  const best = new Map();
  const tag = platformTag();
  for (const dir of dirs) {
    let obsolete = {};
    try {
      obsolete = JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf8')) || {};
    } catch {
      /* sem .obsolete */
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || obsolete[e.name]) continue;
      const extPath = path.join(dir, e.name);
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(extPath, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      if (!pkg.publisher || !pkg.name) continue;
      // Pacotes específicos de outra plataforma (ex.: -darwin-arm64) são ignorados.
      const m = /-(win32|linux|darwin|alpine)-(x64|arm64|armhf|ia32)$/.exec(e.name);
      if (m && `${m[1]}-${m[2]}` !== tag) continue;
      const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
      const info = {
        id,
        path: extPath,
        version: pkg.version,
        displayName: pkg.displayName || pkg.name,
        supported: SUPPORTED.has(id),
        label: SUPPORTED.has(id) ? SUPPORTED.get(id).label : pkg.displayName || pkg.name,
        viewIds: SUPPORTED.has(id) ? SUPPORTED.get(id).viewIds : [],
      };
      if (info.supported) {
        // Comandos/atalhos contribuídos: a Paleta do app os lista antes da ativação.
        const c = readContributions(pkg, extPath);
        info.commands = c.commands.filter((x) => !x.hidden).map(({ command, title, category, paletteWhen }) => ({ command, title, category, paletteWhen }));
        info.keybindings = c.keybindings;
      }
      const prev = best.get(id);
      if (!prev || compareVersions(info.version, prev.version) > 0) best.set(id, info);
    }
  }
  return [...best.values()].sort((a, b) => Number(b.supported) - Number(a.supported) || a.id.localeCompare(b.id));
}

module.exports = { listInstalled, compareVersions, SUPPORTED, extensionDirs, platformTag };
