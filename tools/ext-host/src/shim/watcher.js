// `workspace.createFileSystemWatcher` sem polling (enquanto der): `fs.watch`
// (inotify no Linux, FSEvents no macOS, ReadDirectoryChangesW no Windows), uma
// instância compartilhada por pasta-base. Eventos coalescidos por caminho
// (50 ms) e classificados em create/change/delete pelo `stat`.
//
// Frugalidade (o inotify é um recurso do SISTEMA, dividido com VS Code, Dev
// Kit, tsserver…):
// - Linux: recursão manual (o `recursive: true` do Node registraria um watch
//   por pasta da árvore inteira) com walk ASSÍNCRONO — nunca trava o event
//   loop do host;
// - pula pastas pesadas (node_modules, .git, target…), `.claude/worktrees`,
//   pastas ignoradas pelo `.gitignore` e `files.watcherExclude`;
// - orçamento GLOBAL de watches (todas as pastas-base somadas), não por raiz;
// - ENOSPC/EMFILE (limite do inotify) ou orçamento esgotado → a pasta-base cai
//   para polling (stat periódico) e UM aviso vai para a Saída "Extensões"
//   sugerindo aumentar `fs.inotify.max_user_watches` no Linux;
// - macOS/Windows (recursivo nativo): eventos de pastas puladas são
//   descartados na entrada, sem enxurrada de node_modules.
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist', '.vs', '.idea', '.next', '.cache', '__pycache__']);
/** Caminhos relativos (POSIX) sempre pulados: cópias inteiras do repositório. */
const SKIP_REL_DIRS = ['.claude/worktrees'];
/** Orçamento global padrão de watches (soma de todas as pastas-base). */
const DEFAULT_MAX_WATCHES = 8000;
const COALESCE_MS = 50;
const DEFAULT_POLL_MS = 2000;
/** Teto de arquivos acompanhados por polling numa pasta-base. */
const POLL_MAX_FILES = 20000;
/** Teto do mapa create/change (memória). */
const KNOWN_MAX = 20000;
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

// ------------------------------------------------------------------ globs ---

/** Glob (gitignore / VS Code) → fonte de regex, sem âncoras. */
function globSource(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(globSource).join('|') + ')';
        i = end;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += '[' + glob.slice(i + 1, end).replace(/^!/, '^') + ']';
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return re;
}

/**
 * `files.watcherExclude` ({glob: bool} ou lista) → regexes sobre o caminho
 * relativo. Um padrão casa a pasta OU qualquer coisa abaixo dela.
 */
function compileExcludes(value) {
  const globs = Array.isArray(value) ? value : Object.entries(value || {}).filter(([, on]) => on).map(([g]) => g);
  const out = [];
  for (const g of globs) {
    if (typeof g !== 'string' || !g.trim()) continue;
    try {
      out.push(new RegExp('^' + globSource(g.trim().replace(/\\/g, '/')) + '(?:/.*)?$'));
    } catch {
      /* glob inválido: ignora */
    }
  }
  return out;
}

/**
 * `.gitignore` mínimo, só para decidir quais PASTAS não observar (um falso
 * negativo custa um watch a mais; nunca perde evento de arquivo rastreado).
 * Suporta: comentários, `!negação` (a última regra vence), `/âncora`,
 * `pasta/` (só pastas), `*`, `?`, `**`.
 */
class GitIgnore {
  constructor() {
    this.rules = []; // { re, negate }
  }
  /** Regras de um `.gitignore` em `baseRel` ('' = raiz). */
  add(text, baseRel) {
    const prefix = baseRel ? baseRel.replace(/\/+$/, '') + '/' : '';
    for (let line of String(text).split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      line = line.replace(/(?<!\\)\s+$/, '');
      if (!line) continue;
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      }
      line = line.replace(/\/+$/, ''); // `pasta/` — aqui só testamos pastas
      if (!line) continue;
      const anchored = line.includes('/');
      const body = globSource(line.replace(/^\//, ''));
      const src = anchored ? `^${escapeRe(prefix)}${body}(?:/.*)?$` : `^${escapeRe(prefix)}(?:.*/)?${body}(?:/.*)?$`;
      try {
        this.rules.push({ re: new RegExp(src), negate });
      } catch {
        /* padrão inválido */
      }
    }
  }
  ignores(rel) {
    let ignored = false;
    for (const r of this.rules) if (r.re.test(rel)) ignored = !r.negate;
    return ignored;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function isSkippedRel(rel) {
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  return SKIP_REL_DIRS.some((s) => rel === s || rel.startsWith(s + '/') || rel.includes('/' + s + '/') || rel.endsWith('/' + s));
}

// ---------------------------------------------------------------- polling ---

/** Fallback sem inotify: `stat` periódico da árvore (com as mesmas exclusões). */
class Poller {
  constructor(dirWatch, intervalMs) {
    this.dw = dirWatch;
    this.snapshot = null; // abs → "mtime:size"
    this.busy = false;
    this.timer = setInterval(() => this.tick(), intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.tick();
  }
  async scan() {
    const dw = this.dw;
    const out = new Map();
    const queue = [dw.root];
    while (queue.length && !dw.closed && out.size < POLL_MAX_FILES) {
      const dir = queue.shift();
      let ents;
      try {
        ents = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (dw.recursive && !dw.skipDir(abs, e.name)) queue.push(abs);
        } else {
          try {
            const st = await fs.promises.stat(abs);
            out.set(abs, `${st.mtimeMs}:${st.size}`);
          } catch {
            /* sumiu no meio do caminho */
          }
          if (out.size >= POLL_MAX_FILES) break;
        }
      }
    }
    return out;
  }
  async tick() {
    if (this.busy || this.dw.closed) return;
    this.busy = true;
    try {
      const next = await this.scan();
      if (this.dw.closed) return;
      if (this.snapshot) {
        for (const [abs, sig] of next) if (this.snapshot.get(abs) !== sig) this.dw.onPath(abs);
        for (const abs of this.snapshot.keys()) if (!next.has(abs)) this.dw.onPath(abs);
      }
      this.snapshot = next;
    } finally {
      this.busy = false;
    }
  }
  close() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------- watches ---

class DirWatch {
  /**
   * @param {WatchService} service
   * @param {string} root
   * @param {boolean} recursive
   * @param {(abs:string)=>void} onPath
   */
  constructor(service, root, recursive, onPath) {
    this.service = service;
    this.root = root;
    this.recursive = recursive;
    this.onPath = onPath;
    this.watchers = new Map(); // dir → FSWatcher
    this.poller = null;
    this.closed = false;
    this.ignore = new GitIgnore();
    this.ready = this.start();
  }
  get nativeRecursive() {
    return this.service.nativeRecursive;
  }
  /** Pasta que não vale observar (pesada, worktree, gitignore, watcherExclude). */
  skipDir(abs, name) {
    if (SKIP_DIRS.has(name)) return true;
    const rel = toRel(this.root, abs);
    if (isSkippedRel(rel)) return true;
    if (this.ignore.ignores(rel)) return true;
    return this.service.excluded(rel);
  }
  /** Evento de um caminho dentro de pasta pulada? (recursivo nativo). */
  skipEvent(abs) {
    const rel = toRel(this.root, abs);
    return isSkippedRel(rel) || this.service.excluded(rel);
  }
  async loadIgnore(dir) {
    try {
      const text = await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8');
      this.ignore.add(text, toRel(this.root, dir));
    } catch {
      /* sem .gitignore aqui */
    }
  }
  async start() {
    await this.loadIgnore(this.root);
    if (this.closed) return;
    if (!this.add(this.root)) return;
    if (this.recursive && !this.nativeRecursive) await this.walk(this.root);
  }
  /** Walk assíncrono em largura: um `readdir` por vez, sem bloquear o loop. */
  async walk(start) {
    const queue = [start];
    while (queue.length && !this.closed && !this.poller) {
      const dir = queue.shift();
      // A raiz já foi observada (e seu .gitignore lido) em `start`.
      if (dir !== this.root) {
        if (!this.add(dir)) return;
        await this.loadIgnore(dir);
      }
      let ents;
      try {
        ents = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (this.closed) return;
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const abs = path.join(dir, e.name);
        if (!this.skipDir(abs, e.name)) queue.push(abs);
      }
    }
  }
  /** Observa `dir`. `false` = degradou para polling (parar o walk). */
  add(dir) {
    if (this.closed || this.poller) return false;
    if (this.watchers.has(dir)) return true;
    if (!this.service.reserve()) {
      this.degrade('budget');
      return false;
    }
    let w;
    try {
      w = this.service.watchImpl(dir, { recursive: this.recursive && this.nativeRecursive, persistent: false }, (_type, name) => {
        if (!name || this.closed) return;
        const abs = path.join(dir, String(name));
        if (this.nativeRecursive && this.skipEvent(abs)) return;
        this.onPath(abs);
        if (this.recursive && !this.nativeRecursive) {
          // Pasta nova: passa a observá-la também.
          fs.stat(abs, (err, st) => {
            if (!err && st.isDirectory() && !this.skipDir(abs, path.basename(abs))) void this.walk(abs);
          });
        }
      });
    } catch (err) {
      this.service.release();
      if (err && (err.code === 'ENOSPC' || err.code === 'EMFILE')) {
        this.degrade('enospc', err);
        return false;
      }
      this.service.log(`[watcher] não foi possível observar ${dir}: ${err && err.message}`);
      return true; // pasta ilegível: segue o walk nas outras
    }
    w.on('error', (err) => {
      if (err && (err.code === 'ENOSPC' || err.code === 'EMFILE')) this.degrade('enospc', err);
      else this.remove(dir);
    });
    this.watchers.set(dir, w);
    return true;
  }
  /** Sem inotify (limite do sistema) ou sem orçamento: polling desta raiz. */
  degrade(reason, err) {
    if (this.poller || this.closed) return;
    this.service.warnDegraded(reason, this.root, err);
    for (const d of [...this.watchers.keys()]) this.remove(d);
    this.poller = new Poller(this, this.service.pollMs);
  }
  remove(dir) {
    const w = this.watchers.get(dir);
    if (w) {
      try {
        w.close();
      } catch {
        /* ignora */
      }
      this.watchers.delete(dir);
      this.service.release();
    }
  }
  close() {
    this.closed = true;
    for (const d of [...this.watchers.keys()]) this.remove(d);
    if (this.poller) this.poller.close();
    this.poller = null;
  }
}

class WatchService {
  /**
   * @param {(msg:string)=>void} [log]
   * @param {{ maxWatches?: number, pollMs?: number, watchImpl?: typeof fs.watch,
   *   excludes?: () => unknown, nativeRecursive?: boolean }} [opts]
   */
  constructor(log, opts = {}) {
    this.log = log || (() => {});
    this.maxWatches = opts.maxWatches || Number(process.env.FLUENT_WATCH_LIMIT) || DEFAULT_MAX_WATCHES;
    this.pollMs = opts.pollMs || DEFAULT_POLL_MS;
    this.watchImpl = opts.watchImpl || fs.watch;
    this.nativeRecursive = opts.nativeRecursive ?? NATIVE_RECURSIVE;
    this.excludesFn = opts.excludes || (() => null);
    this.active = 0; // watches vivos (todas as raízes)
    this.warned = new Set();
    this.roots = new Map(); // `${root}|${recursive}` → { dirWatch, subs:Set }
    this.pending = new Map(); // abs → timer
    this.known = new Map(); // abs → existia (para distinguir create/change)
    this._excl = null;
    this._exclKey = undefined;
  }
  reserve() {
    if (this.active >= this.maxWatches) return false;
    this.active++;
    return true;
  }
  release() {
    if (this.active > 0) this.active--;
  }
  /** `files.watcherExclude` atual (recompilado só quando muda). */
  excluded(rel) {
    let value;
    try {
      value = this.excludesFn();
    } catch {
      value = null;
    }
    const key = JSON.stringify(value ?? null);
    if (key !== this._exclKey) {
      this._exclKey = key;
      this._excl = compileExcludes(value);
    }
    return this._excl.some((re) => re.test(rel));
  }
  /** Um aviso por motivo, na Saída "Extensões" (via log do host). */
  warnDegraded(reason, root, err) {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    if (reason === 'enospc') {
      const linux =
        process.platform === 'linux'
          ? ' No Linux, aumente o limite: echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-inotify.conf && sudo sysctl --system'
          : '';
      this.log(
        `[watcher] o sistema recusou novos watches (${(err && err.code) || 'ENOSPC'}) em ${root}; essa pasta passa a ser acompanhada por polling (a cada ${this.pollMs / 1000}s), com mudanças detectadas com atraso.${linux}`,
      );
    } else {
      this.log(
        `[watcher] limite de ${this.maxWatches} pastas observadas atingido em ${root}; o restante passa a ser acompanhado por polling. Exclua pastas grandes em files.watcherExclude (ou ajuste FLUENT_WATCH_LIMIT).`,
      );
    }
  }
  /**
   * @param {string} root pasta-base
   * @param {RegExp} matcher sobre o caminho relativo POSIX à base
   * @param {boolean} recursive
   * @param {(kind:'create'|'change'|'delete', abs:string)=>void} cb
   */
  subscribe(root, matcher, recursive, cb) {
    root = path.resolve(root);
    const key = `${root}|${recursive ? 1 : 0}`;
    let entry = this.roots.get(key);
    if (!entry) {
      if (!fs.existsSync(root)) {
        // Base ainda não existe (ex.: pasta de config criada depois): sem erro.
        entry = { dirWatch: null, subs: new Set(), root };
      } else {
        entry = { subs: new Set(), root };
        entry.dirWatch = new DirWatch(this, root, recursive, (abs) => this._queue(entry, abs));
      }
      this.roots.set(key, entry);
    }
    const sub = { matcher, cb };
    entry.subs.add(sub);
    return () => {
      entry.subs.delete(sub);
      if (!entry.subs.size) {
        if (entry.dirWatch) entry.dirWatch.close();
        this.roots.delete(key);
      }
    };
  }
  /** Resolve quando os walks iniciais terminaram (testes/diagnóstico). */
  whenIdle() {
    return Promise.all([...this.roots.values()].map((e) => (e.dirWatch ? e.dirWatch.ready : null)));
  }
  _queue(entry, abs) {
    const key = abs;
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        fs.stat(abs, (err) => {
          const exists = !err;
          const before = this.known.get(abs);
          if (this.known.size >= KNOWN_MAX) this.known.clear();
          this.known.set(abs, exists);
          if (!exists && before === false) return;
          const kind = !exists ? 'delete' : before === true ? 'change' : this._guessCreate(abs) ? 'create' : 'change';
          if (!exists) this.known.delete(abs);
          this.dispatch(entry, kind, abs);
        });
      }, COALESCE_MS),
    );
  }
  _guessCreate(abs) {
    // Sem histórico: arquivo criado há < 1s conta como "create".
    try {
      const st = fs.statSync(abs);
      return Date.now() - (st.birthtimeMs || st.ctimeMs) < 1000;
    } catch {
      return false;
    }
  }
  dispatch(entry, kind, abs) {
    const rel = toRel(entry.root, abs);
    if (rel.startsWith('..')) return;
    for (const s of entry.subs) {
      if (s.matcher.test(rel)) {
        try {
          s.cb(kind, abs);
        } catch (err) {
          this.log(`[watcher] callback falhou: ${err && err.message}`);
        }
      }
    }
  }
  /** Notificação externa (o app salvou/criou via outra via): reaproveita os filtros. */
  notify(kind, abs) {
    for (const entry of this.roots.values()) this.dispatch(entry, kind, abs);
  }
  closeAll() {
    for (const e of this.roots.values()) if (e.dirWatch) e.dirWatch.close();
    this.roots.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
  get watchCount() {
    let n = 0;
    for (const e of this.roots.values()) n += e.dirWatch ? e.dirWatch.watchers.size : 0;
    return n;
  }
  /** Pastas-base acompanhadas por polling (degradadas). */
  get pollingCount() {
    let n = 0;
    for (const e of this.roots.values()) if (e.dirWatch && e.dirWatch.poller) n++;
    return n;
  }
}

module.exports = { WatchService, SKIP_DIRS, GitIgnore, compileExcludes, isSkippedRel, DEFAULT_MAX_WATCHES };
