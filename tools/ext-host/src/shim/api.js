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

/** Versão do VS Code anunciada às extensões (satisfaz ^1.94 e ^1.96.2). */
const VSCODE_VERSION = '1.106.0';

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

/**
 * @param {import('../host').ExtensionHost} host
 * @param {object} ext descritor da extensão carregada ({ id, packageJSON, extensionPath, ... })
 */
function createVscodeApi(host, ext) {
  const log = (...a) => host.log(`[${ext.id}]`, ...a);

  // ------------------------------------------------------------- commands
  const commands = {
    registerCommand(id, cb, thisArg) {
      return host.registerCommand(id, cb, thisArg);
    },
    registerTextEditorCommand(id, cb, thisArg) {
      return host.registerCommand(id, (...args) => cb.call(thisArg, host.activeTextEditor, { replace() {}, insert() {}, delete() {} }, ...args));
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
      show() {},
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
    onDidChangeTextEditorVisibleRanges: host.events.never.event,
    onDidChangeTextEditorOptions: host.events.never.event,
    onDidChangeTextEditorViewColumn: host.events.never.event,
    get tabGroups() {
      return host.tabGroups;
    },
    get state() {
      return host.windowState;
    },
    onDidChangeWindowState: host.events.windowState.event,
    activeColorTheme: { kind: types.ColorThemeKind.Dark },
    onDidChangeActiveColorTheme: host.events.never.event,
    get terminals() {
      return host.terminals;
    },
    get activeTerminal() {
      return host.terminals[host.terminals.length - 1];
    },
    onDidOpenTerminal: host.events.openTerminal.event,
    onDidCloseTerminal: host.events.closeTerminal.event,
    onDidChangeActiveTerminal: host.events.never.event,
    onDidChangeTerminalState: host.events.never.event,
    onDidChangeTerminalShellIntegration: host.events.never.event,
    onDidStartTerminalShellExecution: host.events.never.event,
    onDidEndTerminalShellExecution: host.events.never.event,
    activeNotebookEditor: undefined,
    visibleNotebookEditors: [],
    onDidChangeActiveNotebookEditor: host.events.never.event,
    onDidChangeVisibleNotebookEditors: host.events.never.event,
    onDidChangeNotebookEditorSelection: host.events.never.event,

    registerWebviewViewProvider(viewId, provider, options) {
      return host.registerWebviewViewProvider(ext, viewId, provider, options);
    },
    createWebviewPanel(viewType, title, showOptions, options) {
      return host.createWebviewPanel(ext, new WebviewPanel(host.webviewBridge, viewType, title, showOptions, options, ext));
    },
    registerWebviewPanelSerializer(viewType, serializer) {
      host.serializers.set(viewType, serializer);
      return new Disposable(() => host.serializers.delete(viewType));
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
    showQuickPick(items, options) {
      return Promise.resolve(items).then((list) => {
        const arr = list || [];
        const labels = arr.map((i) => (typeof i === 'string' ? { label: i } : { label: i.label, description: i.description, detail: i.detail, kind: i.kind }));
        return host.request('quickPick', { items: labels, placeHolder: options && options.placeHolder, title: options && options.title, canPickMany: !!(options && options.canPickMany), extensionId: ext.id }).then((r) => {
          if (!r) return undefined;
          if (Array.isArray(r.indexes)) return r.indexes.map((i) => arr[i]);
          return typeof r.index === 'number' && r.index >= 0 ? arr[r.index] : undefined;
        });
      });
    },
    showInputBox(options = {}) {
      return host
        .request('inputBox', { prompt: options.prompt, placeHolder: options.placeHolder, value: options.value, password: !!options.password, title: options.title, extensionId: ext.id })
        .then((r) => (r && typeof r.value === 'string' ? r.value : undefined));
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
    createStatusBarItem(idOrAlignment, alignment, priority) {
      return { id: typeof idOrAlignment === 'string' ? idOrAlignment : `${ext.id}.status`, alignment, priority, text: '', tooltip: undefined, command: undefined, name: undefined, backgroundColor: undefined, color: undefined, accessibilityInformation: undefined, show() {}, hide() {}, dispose() {} };
    },
    setStatusBarMessage(text) {
      log('statusBar:', text);
      return noopDisposable();
    },
    withProgress(options, task) {
      const cts = new CancellationTokenSource();
      return Promise.resolve(task({ report() {} }, cts.token));
    },
    withScmProgress(task) {
      return Promise.resolve(task({ report() {} }));
    },
    createTextEditorDecorationType(opts) {
      return { key: `deco${Math.random().toString(36).slice(2)}`, options: opts, dispose() {} };
    },
    createTerminal(nameOrOptions, shellPath, shellArgs) {
      return host.createTerminal(ext, typeof nameOrOptions === 'object' ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs });
    },
    createInputBox() {
      const em = new EventEmitter();
      return { value: '', placeholder: '', prompt: '', show() {}, hide() {}, dispose() {}, onDidAccept: em.event, onDidHide: em.event, onDidChangeValue: em.event, onDidTriggerButton: em.event, buttons: [] };
    },
    createQuickPick() {
      const em = new EventEmitter();
      return { items: [], selectedItems: [], activeItems: [], value: '', show() {}, hide() {}, dispose() {}, onDidAccept: em.event, onDidHide: em.event, onDidChangeValue: em.event, onDidChangeSelection: em.event, onDidChangeActive: em.event, onDidTriggerButton: em.event, onDidTriggerItemButton: em.event, buttons: [] };
    },
  };

  // ------------------------------------------------------------ workspace
  const fsApi = {
    async stat(uri) {
      uri = toUri(uri);
      const prov = host.fsProviders.get(uri.scheme);
      if (prov) return prov.stat(uri);
      try {
        const st = await fs.promises.stat(uri.fsPath);
        return { type: st.isDirectory() ? FileType.Directory : FileType.File, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async readFile(uri) {
      uri = toUri(uri);
      const prov = host.fsProviders.get(uri.scheme);
      if (prov) return prov.readFile(uri);
      try {
        return new Uint8Array(await fs.promises.readFile(uri.fsPath));
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async writeFile(uri, content) {
      uri = toUri(uri);
      const prov = host.fsProviders.get(uri.scheme);
      if (prov) return prov.writeFile(uri, content, { create: true, overwrite: true });
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
      const prov = host.fsProviders.get(uri.scheme);
      if (prov) return prov.readDirectory(uri);
      try {
        const ents = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
        return ents.map((e) => [e.name, e.isDirectory() ? FileType.Directory : e.isSymbolicLink() ? FileType.SymbolicLink : FileType.File]);
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async createDirectory(uri) {
      uri = toUri(uri);
      await fs.promises.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri, options = {}) {
      uri = toUri(uri);
      try {
        await fs.promises.rm(uri.fsPath, { recursive: !!options.recursive, force: false });
      } catch (e) {
        throw fsErr(e, uri);
      }
    },
    async rename(src, dst) {
      await fs.promises.rename(toUri(src).fsPath, toUri(dst).fsPath);
    },
    async copy(src, dst) {
      await fs.promises.cp(toUri(src).fsPath, toUri(dst).fsPath, { recursive: true });
    },
    isWritableFileSystem(scheme) {
      return scheme === 'file' ? true : host.fsProviders.has(scheme) ? true : undefined;
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
    getConfiguration(section, _scope) {
      return host.config.getConfiguration(section);
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
    onWillSaveTextDocument: host.events.never.event,
    onDidCreateFiles: host.events.never.event,
    onDidDeleteFiles: host.events.never.event,
    onDidRenameFiles: host.events.never.event,
    onWillCreateFiles: host.events.never.event,
    onWillDeleteFiles: host.events.never.event,
    onWillRenameFiles: host.events.never.event,
    onDidOpenNotebookDocument: host.events.never.event,
    onDidCloseNotebookDocument: host.events.never.event,
    onDidChangeNotebookDocument: host.events.never.event,
    notebookDocuments: [],
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
    createFileSystemWatcher() {
      const c = new EventEmitter();
      const ch = new EventEmitter();
      const d = new EventEmitter();
      return { ignoreCreateEvents: false, ignoreChangeEvents: false, ignoreDeleteEvents: false, onDidCreate: c.event, onDidChange: ch.event, onDidDelete: d.event, dispose() {} };
    },
    registerFileSystemProvider(scheme, provider) {
      host.fsProviders.set(scheme, provider);
      return new Disposable(() => host.fsProviders.delete(scheme));
    },
    registerTextDocumentContentProvider(scheme, provider) {
      host.contentProviders.set(scheme, provider);
      return new Disposable(() => host.contentProviders.delete(scheme));
    },
    applyEdit(edit) {
      return host.applyWorkspaceEdit(edit);
    },
    saveAll() {
      return Promise.resolve(true);
    },
    registerTaskProvider: () => noopDisposable(),
    registerNotebookSerializer: () => noopDisposable(),
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
      readText: () => Promise.resolve(host.clipboard),
      writeText: (t) => {
        host.clipboard = String(t);
        host.emit({ event: 'clipboardWrite', text: host.clipboard });
        return Promise.resolve();
      },
    },
    openExternal(uri) {
      const s = typeof uri === 'string' ? uri : uri.toString(true);
      if (s.startsWith('fluent-coder:') || s.startsWith('vscode:')) return Promise.resolve(host.handleUri(Uri.parse(s)));
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
      if (uri) return host.diagnostics.get(toUri(uri).toString()) || [];
      return [...host.diagnostics.entries()].map(([k, v]) => [Uri.parse(k), v]);
    },
    onDidChangeDiagnostics: host.events.diagnostics.event,
    getLanguages: () => Promise.resolve(['plaintext', 'typescript', 'javascript', 'csharp', 'razor', 'json', 'markdown']),
    createDiagnosticCollection(name) {
      const map = new Map();
      return { name, set(uri, d) { if (uri) map.set(String(uri), d || []); }, delete(uri) { map.delete(String(uri)); }, clear() { map.clear(); }, forEach(cb) { map.forEach((v, k) => cb(Uri.parse(k), v)); }, get: (uri) => map.get(String(uri)), has: (uri) => map.has(String(uri)), dispose() { map.clear(); } };
    },
    match: () => 0,
    setTextDocumentLanguage: (doc) => Promise.resolve(doc),
  };
  for (const k of ['registerCodeLensProvider', 'registerHoverProvider', 'registerCompletionItemProvider', 'registerCodeActionsProvider', 'registerDefinitionProvider', 'registerDocumentLinkProvider', 'registerInlineCompletionItemProvider', 'registerDocumentSymbolProvider']) {
    languages[k] = () => noopDisposable();
  }

  // --------------------------------------------------------- misc / stubs
  const comments = {
    createCommentController(id, label) {
      return {
        id,
        label,
        options: undefined,
        commentingRangeProvider: undefined,
        reactionHandler: undefined,
        createCommentThread(uri, range, comments) {
          return { uri, range, comments, collapsibleState: 0, canReply: true, contextValue: undefined, label: undefined, state: 0, dispose() {} };
        },
        dispose() {},
      };
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

  const tasks = {
    executeTask: () => Promise.reject(new Error('Tarefas não são suportadas pelo host de extensões do Fluent Coder.')),
    fetchTasks: () => Promise.resolve([]),
    taskExecutions: [],
    onDidStartTask: host.events.never.event,
    onDidEndTask: host.events.never.event,
    onDidStartTaskProcess: host.events.never.event,
    onDidEndTaskProcess: host.events.never.event,
    registerTaskProvider: () => noopDisposable(),
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

  const notebooks = {
    createNotebookController: () => ({ dispose() {} }),
    registerNotebookCellStatusBarItemProvider: () => noopDisposable(),
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
