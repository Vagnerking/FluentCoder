// `workspace.createFileSystemWatcher` sem polling: `fs.watch` (inotify no
// Linux, FSEvents no macOS, ReadDirectoryChangesW no Windows), uma instância
// compartilhada por pasta-base. Recursão manual no Linux para pular pastas
// pesadas (node_modules, .git, target…) — o `recursive: true` do Node no Linux
// registraria um inotify por pasta da árvore inteira. Eventos coalescidos por
// caminho (50 ms) e classificados em create/change/delete pelo `stat`.
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist', '.vs', '.idea', '.next', '.cache', '__pycache__']);
const MAX_DIR_WATCHES = 4000;
const COALESCE_MS = 50;
const NATIVE_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

class DirWatch {
  /** @param {string} root @param {boolean} recursive @param {(abs:string)=>void} onPath */
  constructor(root, recursive, onPath, log) {
    this.root = root;
    this.recursive = recursive;
    this.onPath = onPath;
    this.log = log || (() => {});
    this.watchers = new Map(); // dir → FSWatcher
    this.add(root);
  }
  add(dir) {
    if (this.watchers.has(dir) || this.watchers.size >= MAX_DIR_WATCHES) return;
    let w;
    try {
      w = fs.watch(dir, { recursive: this.recursive && NATIVE_RECURSIVE, persistent: false }, (_type, name) => {
        if (!name) return;
        const abs = path.join(dir, String(name));
        this.onPath(abs);
        if (this.recursive && !NATIVE_RECURSIVE) {
          // Pasta nova: passa a observá-la também.
          fs.stat(abs, (err, st) => {
            if (!err && st.isDirectory() && !SKIP_DIRS.has(path.basename(abs))) this.walk(abs);
          });
        }
      });
    } catch (err) {
      this.log(`[watcher] não foi possível observar ${dir}: ${err.message}`);
      return;
    }
    w.on('error', () => this.remove(dir));
    this.watchers.set(dir, w);
    if (this.recursive && !NATIVE_RECURSIVE && dir === this.root) this.walk(dir, true);
  }
  walk(dir, skipSelf) {
    if (!skipSelf) this.add(dir);
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) this.walk(path.join(dir, e.name));
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
    }
  }
  close() {
    for (const d of [...this.watchers.keys()]) this.remove(d);
  }
}

class WatchService {
  constructor(log) {
    this.log = log || (() => {});
    this.roots = new Map(); // `${root}|${recursive}` → { dirWatch, subs:Set }
    this.pending = new Map(); // abs → timer
    this.known = new Map(); // abs → existia (para distinguir create/change)
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
        entry.dirWatch = new DirWatch(root, recursive, (abs) => this._queue(entry, abs), this.log);
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
    const rel = path.relative(entry.root, abs).split(path.sep).join('/');
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
}

module.exports = { WatchService, SKIP_DIRS };
