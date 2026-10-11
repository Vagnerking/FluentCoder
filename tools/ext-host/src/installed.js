// Descobre as extensões VS Code que o host pode carregar. Duas origens:
//   1. pasta GERENCIADA pelo app (`<app_data>/extensions/`, índice
//      `extensions.json` escrito pelo backend Rust — src-tauri/src/extensions/);
//   2. `~/.vscode/extensions` do usuário, SOMENTE LEITURA ("do VS Code").
// Mesmo id nas duas → vence a gerenciada (o usuário instalou/importou no app).
//
// "supported" = pode rodar NESTE host. Não é mais uma allowlist fixa de ids:
// é o portão de compatibilidade (o app classifica a extensão e grava o
// veredito no índice). Claude Code e Codex são "embutidas": validadas contra
// o shim (flows-check) e liberadas por padrão — o usuário pode desabilitá-las.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readContributions } = require('./contributions');
const { VSCODE_VERSION } = require('./shim/api');

/** Extensões embutidas: rótulo curto e views de webview preferidas (Fluent Chat). */
const BUILTIN = new Map([
  ['anthropic.claude-code', { label: 'Claude Code', viewIds: ['claudeVSCodeSidebarSecondary', 'claudeVSCodeSidebar'] }],
  ['openai.chatgpt', { label: 'Codex', viewIds: ['chatgpt.sidebarSecondaryView', 'chatgpt.sidebarView'] }],
]);
/** Compatibilidade retroativa (testes/código antigo). */
const SUPPORTED = BUILTIN;

/** Vereditos do portão que liberam a execução (Parcial roda com limitações). */
const RUNNABLE_VERDICTS = new Set(['compatible', 'partial']);

const ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;
const DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

function extensionDirs() {
  const dirs = [];
  if (process.env.FLUENT_VSCODE_EXTENSIONS_DIR) dirs.push(process.env.FLUENT_VSCODE_EXTENSIONS_DIR);
  dirs.push(path.join(os.homedir(), '.vscode', 'extensions'));
  return dirs;
}

/** Pasta gerenciada pelo app (null = só a do VS Code). */
function managedDir(explicit) {
  return process.env.FLUENT_APP_EXTENSIONS_DIR || explicit || null;
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Índice `extensions.json` da pasta gerenciada (formato em docs/context/extensoes-vscode.md). */
function readIndex(dir) {
  const raw = dir ? readJson(path.join(dir, 'extensions.json')) : null;
  const index = { extensions: {}, vscode: {} };
  if (!raw || typeof raw !== 'object') return index;
  for (const key of ['extensions', 'vscode']) {
    const src = raw[key];
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [id, v] of Object.entries(src)) if (ID_RE.test(id) && v && typeof v === 'object') index[key][id] = v;
    }
  }
  return index;
}

/** O veredito gravado vale para ESTA versão da extensão e ESTE shim? */
function gateAllows(gate, version, trust) {
  if (!gate || gate.version !== version || gate.hostVersion !== VSCODE_VERSION) return false;
  if (RUNNABLE_VERDICTS.has(gate.verdict)) return true;
  // "Não avaliada" + liberação EXPLÍCITA do usuário para esta versão e este
  // shim (confirmada na view Extensões). Incompatível nunca é liberável.
  return gate.verdict === 'unknown' && trustAllows(trust, version);
}

function trustAllows(trust, version) {
  return !!(trust && typeof trust === 'object' && trust.version === version && trust.hostVersion === VSCODE_VERSION);
}

function webviewViewIds(pkg) {
  const views = (pkg.contributes && pkg.contributes.views) || {};
  const ids = [];
  for (const list of Object.values(views)) {
    if (!Array.isArray(list)) continue;
    for (const v of list) if (v && typeof v.id === 'string' && v.type === 'webview') ids.push(v.id);
  }
  return ids;
}

const ICON_MAX_BYTES = 64 * 1024;
const ICON_MIME = { '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * Ícone do pacote como data URI (SVG/PNG ≤ 64 KB, dentro da pasta da
 * extensão). A UI do app o usa como máscara monocromática (aba da view,
 * activity bar, ações do título do editor) — nunca como documento.
 */
function iconDataUri(extPath, rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('$(')) return undefined;
  const abs = path.resolve(extPath, rel);
  const root = path.resolve(extPath) + path.sep;
  if (!abs.startsWith(root)) return undefined;
  const mime = ICON_MIME[path.extname(abs).toLowerCase()];
  if (!mime) return undefined;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > ICON_MAX_BYTES) return undefined;
    return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Ícone de um comando/contêiner: string, `{light,dark}` (prefere o escuro) ou `$(codicon)`. */
function iconSpec(extPath, icon) {
  if (typeof icon === 'string') {
    const m = /^\$\(([a-z0-9-]+)\)$/.exec(icon);
    if (m) return { codicon: m[1] };
    const src = iconDataUri(extPath, icon);
    return src ? { src } : undefined;
  }
  if (icon && typeof icon === 'object') {
    const src = iconDataUri(extPath, icon.dark) || iconDataUri(extPath, icon.light);
    return src ? { src } : undefined;
  }
  return undefined;
}

/** Ícone do contêiner da view (secundária > activity bar > ícone do pacote). */
function viewIcon(pkg, extPath) {
  const vc = (pkg.contributes && pkg.contributes.viewsContainers) || {};
  for (const loc of ['secondarySidebar', 'activitybar', 'panel']) {
    for (const c of Array.isArray(vc[loc]) ? vc[loc] : []) {
      const spec = c && iconSpec(extPath, c.icon);
      if (spec && spec.src) return spec.src;
    }
  }
  return iconDataUri(extPath, pkg.icon);
}

/**
 * Botões `editor/title` (grupo `navigation`) contribuídos, com título e ícone
 * do comando. Os de aceitar/rejeitar diff ficam de fora: a revisão de diff do
 * app já os chama (host.diffAction).
 */
function editorTitleActions(pkg, extPath, contributions) {
  const raw = new Map(((pkg.contributes && pkg.contributes.commands) || []).filter((c) => c && typeof c.command === 'string').map((c) => [c.command, c]));
  const titles = new Map(contributions.commands.map((c) => [c.command, c]));
  return contributions.editorTitle
    .filter((m) => String(m.group || '').startsWith('navigation') && !/(accept|reject)ProposedDiff$/i.test(m.command))
    .map((m) => {
      const c = titles.get(m.command);
      if (!c) return null;
      return {
        command: m.command,
        title: c.category ? `${c.category}: ${c.title}` : c.title,
        when: m.when,
        icon: iconSpec(extPath, (raw.get(m.command) || {}).icon),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function wantsStartup(pkg) {
  const ev = Array.isArray(pkg.activationEvents) ? pkg.activationEvents : [];
  return ev.includes('*') || ev.includes('onStartupFinished');
}

function describe(pkg, extPath, source, index) {
  const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
  const builtin = BUILTIN.get(id);
  const record = source === 'app' ? index.extensions[id] : index.vscode[id];
  // Embutidas rodam por padrão; as demais só depois de habilitadas no app.
  const enabled = record && typeof record.enabled === 'boolean' ? record.enabled : !!builtin;
  const gate = record && record.gate;
  const trust = record && record.trust;
  const gateOk = builtin ? true : gateAllows(gate, pkg.version, trust);
  const supported = enabled && gateOk;
  const info = {
    id,
    path: extPath,
    version: pkg.version,
    displayName: pkg.displayName || pkg.name,
    publisher: pkg.publisher,
    source,
    builtin: !!builtin,
    enabled,
    supported,
    /** Roda por liberação explícita do usuário (código "Não avaliado"). */
    trusted: !builtin && supported && !!gate && gate.verdict === 'unknown',
    blockedReason: supported ? undefined : !enabled ? 'disabled' : gate && gate.verdict && !RUNNABLE_VERDICTS.has(gate.verdict) ? gate.verdict : 'not-evaluated',
    label: builtin ? builtin.label : pkg.displayName || pkg.name,
    viewIds: builtin ? builtin.viewIds : webviewViewIds(pkg),
    activateOnStartup: !builtin && wantsStartup(pkg),
  };
  if (supported) {
    // Comandos/atalhos contribuídos: a Paleta do app os lista antes da ativação.
    const c = readContributions(pkg, extPath);
    info.commands = c.commands.filter((x) => !x.hidden).map(({ command, title, category, paletteWhen }) => ({ command, title, category, paletteWhen }));
    info.keybindings = c.keybindings;
    info.icon = viewIcon(pkg, extPath);
    info.editorTitle = editorTitleActions(pkg, extPath, c);
  }
  return info;
}

/** Extensões da pasta gerenciada, conforme o índice (pastas fora do índice são ignoradas). */
function scanManaged(dir, index, tag) {
  const out = [];
  for (const [id, rec] of Object.entries(index.extensions)) {
    if (typeof rec.dir !== 'string' || !DIR_RE.test(rec.dir) || rec.dir.includes('..')) continue;
    const extPath = path.join(dir, rec.dir);
    const pkg = readJson(path.join(extPath, 'package.json'));
    if (!pkg || !pkg.publisher || !pkg.name) continue;
    if (`${pkg.publisher}.${pkg.name}`.toLowerCase() !== id) continue;
    const tp = rec.targetPlatform;
    if (tp && tp !== 'universal' && tp !== 'web' && tp !== tag) continue;
    out.push({ pkg, extPath });
  }
  return out;
}

/** Extensões do VS Code (somente leitura); versão mais nova de cada id. */
function scanVscode(dirs, tag) {
  const out = [];
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
      const pkg = readJson(path.join(extPath, 'package.json'));
      if (!pkg || !pkg.publisher || !pkg.name) continue;
      // Pacotes específicos de outra plataforma (ex.: -darwin-arm64) são ignorados.
      const m = /-(win32|linux|darwin|alpine)-(x64|arm64|armhf|ia32)$/.exec(e.name);
      if (m && `${m[1]}-${m[2]}` !== tag) continue;
      out.push({ pkg, extPath });
    }
  }
  return out;
}

/**
 * Lista a versão carregável de cada extensão (gerenciada > VS Code).
 * @param {{ managed?: string|null, vscodeDirs?: string[] }|string[]} [opts]
 */
function listInstalled(opts = {}) {
  // Assinatura antiga: listInstalled(dirs).
  if (Array.isArray(opts)) opts = { vscodeDirs: opts, managed: null };
  const tag = platformTag();
  const mdir = managedDir(opts.managed);
  const index = readIndex(mdir);
  const best = new Map();
  if (mdir) {
    for (const { pkg, extPath } of scanManaged(mdir, index, tag)) best.set(`${pkg.publisher}.${pkg.name}`.toLowerCase(), describe(pkg, extPath, 'app', index));
  }
  const fromVscode = new Map();
  for (const { pkg, extPath } of scanVscode(opts.vscodeDirs || extensionDirs(), tag)) {
    const id = `${pkg.publisher}.${pkg.name}`.toLowerCase();
    const prev = fromVscode.get(id);
    if (!prev || compareVersions(pkg.version, prev.pkg.version) > 0) fromVscode.set(id, { pkg, extPath });
  }
  for (const [id, { pkg, extPath }] of fromVscode) {
    if (best.has(id)) continue; // a gerenciada vence
    best.set(id, describe(pkg, extPath, 'vscode', index));
  }
  return [...best.values()].sort((a, b) => Number(b.supported) - Number(a.supported) || a.id.localeCompare(b.id));
}

module.exports = { listInstalled, compareVersions, SUPPORTED, BUILTIN, extensionDirs, managedDir, platformTag, readIndex, gateAllows, iconDataUri, iconSpec, editorTitleActions };
