// Monta o objeto `vscode` entregue a cada extensão (`require('vscode')`).
// Tudo que é estado compartilhado (comandos, documentos, editor ativo, webviews)
// vive no ExtensionHost; aqui ficam só as fachadas por namespace.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const types = require('./types');
const { WebviewPanel } = require('./webview');

const { Disposable, EventEmitter, Uri, FileSystemError, FileType, CancellationTokenSource } = types;

/**
 * Versão da API do VS Code anunciada às extensões e usada no `engines.vscode`
 * do classificador. POLÍTICA: é a versão do `vscode.d.ts` de onde sai o
 * universo da API (`src/extensions/vscode-api-surface.json`, teste
 * `apiScan.test.js` confere major.minor). Toda API desse universo é
 * classificada pelo `capabilities.json` (implementada/parcial/stub) ou conta
 * como AUSENTE — então quem declara `^1.108` e chama algo que o shim não tem é
 * barrado pela API usada, não pelo número. Subir o `@codingame/monaco-vscode-api`
 * (e com ele o .d.ts) exige revisar as APIs novas e então subir esta versão.
 */
const VSCODE_VERSION = '1.108.2';

function noopDisposable() {
  return new Disposable(() => {});
}

function toUri(v) {
  if (!v) return v;
  if (typeof v === 'string') return v.includes('://') || /^[a-z][\w+.-]*:/i.test(v) && !/^[a-zA-Z]:[\\/]/.test(v) ? Uri.parse(v) : Uri.file(v);
  return Uri.revive(v);
}

function fsErr(err, uri) {
  if (err && err.code === 'ENOENT') return FileSystemError.FileNotFound(uri);
  if (err && err.code === 'EEXIST') return FileSystemError.FileExists(uri);
  if (err && err.code === 'ENOTDIR') return FileSystemError.FileNotADirectory(uri);
  if (err && err.code === 'EISDIR') return FileSystemError.FileIsADirectory(uri);
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) return FileSystemError.NoPermissions(uri);
  return err;
}

/** Converte um glob do VS Code em RegExp sobre caminhos relativos POSIX. */
function globToRegExp(glob) {
  let g = String(glob || '**/*').replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        continue;
      }
      re += '(?:' + g.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1)).join('|') + ')';
      i = end;
    } else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += '[' + g.slice(i + 1, end).replace(/^!/, '^') + ']';
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const DEFAULT_SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'target', 'dist', '.vs', '.idea']);

async function walkFind(root, include, exclude, max) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude.test(r)) continue;
      if (e.isDirectory()) {
        if (!DEFAULT_SKIP.has(e.name)) stack.push(r);
      } else if (include.test(r)) {
        out.push(path.join(root, r));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

let statusSeq = 0;

/**
 * StatusBarItem: cada mudança (texto, tooltip, comando…) vai ao app num lote
 * por microtask (`statusBarItem`); hide/dispose removem (`visible:false`).
 */
function createStatusBarItem(host, ext, id, alignment, priority) {
  const state = { text: '', tooltip: undefined, command: undefined, name: undefined, color: undefined, backgroundColor: undefined, accessibilityInformation: undefined };
  let visible = false;
  let disposed = false;
  let queued = false;
  const flush = () => {
    queued = false;
    if (disposed) return;
    const cmd = state.command;
    host.emit({
      event: 'statusBarItem',
      id,
      extensionId: ext.id,
      visible,
      alignment: alignment === 2 ? 'right' : 'left',
      priority: typeof priority === 'number' ? priority : 0,
      text: String(state.text || ''),
      tooltip: typeof state.tooltip === 'string' ? state.tooltip : state.tooltip && state.tooltip.value ? String(state.tooltip.value) : undefined,
      name: state.name,
      command: typeof cmd === 'string' ? { command: cmd } : cmd && cmd.command ? { command: cmd.command, title: cmd.title, arguments: safeCommandArgs(cmd.arguments) } : undefined,
      color: state.color && state.color.id ? { themeColor: state.color.id } : typeof state.color === 'string' ? state.color : undefined,
      backgroundColor: state.backgroundColor && state.backgroundColor.id ? { themeColor: state.backgroundColor.id } : undefined,
    });
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };
  const item = {
    get id() {
      return id;
    },
    get alignment() {
      return alignment;
    },
    get priority() {
      return priority;
    },
    show() {
      visible = true;
      schedule();
    },
    hide() {
      visible = false;
      schedule();
    },
    dispose() {
      if (disposed) return;
      visible = false;
      flush();
      disposed = true;
      host.statusBarItems.delete(id);
    },
  };
  for (const key of Object.keys(state)) {
    Object.defineProperty(item, key, {
      enumerable: true,
      get: () => state[key],
      set: (v) => {
        state[key] = v;
        if (visible) schedule();
      },
    });
  }
  host.statusBarItems.set(id, item);
  return item;
}

function safeCommandArgs(args) {
  if (!Array.isArray(args)) return undefined;
  try {
    return JSON.parse(JSON.stringify(args));
  } catch {
    return undefined;
  }
}

/** FileSystemWatcher sobre o WatchService do host (sem polling). */
function createWatcher(host, globPattern, ignoreCreate, ignoreChange, ignoreDelete) {
  const created = new EventEmitter();
  const changed = new EventEmitter();
  const deleted = new EventEmitter();
  const subs = [];
  let base;
  let pattern;
  if (typeof globPattern === 'string') pattern = globPattern;
  else if (globPattern && typeof globPattern === 'object') {
    base = globPattern.baseUri ? toUri(globPattern.baseUri).fsPath : typeof globPattern.base === 'string' ? globPattern.base : undefined;
    pattern = globPattern.pattern;
  }
  pattern = String(pattern || '**/*');
  const recursive = pattern.includes('**') || pattern.includes('/');
  const roots = base ? [base] : path.isAbsolute(pattern) ? [] : host.workspaceFolders.map((f) => f.uri.fsPath);
  const matcher = globToRegExp(pattern);
  const cb = (kind, abs) => {
    host._onDiskChange(kind, abs);
    const uri = Uri.file(abs);
    if (kind === 'create' && !ignoreCreate) created.fire(uri);
    else if (kind === 'change' && !ignoreChange) changed.fire(uri);
    else if (kind === 'delete' && !ignoreDelete) deleted.fire(uri);
  };
  for (const r of roots) subs.push(host.watchers.subscribe(r, matcher, recursive, cb));
  return {
    ignoreCreateEvents: ignoreCreate,
    ignoreChangeEvents: ignoreChange,
    ignoreDeleteEvents: ignoreDelete,
    onDidCreate: created.event,
    onDidChange: changed.event,
    onDidDelete: deleted.event,
    dispose() {
      subs.splice(0).forEach((u) => u());
    },
  };
}

/** DiagnosticCollection: entra em getDiagnostics e vira markers no app. */
function createDiagnosticCollection(host, name) {
  const map = new Map();
  const coll = {
    name,
    set(uriOrEntries, diags) {
      if (Array.isArray(uriOrEntries)) {
        for (const [u, d] of uriOrEntries) coll.set(u, d);
        return;
      }
      if (!uriOrEntries) return;
      const uri = toUri(uriOrEntries);
      map.set(uri.toString(), { uri, list: diags || [] });
      host.publishCollection(name, uri, diags || []);
    },
    delete(uri) {
      uri = toUri(uri);
      if (map.delete(uri.toString())) host.publishCollection(name, uri, []);
    },
    clear() {
      for (const { uri } of map.values()) host.publishCollection(name, uri, []);
      map.clear();
    },
    forEach(cb, thisArg) {
      map.forEach(({ uri, list }) => cb.call(thisArg, uri, list, coll));
    },
    get: (uri) => (map.get(toUri(uri).toString()) || {}).list,
    has: (uri) => map.has(toUri(uri).toString()),
    [Symbol.iterator]: function* () {
      for (const { uri, list } of map.values()) yield [uri, list];
    },
    dispose() {
      coll.clear();
      host.diagnosticCollections.delete(coll);
    },
  };
  host.diagnosticCollections.add(coll);
  return coll;
}

/**
 * @param {import('../host').ExtensionHost} host
 * @param {object} ext descritor da extensão carregada ({ id, packageJSON, extensionPath, ... })
 */
function createVscodeApi(host, ext) {
  const log = (...a) => host.log(`[${ext.id}]`, ...a);
  const providerFor = (uri) => {
    const reg = uri && uri.scheme !== 'file' ? host.fsProviders.get(uri.scheme) : undefined;
    return reg ? reg.provider : undefined;
  };

  // ------------------------------------------------------------- commands
  const commands = {
    registerCommand(id, cb, thisArg) {
      return host.registerCommand(id, cb, thisArg);
    },
    registerTextEditorCommand(id, cb, thisArg) {
      return host.registerCommand(id, (...args) => {
        const editor = host.activeTextEditor;
        if (!editor) {
          log(`comando de editor sem editor ativo: ${id}`);
          return undefined;
        }
        // As operações do builder são aplicadas como UMA edição ao final.
        const ops = [];
        const builder = {
          replace: (loc, text) => ops.push((b) => b.replace(loc, text)),
          insert: (pos, text) => ops.push((b) => b.insert(pos, text)),
          delete: (range) => ops.push((b) => b.delete(range)),
          setEndOfLine: (eol) => ops.push((b) => b.setEndOfLine(eol)),
        };
        const result = cb.call(thisArg, editor, builder, ...args);
        if (ops.length) return editor.edit((b) => ops.forEach((op) => op(b))).then(() => result);
        return result;
      });
    },
    executeCommand(id, ...args) {
      return host.executeCommand(id, ...args);
    },
    getCommands(_filterInternal) {
      return Promise.resolve([...host.commands.keys()]);
    },
  };

  // --------------------------------------------------------------- window
  const outputChannels = [];
  function createOutputChannel(name, opts) {
    const logFile = path.join(host.dataDir, 'logs', `${name.replace(/[^\w.-]+/g, '_')}.log`);
    let stream = null;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch {
      /* ignora */
    }
    const write = (s) => {
      stream && stream.write(s);
      host.outputAppend(name, s);
      if (host.verbose) process.stderr.write(`[out:${name}] ${s}`);
    };
    const isLog = opts && typeof opts === 'object' && opts.log;
    const lvl = (l) => (msg, ...rest) => write(`${new Date().toISOString()} [${l}] ${msg}${rest.length ? ' ' + rest.map((r) => (r instanceof Error ? r.stack : typeof r === 'string' ? r : JSON.stringify(r))).join(' ') : ''}\n`);
    const ch = {
      name,
      logLevel: types.LogLevel.Info,
      onDidChangeLogLevel: new EventEmitter().event,
      append: (v) => write(String(v)),
      appendLine: (v) => write(String(v) + '\n'),
      replace: (v) => write(String(v) + '\n'),
      clear() {},
      show(preserveFocus) {
        host.emit({ event: 'outputShow', channel: name, preserveFocus: !!preserveFocus });
      },
      hide() {},
      dispose() {
        stream && stream.end();
        stream = null;
      },
      trace: lvl('trace'),
      debug: lvl('debug'),
      info: lvl('info'),
      warn: lvl('warning'),
      error: lvl('error'),
    };
    if (!isLog) ch.logLevel = undefined;
    outputChannels.push(ch);
    return ch;
  }

  function showMessage(severity) {
    return (message, ...rest) => {
      let options = {};
      if (rest.length && rest[0] && typeof rest[0] === 'object' && !('title' in rest[0])) options = rest.shift();
      const items = rest.flat().filter((x) => x !== undefined);
      const labels = items.map((i) => (typeof i === 'string' ? i : i.title));
      log(`show${severity}Message:`, message, labels.length ? labels : '');
      return host
        .request('showMessage', { severity: severity.toLowerCase(), message: String(message), items: labels, modal: !!options.modal, detail: options.detail, extensionId: ext.id })
        .then((r) => (r && typeof r.index === 'number' && r.index >= 0 ? items[r.index] : undefined));
    };
  }

  const window = {
    get activeTextEditor() {
      return host.activeTextEditor;
    },
    get visibleTextEditors() {
      return host.visibleTextEditors;
    },
    onDidChangeActiveTextEditor: host.events.activeTextEditor.event,
    onDidChangeVisibleTextEditors: host.events.visibleTextEditors.event,
    onDidChangeTextEditorSelection: host.events.textEditorSelection.event,
    onDidChangeTextEditorVisibleRanges: host.events.textEditorVisibleRanges.event,
    onDidChangeTextEditorOptions: host.events.never.event,
    onDidChangeTextEditorViewColumn: host.events.never.event,
    get tabGroups() {
      return host.tabGroups;
    },
    get state() {
      return host.windowState;
    },
    onDidChangeWindowState: host.events.windowState.event,
    get activeColorTheme() {
      return { kind: host.themeKind === 'light' ? types.ColorThemeKind.Light : host.themeKind === 'high-contrast' ? types.ColorThemeKind.HighContrast : types.ColorThemeKind.Dark };
    },
    onDidChangeActiveColorTheme: host.events.never.event,
    get terminals() {
      return host.terminals;
    },
    get activeTerminal() {
      return host.activeTerminal;
    },
    onDidOpenTerminal: host.events.openTerminal.event,
    onDidCloseTerminal: host.events.closeTerminal.event,
    onDidChangeActiveTerminal: host.events.activeTerminal.event,
    onDidChangeTerminalState: host.events.terminalState.event,
    onDidChangeTerminalShellIntegration: host.events.terminalShellIntegration.event,
    onDidStartTerminalShellExecution: host.events.startShellExecution.event,
    onDidEndTerminalShellExecution: host.events.endShellExecution.event,
    activeNotebookEditor: undefined,
    visibleNotebookEditors: [],
    onDidChangeActiveNotebookEditor: host.events.never.event,
    onDidChangeVisibleNotebookEditors: host.events.never.event,
    onDidChangeNotebookEditorSelection: host.events.never.event,
    onDidChangeNotebookEditorVisibleRanges: host.events.never.event,
    showNotebookDocument: (doc, options) => host.notebooks.show(doc, options),

    registerWebviewViewProvider(viewId, provider, options) {
      return host.registerWebviewViewProvider(ext, viewId, provider, options);
    },
    createWebviewPanel(viewType, title, showOptions, options) {
      return host.createWebviewPanel(ext, new WebviewPanel(host.webviewBridge, viewType, title, showOptions, options, ext));
    },
    registerWebviewPanelSerializer(viewType, serializer) {
      const reg = { serializer, ext };
      host.serializers.set(viewType, reg);
      return new Disposable(() => {
        if (host.serializers.get(viewType) === reg) host.serializers.delete(viewType);
      });
    },
    registerCustomEditorProvider(viewType, provider, options) {
      host.customEditors.set(viewType, { provider, options, ext });
      return new Disposable(() => host.customEditors.delete(viewType));
    },
    registerUriHandler(handler) {
      host.uriHandlers.set(ext.id, handler);
      return new Disposable(() => host.uriHandlers.delete(ext.id));
    },
    registerTreeDataProvider() {
      return noopDisposable();
    },
    createTreeView(id) {
      return { id, visible: false, onDidChangeVisibility: host.events.never.event, onDidChangeSelection: host.events.never.event, onDidExpandElement: host.events.never.event, onDidCollapseElement: host.events.never.event, reveal: () => Promise.resolve(), dispose() {} };
    },
    registerTerminalLinkProvider: () => noopDisposable(),
    registerTerminalProfileProvider: () => noopDisposable(),
    registerFileDecorationProvider: () => noopDisposable(),

    showInformationMessage: showMessage('Information'),
    showWarningMessage: showMessage('Warning'),
    showErrorMessage: showMessage('Error'),
    showQuickPick(items, options, token) {
      return host.quickInputs.showQuickPick(ext, items, options || {}, token);
    },
    showInputBox(options, token) {
      return host.quickInputs.showInputBox(ext, options || {}, token);
    },
    showOpenDialog(options = {}) {
      return host.request('openDialog', { canSelectFiles: options.canSelectFiles !== false, canSelectFolders: !!options.canSelectFolders, canSelectMany: !!options.canSelectMany, title: options.title }).then((r) => (r && Array.isArray(r.paths) && r.paths.length ? r.paths.map((p) => Uri.file(p)) : undefined));
    },
    showSaveDialog(options = {}) {
      return host.request('saveDialog', { title: options.title, defaultPath: options.defaultUri && options.defaultUri.fsPath }).then((r) => (r && r.path ? Uri.file(r.path) : undefined));
    },
    showWorkspaceFolderPick() {
      return Promise.resolve(host.workspaceFolders[0]);
    },
    showTextDocument(docOrUri, columnOrOptions, preserveFocus) {
      return host.showTextDocument(docOrUri, columnOrOptions, preserveFocus);
    },
    createOutputChannel,
    createStatusBarItem(idOrAlignment, alignmentOrPriority, priorityArg) {
      const hasId = typeof idOrAlignment === 'string';
      const id = hasId ? idOrAlignment : `${ext.id}.status${++statusSeq}`;
      const alignment = (hasId ? alignmentOrPriority : idOrAlignment) || types.StatusBarAlignment.Left;
      const priority = hasId ? priorityArg : alignmentOrPriority;
      return createStatusBarItem(host, ext, `${ext.id}:${id}`, alignment, priority);
    },
    setStatusBarMessage(text, hideAfterOrThenable) {
      const id = `${ext.id}:msg${++statusSeq}`;
      host.emit({ event: 'statusMessage', id, extensionId: ext.id, text: String(text) });
      const clear = () => host.emit({ event: 'statusMessage', id, extensionId: ext.id, text: null });
      if (typeof hideAfterOrThenable === 'number') setTimeout(clear, hideAfterOrThenable);
      else if (hideAfterOrThenable && typeof hideAfterOrThenable.then === 'function') hideAfterOrThenable.then(clear, clear);
      return new Disposable(clear);
    },
    withProgress(options, task) {
      return host.progress.withProgress(ext, options, task);
    },
    withScmProgress(task) {
      return host.progress.withProgress(ext, { location: types.ProgressLocation.SourceControl }, (p) => task(p));
    },
    createTextEditorDecorationType(opts) {
      return host.createDecorationType(ext, opts);
    },
    createTerminal(nameOrOptions, shellPath, shellArgs) {
      const opts = typeof nameOrOptions === 'object' && nameOrOptions ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs };
      return host.createTerminal(ext, opts);
    },
    createInputBox() {
      return host.quickInputs.createInputBox(ext);
    },
    createQuickPick() {
      return host.quickInputs.createQuickPick(ext);
    },
  };

  // ------------------------------------------------------------ workspace
  const fsApi = {
    async stat(uri) {
      uri = toUri(uri);
      const prov = providerFor(uri);
      if (prov) return prov.stat(uri);
      try {
        const lst = await fs.promises.lstat(uri.fsPath);
        const st = lst.isSymbolicLink() ? await fs.promises.stat(uri.fsPath) : lst;
        let type = st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : FileType.Unknown;
        if (lst.isSymbolicLink()) type |= FileType.SymbolicLink;
        let permissions;
        try {
          await fs.promises.access(uri.fsPath, fs.constants.W_OK);
        } catch {
          permissions = types.FilePermission.Readonly;
        }
        return { type, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size, permissions };
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async readFile(uri) {
      uri = toUri(uri);
      const prov = providerFor(uri);
      if (prov) return prov.readFile(uri);
      try {
        return new Uint8Array(await fs.promises.readFile(uri.fsPath));
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async writeFile(uri, content) {
      uri = toUri(uri);
      const prov = providerFor(uri);
      if (prov) return prov.writeFile(uri, content, { create: true, overwrite: true, unlock: false, atomic: false });
      try {
        await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.promises.writeFile(uri.fsPath, content);
        host.notifyFileChanged(uri.fsPath);
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async readDirectory(uri) {
      uri = toUri(uri);
      const prov = providerFor(uri);
      if (prov) return prov.readDirectory(uri);
      try {
        const ents = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return ents.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isSymbolicLink() ? FileType.SymbolicLink : e.isFile() ? FileType.File : FileType.Unknown]);
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async createDirectory(uri) {
      uri = toUri(uri);
      const prov = providerFor(uri);
      if (prov) return prov.createDirectory(uri);
      try {
        await fs.promises.mkdir(uri.fsPath, { recursive: true });
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async delete(uri, options = {}) {
      uri = toUri(uri);
      const prov = providerFor(uri);
      if (prov) return prov.delete(uri, { recursive: !!options.recursive, useTrash: !!options.useTrash, atomic: false });
      try {
        await fs.promises.rm(uri.fsPath, { recursive: !!options.recursive, force: false });
        host.notifyFileChanged(uri.fsPath);
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async rename(src, dst, options = {}) {
      src = toUri(src);
      dst = toUri(dst);
      const prov = providerFor(src);
      if (prov) return prov.rename(src, dst, { overwrite: !!options.overwrite });
      try {
        if (!options.overwrite && fs.existsSync(dst.fsPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        await fs.promises.mkdir(path.dirname(dst.fsPath), { recursive: true });
        await fs.promises.rename(src.fsPath, dst.fsPath);
        host.notifyFileChanged(dst.fsPath);
      } catch (e) {
        throw fsErr(e, e && e.code === 'EEXIST' ? dst : src);
      }
    },
    async copy(src, dst, options = {}) {
      src = toUri(src);
      dst = toUri(dst);
      const prov = providerFor(src);
      if (prov && typeof prov.copy === 'function') return prov.copy(src, dst, { overwrite: !!options.overwrite });
      try {
        if (!options.overwrite && fs.existsSync(dst.fsPath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        await fs.promises.cp(src.fsPath, dst.fsPath, { recursive: true, force: !!options.overwrite });
        host.notifyFileChanged(dst.fsPath);
      } catch (e) {
        throw fsErr(e, e && e.code === 'EEXIST' ? dst : src);
      }
    },
    isWritableFileSystem(scheme) {
      if (scheme === 'file') return true;
      const reg = host.fsProviders.get(scheme);
      return reg ? !reg.options.isReadonly : undefined;
    },
  };

  const workspace = {
    get workspaceFolders() {
      return host.workspaceFolders.length ? host.workspaceFolders : undefined;
    },
    get name() {
      return host.workspaceFolders[0] ? host.workspaceFolders[0].name : undefined;
    },
    get rootPath() {
      return host.workspaceFolders[0] ? host.workspaceFolders[0].uri.fsPath : undefined;
    },
    workspaceFile: undefined,
    isTrusted: true,
    onDidGrantWorkspaceTrust: host.events.never.event,
    get textDocuments() {
      return [...host.documents.values()];
    },
    fs: fsApi,
    getConfiguration(section, scope) {
      return host.config.getConfiguration(section, scope);
    },
    onDidChangeConfiguration: host.config.onDidChangeConfiguration,
    getWorkspaceFolder(uri) {
      uri = toUri(uri);
      return host.workspaceFolders.find((f) => uri && uri.scheme === 'file' && (uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep)));
    },
    asRelativePath(pathOrUri, includeWorkspaceFolder) {
      const p = typeof pathOrUri === 'string' ? pathOrUri : toUri(pathOrUri).fsPath;
      const folder = host.workspaceFolders.find((f) => p === f.uri.fsPath || p.startsWith(f.uri.fsPath + path.sep));
      if (!folder) return p;
      const rel = path.relative(folder.uri.fsPath, p).split(path.sep).join('/');
      return includeWorkspaceFolder && host.workspaceFolders.length > 1 ? `${folder.name}/${rel}` : rel;
    },
    updateWorkspaceFolders() {
      return false;
    },
    onDidChangeWorkspaceFolders: host.events.workspaceFolders.event,
    openTextDocument(arg) {
      return host.openTextDocument(arg);
    },
    onDidOpenTextDocument: host.events.openDocument.event,
    onDidCloseTextDocument: host.events.closeDocument.event,
    onDidChangeTextDocument: host.events.changeDocument.event,
    onDidSaveTextDocument: host.events.saveDocument.event,
    onWillSaveTextDocument: host.events.willSaveDocument.event,
    onDidCreateFiles: host.events.createFiles.event,
    onDidDeleteFiles: host.events.deleteFiles.event,
    onDidRenameFiles: host.events.renameFiles.event,
    onWillCreateFiles: host.events.never.event,
    onWillDeleteFiles: host.events.never.event,
    onWillRenameFiles: host.events.never.event,
    onDidOpenNotebookDocument: host.notebooks.onDidOpen.event,
    onDidCloseNotebookDocument: host.notebooks.onDidClose.event,
    onDidChangeNotebookDocument: host.events.never.event,
    onDidSaveNotebookDocument: host.events.never.event,
    get notebookDocuments() {
      return host.notebooks.documents.slice();
    },
    async findFiles(include, exclude, maxResults = 10000) {
      const incPattern = typeof include === 'string' ? include : include && include.pattern;
      const exPattern = typeof exclude === 'string' ? exclude : exclude && exclude.pattern;
      const roots = include && typeof include === 'object' && include.baseUri ? [include.baseUri.fsPath] : host.workspaceFolders.map((f) => f.uri.fsPath);
      const out = [];
      for (const root of roots) {
        const found = await walkFind(root, globToRegExp(incPattern), exPattern ? globToRegExp(exPattern) : null, maxResults - out.length);
        out.push(...found.map((p) => Uri.file(p)));
        if (out.length >= maxResults) break;
      }
      return out;
    },
    createFileSystemWatcher(globPattern, ignoreCreate, ignoreChange, ignoreDelete) {
      return createWatcher(host, globPattern, !!ignoreCreate, !!ignoreChange, !!ignoreDelete);
    },
    registerFileSystemProvider(scheme, provider, options = {}) {
      const reg = { provider, ext, options: { isCaseSensitive: !!options.isCaseSensitive, isReadonly: !!options.isReadonly } };
      host.fsProviders.set(scheme, reg);
      return new Disposable(() => {
        if (host.fsProviders.get(scheme) === reg) host.fsProviders.delete(scheme);
      });
    },
    registerTextDocumentContentProvider(scheme, provider) {
      const reg = { provider, ext };
      host.contentProviders.set(scheme, reg);
      // provider.onDidChange(uri) → relê o documento aberto e avisa as extensões.
      const sub =
        provider && typeof provider.onDidChange === 'function'
          ? provider.onDidChange(async (uri) => {
              const doc = host.documents.get(toUri(uri).toString());
              if (!doc) return;
              try {
                const text = await provider.provideTextDocumentContent(toUri(uri), new CancellationTokenSource().token);
                host._replaceText(doc, text);
              } catch (err) {
                log('provideTextDocumentContent falhou:', err);
              }
            })
          : null;
      return new Disposable(() => {
        if (host.contentProviders.get(scheme) === reg) host.contentProviders.delete(scheme);
        sub && sub.dispose();
      });
    },
    applyEdit(edit) {
      return host.applyWorkspaceEdit(edit);
    },
    saveAll() {
      return host.saveAll();
    },
    save(uri) {
      const doc = host.documents.get(toUri(uri).toString());
      return doc ? doc.save().then((ok) => (ok ? doc.uri : undefined)) : Promise.resolve(undefined);
    },
    registerTaskProvider: (type, provider) => host.tasks.registerTaskProvider(ext, type, provider),
    registerNotebookSerializer: () => noopDisposable(),
    openNotebookDocument: (uriOrType, content) => host.notebooks.open(uriOrType, content),
  };

  // ------------------------------------------------------------------ env
  const env = {
    appName: 'Fluent Coder',
    appRoot: host.appRoot,
    appHost: 'desktop',
    uriScheme: 'fluent-coder',
    language: host.language,
    machineId: host.machineId,
    sessionId: host.sessionId,
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: host.events.never.event,
    remoteName: undefined,
    uiKind: types.UIKind.Desktop,
    get shell() {
      return process.env.SHELL || (process.platform === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : '/bin/bash');
    },
    onDidChangeShell: host.events.never.event,
    logLevel: types.LogLevel.Info,
    onDidChangeLogLevel: host.events.never.event,
    clipboard: {
      // Área de transferência do SO via app (o sidecar não tem acesso); sem app
      // ou sem resposta em 2 s, o último texto escrito por uma extensão.
      readText: () => host.request('clipboardRead', {}, 2000).then((r) => (r && typeof r.text === 'string' ? r.text : host.clipboard)),
      writeText: (t) => {
        host.clipboard = String(t);
        host.emit({ event: 'clipboardWrite', text: host.clipboard });
        return Promise.resolve();
      },
    },
    openExternal(uri) {
      const s = typeof uri === 'string' ? uri : uri.toString(true);
      if (s.startsWith('fluent-coder:') || s.startsWith('vscode:')) return host.handleUri(Uri.parse(s));
      if (!/^(https?:|mailto:)/i.test(s)) {
        log(`openExternal recusado (esquema não permitido): ${s.slice(0, 80)}`);
        return Promise.resolve(false);
      }
      host.emit({ event: 'openExternal', url: s });
      return Promise.resolve(true);
    },
    asExternalUri(uri) {
      return Promise.resolve(uri);
    },
    createTelemetryLogger() {
      return { logUsage() {}, logError() {}, dispose() {}, isUsageEnabled: false, isErrorsEnabled: false, onDidChangeEnableStates: host.events.never.event };
    },
  };

  // ---------------------------------------------------------- extensions
  const extensions = {
    getExtension(id) {
      return host.getExtensionObject(id);
    },
    get all() {
      return host.allExtensionObjects();
    },
    onDidChange: host.events.never.event,
  };

  // ------------------------------------------------------------ languages
  const languages = {
    getDiagnostics(uri) {
      return host.getDiagnostics(uri);
    },
    onDidChangeDiagnostics: host.events.diagnostics.event,
    // Registro REAL de linguagens do Monaco (o app manda em `setLanguages`).
    getLanguages: () => Promise.resolve([...host.languageIds]),
    createDiagnosticCollection(name) {
      return createDiagnosticCollection(host, name || ext.id);
    },
    // Algoritmo do VS Code (10 exato, 5 curinga, 0 não casa) — o
    // vscode-languageclient decide a sincronização de documentos com ele.
    match: (selector, document) => require('../host').scoreSelector(selector, document),
    setTextDocumentLanguage: (doc) => Promise.resolve(doc),
  };
  languages.registerCodeLensProvider = (selector, provider) => host.registerCodeLensProvider(ext, selector, provider);
  for (const k of ['registerHoverProvider', 'registerCompletionItemProvider', 'registerCodeActionsProvider', 'registerDefinitionProvider', 'registerDocumentLinkProvider', 'registerInlineCompletionItemProvider', 'registerDocumentSymbolProvider']) {
    languages[k] = () => noopDisposable();
  }

  // --------------------------------------------------------- misc / stubs
  const comments = {
    createCommentController(id, label) {
      return host.comments.createController(ext, String(id), String(label || id));
    },
  };

  const authentication = {
    getSession: () => Promise.resolve(undefined),
    getAccounts: () => Promise.resolve([]),
    onDidChangeSessions: host.events.never.event,
    registerAuthenticationProvider: () => noopDisposable(),
  };

  const l10n = {
    t(message, ...args) {
      const msg = typeof message === 'object' && message ? message.message : String(message);
      const params = args.length === 1 && args[0] && typeof args[0] === 'object' ? args[0] : args;
      return msg.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
    },
    bundle: undefined,
    uri: undefined,
  };

  // Tarefas: providers + executeTask no terminal integrado (shim/tasks.js).
  const tasks = {
    executeTask: (task) => host.tasks.executeTask(ext, task),
    fetchTasks: (filter) => host.tasks.fetchTasks(filter),
    get taskExecutions() {
      return [...host.tasks.executions];
    },
    onDidStartTask: host.tasks.onDidStartTask.event,
    onDidEndTask: host.tasks.onDidEndTask.event,
    onDidStartTaskProcess: host.tasks.onDidStartTaskProcess.event,
    onDidEndTaskProcess: host.tasks.onDidEndTaskProcess.event,
    registerTaskProvider: (type, provider) => host.tasks.registerTaskProvider(ext, type, provider),
  };

  const debug = {
    activeDebugSession: undefined,
    breakpoints: [],
    onDidStartDebugSession: host.events.never.event,
    onDidTerminateDebugSession: host.events.never.event,
    onDidChangeActiveDebugSession: host.events.never.event,
    onDidChangeBreakpoints: host.events.never.event,
    registerDebugConfigurationProvider: () => noopDisposable(),
    registerDebugAdapterDescriptorFactory: () => noopDisposable(),
    startDebugging: () => Promise.resolve(false),
  };

  // Sem editor de notebook no Fluent Coder: abrir devolve um NotebookDocument
  // real (só leitura) e mostrar avisa em pt-BR (ver shim/notebooks.js).
  const notebooks = {
    createNotebookController(id, notebookType, label) {
      return host.notebooks.createController(id, notebookType, label);
    },
    registerNotebookCellStatusBarItemProvider: () => noopDisposable(),
    createRendererMessaging: () => ({ onDidReceiveMessage: host.events.never.event, postMessage: () => Promise.resolve(false) }),
  };

  const scm = { createSourceControl: () => ({ createResourceGroup: () => ({ resourceStates: [], dispose() {} }), inputBox: { value: '' }, dispose() {} }) };

  const api = {
    version: VSCODE_VERSION,
    commands,
    window,
    workspace,
    env,
    extensions,
    languages,
    comments,
    authentication,
    l10n,
    tasks,
    debug,
    notebooks,
    scm,
    // Propostas (chat, lm) deliberadamente AUSENTES: a extensão deve tratá-las
    // como indisponíveis (enabledApiProposals não é honrado por este host).
    ...types,
  };
  return api;
}

module.exports = { createVscodeApi, VSCODE_VERSION, globToRegExp, toUri, os };
