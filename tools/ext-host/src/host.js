// ExtensionHost: carrega extensões VS Code instaladas localmente, intercepta
// `require('vscode')` e mantém o estado compartilhado do shim (comandos,
// webviews, documentos, editor ativo). Independe de transporte: os eventos para
// o app saem por `emit(obj)`; o main.js liga isso ao stdio (JSON por linha).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Module = require('module');

const types = require('./shim/types');
const { ConfigurationStore } = require('./shim/configuration');
const { JsonMemento, FileSecretStorage } = require('./shim/memento');
const { WebviewView } = require('./shim/webview');
const { TextDocument, TextEditor } = require('./shim/documents');
const { createVscodeApi, toUri } = require('./shim/api');
const { ResourceServer } = require('./server');
const { buildPreamble, injectPreamble } = require('./preamble');

const { Disposable, EventEmitter, Uri, Position, Range, Selection } = types;

// ------------------------------------------------------- hook do require
let hookInstalled = false;
const apiResolvers = []; // (parentFilename) => api | undefined

function installRequireHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      const file = (parent && parent.filename) || '';
      for (const r of apiResolvers) {
        const api = r(file);
        if (api) return api;
      }
      throw new Error(`[ext-host] require('vscode') fora de uma extensão carregada: ${file}`);
    }
    return origLoad.apply(this, arguments);
  };
}

function sanitizeId(id) {
  return String(id).replace(/[^\w.-]+/g, '_');
}

class ExtensionHost {
  /**
   * @param {{dataDir:string, workspaceFolders?:string[], language?:string, appRoot?:string,
   *   emit?:(evt:object)=>void, verbose?:boolean, debugWebviews?:boolean, wrapApi?:(api:object, ext:object)=>object}} opts
   */
  constructor(opts) {
    this.dataDir = opts.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.emitFn = opts.emit || (() => {});
    this.verbose = !!opts.verbose;
    this.debugWebviews = !!opts.debugWebviews;
    this.wrapApi = opts.wrapApi;
    this.language = opts.language || 'pt-br';
    this.appRoot = opts.appRoot || path.resolve(__dirname, '..');
    this.sessionId = crypto.randomUUID();
    this.machineId = this._machineId();
    this.clipboard = '';
    this.config = new ConfigurationStore(path.join(this.dataDir, 'settings.json'));
    this.commands = new Map();
    this.contexts = new Map();
    this.extensions = new Map(); // id → ext
    this.viewProviders = new Map(); // viewId → { ext, provider, options }
    this.webviews = new Map(); // handle → { webview, view?, panel?, ext }
    this.serializers = new Map();
    this.customEditors = new Map();
    this.uriHandlers = new Map();
    this.fsProviders = new Map();
    this.contentProviders = new Map();
    this.documents = new Map(); // uri.toString() → TextDocument
    this.diagnostics = new Map();
    this.terminals = [];
    this.windowState = { focused: true, active: true };
    this.themeVars = {};
    this.themeKind = 'dark';
    this.pending = new Map();
    this.nextRequest = 1;
    this.appConnected = !!opts.appConnected;
    this._activeEditor = undefined;
    this._visibleEditors = [];
    this._openFiles = [];
    this._diffTabs = [];
    this.events = {
      never: new EventEmitter(),
      activeTextEditor: new EventEmitter(),
      visibleTextEditors: new EventEmitter(),
      textEditorSelection: new EventEmitter(),
      windowState: new EventEmitter(),
      openTerminal: new EventEmitter(),
      closeTerminal: new EventEmitter(),
      workspaceFolders: new EventEmitter(),
      openDocument: new EventEmitter(),
      closeDocument: new EventEmitter(),
      changeDocument: new EventEmitter(),
      saveDocument: new EventEmitter(),
      diagnostics: new EventEmitter(),
      tabs: new EventEmitter(),
      tabGroups: new EventEmitter(),
    };
    this.setWorkspaceFolders(opts.workspaceFolders || []);
    this.server = new ResourceServer({ getWebviewHtml: (h) => this.getWebviewHtml(h), log: (m) => this.log(m) });
    const server = this.server;
    this.webviewBridge = {
      resourceUrl: (uri) => this.resourceUrl(uri),
      get cspSource() {
        return server.origin;
      },
      onHtml: (wv) => this._onWebviewHtml(wv),
      post: (handle, message) => this._postToWebview(handle, message),
      allowRoots: (roots) => roots.forEach((r) => this.server.allowRoot(toUri(r).fsPath)),
      reveal: (handle, preserveFocus) => this.emit({ event: 'revealWebview', handle, preserveFocus }),
      retitle: (handle, title) => this.emit({ event: 'webviewTitle', handle, title }),
      disposeWebview: (handle) => this._disposeWebview(handle, false),
    };
    this._installBuiltinCommands();
    installRequireHook();
    apiResolvers.push((file) => {
      for (const ext of this.extensions.values()) {
        if (file === ext.mainPath || file.startsWith(ext.extensionPath + path.sep)) return ext.api;
      }
      return undefined;
    });
  }

  async start() {
    await this.server.listen();
    for (const f of this.workspaceFolders) this.server.allowRoot(f.uri.fsPath);
    return { port: this.server.port, origin: this.server.origin };
  }

  async stop() {
    for (const ext of this.extensions.values()) await this.deactivate(ext.id);
    await this.server.close();
  }

  log(...args) {
    const msg = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : safeJson(a))).join(' ');
    process.stderr.write(`[ext-host] ${msg}\n`);
    this.emitFn({ event: 'log', message: msg });
  }

  emit(evt) {
    this.emitFn(evt);
  }

  _machineId() {
    const file = path.join(this.dataDir, 'machine-id');
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      const id = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
      try {
        fs.writeFileSync(file, id);
      } catch {
        /* ignora */
      }
      return id;
    }
  }

  // ---------------------------------------------------------- workspace
  setWorkspaceFolders(paths) {
    const before = this.workspaceFolders || [];
    this.workspaceFolders = paths.map((p, index) => ({ uri: Uri.file(path.resolve(p)), name: path.basename(p), index }));
    if (this.server) for (const f of this.workspaceFolders) this.server.allowRoot(f.uri.fsPath);
    if (before.length || this.workspaceFolders.length) this.events.workspaceFolders.fire({ added: this.workspaceFolders, removed: before });
  }

  // --------------------------------------------------------- extensões
  /** Carrega (sem ativar) uma extensão a partir da pasta instalada. */
  loadExtension(extensionPath) {
    extensionPath = path.resolve(extensionPath);
    const packageJSON = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
    const id = `${packageJSON.publisher}.${packageJSON.name}`.toLowerCase();
    if (this.extensions.has(id)) return this.extensions.get(id);
    const mainPath = packageJSON.main ? require.resolve(path.resolve(extensionPath, packageJSON.main)) : null;
    const ext = {
      id,
      packageJSON,
      extensionPath,
      extensionUri: Uri.file(extensionPath),
      mainPath,
      isActive: false,
      exports: undefined,
      module: null,
      context: null,
      api: null,
    };
    this.config.addDefaults(packageJSON);
    this.server.allowRoot(extensionPath);
    const api = createVscodeApi(this, ext);
    ext.api = this.wrapApi ? this.wrapApi(api, ext) : api;
    this.extensions.set(id, ext);
    const views = [];
    const contributed = (packageJSON.contributes && packageJSON.contributes.views) || {};
    for (const [container, list] of Object.entries(contributed)) {
      for (const v of list || []) if (v.type === 'webview') views.push({ id: v.id, name: v.name, container, when: v.when });
    }
    ext.views = views;
    this.emit({ event: 'extensionLoaded', extension: this.describe(ext) });
    return ext;
  }

  describe(ext) {
    return {
      id: ext.id,
      name: ext.packageJSON.name,
      displayName: ext.packageJSON.displayName || ext.packageJSON.name,
      version: ext.packageJSON.version,
      publisher: ext.packageJSON.publisher,
      path: ext.extensionPath,
      isActive: ext.isActive,
      views: ext.views,
    };
  }

  createContext(ext) {
    const storeDir = path.join(this.dataDir, 'extensions', sanitizeId(ext.id));
    const wsKey = this.workspaceFolders[0] ? crypto.createHash('sha1').update(this.workspaceFolders[0].uri.fsPath).digest('hex').slice(0, 16) : 'empty';
    const globalStorage = path.join(storeDir, 'globalStorage');
    const wsStorage = path.join(storeDir, 'workspaceStorage', wsKey);
    const logDir = path.join(this.dataDir, 'logs', sanitizeId(ext.id));
    for (const d of [globalStorage, wsStorage, logDir]) fs.mkdirSync(d, { recursive: true });
    const globalState = new JsonMemento(path.join(storeDir, 'globalState.json'));
    const workspaceState = new JsonMemento(path.join(wsStorage, 'workspaceState.json'));
    const envVars = new Map();
    const envCollection = {
      persistent: true,
      description: undefined,
      replace: (k, v, o) => envVars.set(k, { value: v, type: 1, options: o }),
      append: (k, v, o) => envVars.set(k, { value: v, type: 2, options: o }),
      prepend: (k, v, o) => envVars.set(k, { value: v, type: 3, options: o }),
      get: (k) => envVars.get(k),
      forEach: (cb, thisArg) => envVars.forEach((m, k) => cb.call(thisArg, k, m, envCollection)),
      delete: (k) => envVars.delete(k),
      clear: () => envVars.clear(),
      [Symbol.iterator]: () => envVars.entries(),
      getScoped: () => envCollection,
    };
    return {
      subscriptions: [],
      workspaceState,
      globalState,
      secrets: new FileSecretStorage(path.join(storeDir, 'secrets.json')),
      extensionUri: ext.extensionUri,
      extensionPath: ext.extensionPath,
      environmentVariableCollection: envCollection,
      asAbsolutePath: (rel) => path.join(ext.extensionPath, rel),
      storageUri: Uri.file(wsStorage),
      storagePath: wsStorage,
      globalStorageUri: Uri.file(globalStorage),
      globalStoragePath: globalStorage,
      logUri: Uri.file(logDir),
      logPath: logDir,
      extensionMode: types.ExtensionMode.Production,
      extension: this.getExtensionObject(ext.id),
      extensionRuntime: 1, // Node
      languageModelAccessInformation: { onDidChange: this.events.never.event, canSendRequest: () => undefined },
    };
  }

  async activate(id) {
    const ext = this.extensions.get(id);
    if (!ext) throw new Error(`Extensão não carregada: ${id}`);
    if (ext.isActive) return ext.exports;
    if (!ext.mainPath) {
      ext.isActive = true;
      return undefined;
    }
    const t0 = Date.now();
    ext.module = require(ext.mainPath);
    ext.context = this.createContext(ext);
    if (typeof ext.module.activate === 'function') ext.exports = await ext.module.activate(ext.context);
    ext.isActive = true;
    this.log(`ativada ${id} em ${Date.now() - t0}ms`);
    this.emit({ event: 'extensionActivated', extension: this.describe(ext) });
    return ext.exports;
  }

  async deactivate(id) {
    const ext = this.extensions.get(id);
    if (!ext || !ext.isActive) return;
    try {
      if (ext.module && typeof ext.module.deactivate === 'function') await ext.module.deactivate();
    } catch (err) {
      this.log(`deactivate ${id} lançou:`, err);
    }
    for (const d of ext.context ? ext.context.subscriptions : []) {
      try {
        d && d.dispose && d.dispose();
      } catch {
        /* ignora */
      }
    }
    ext.isActive = false;
  }

  getExtensionObject(id) {
    const ext = this.extensions.get(String(id).toLowerCase());
    if (!ext) return undefined;
    return {
      id: `${ext.packageJSON.publisher}.${ext.packageJSON.name}`,
      extensionUri: ext.extensionUri,
      extensionPath: ext.extensionPath,
      get isActive() {
        return ext.isActive;
      },
      packageJSON: ext.packageJSON,
      extensionKind: types.ExtensionKind.Workspace,
      get exports() {
        return ext.exports;
      },
      activate: () => this.activate(ext.id),
    };
  }

  allExtensionObjects() {
    return [...this.extensions.keys()].map((id) => this.getExtensionObject(id));
  }

  // ----------------------------------------------------------- comandos
  registerCommand(id, cb, thisArg) {
    if (this.commands.has(id)) this.log(`comando já registrado (sobrescrevendo): ${id}`);
    this.commands.set(id, { cb, thisArg });
    return new Disposable(() => {
      if (this.commands.get(id) && this.commands.get(id).cb === cb) this.commands.delete(id);
    });
  }

  async executeCommand(id, ...args) {
    const c = this.commands.get(id);
    if (c) return c.cb.apply(c.thisArg, args);
    const b = this.builtins[id];
    if (b) return b(...args);
    const focus = /^(.+)\.focus$/.exec(id);
    if (focus && this.viewProviders.has(focus[1])) {
      this.emit({ event: 'revealView', viewId: focus[1] });
      return undefined;
    }
    if (/^workbench\.view\.extension\./.test(id)) {
      this.emit({ event: 'revealView', container: id.slice('workbench.view.extension.'.length) });
      return undefined;
    }
    this.log(`executeCommand sem implementação (ignorado): ${id}`);
    return undefined;
  }

  _installBuiltinCommands() {
    const noop = () => undefined;
    this.builtins = {
      setContext: (key, value) => {
        this.contexts.set(key, value);
        this.emit({ event: 'context', key, value });
      },
      'vscode.open': (uri, opts) => {
        uri = toUri(uri);
        if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
          this.emit({ event: 'openExternal', url: uri.toString(true) });
          return undefined;
        }
        return this.showTextDocument(uri, opts);
      },
      'vscode.openWith': (uri, viewType, opts) => this.openWith(toUri(uri), viewType, opts),
      'vscode.diff': (left, right, title, opts) => this.openDiff(toUri(left), toUri(right), title, opts),
      'vscode.changes': noop,
      'workbench.action.openSettings': (q) => this.emit({ event: 'openSettings', query: q }),
      'workbench.action.reloadWindow': () => this.emit({ event: 'reloadRequested' }),
      'workbench.action.closeActiveEditor': noop,
      'workbench.action.focusActiveEditorGroup': noop,
      'workbench.action.focusSideBar': noop,
      'workbench.action.focusAuxiliaryBar': noop,
      'workbench.action.lockEditorGroup': noop,
      'workbench.action.unlockEditorGroup': noop,
      'workbench.action.files.save': noop,
      'workbench.files.action.refreshFilesExplorer': () => this.emit({ event: 'filesChanged', paths: [] }),
      revealInExplorer: (uri) => this.emit({ event: 'revealInExplorer', path: toUri(uri).fsPath }),
      revealFileInOS: noop,
      'vscode.executeDocumentSymbolProvider': () => Promise.resolve([]),
      'vscode.executeWorkspaceSymbolProvider': () => Promise.resolve([]),
      'vscode.executeDefinitionProvider': () => Promise.resolve([]),
      'vscode.executeReferenceProvider': () => Promise.resolve([]),
      'vscode.executeHoverProvider': () => Promise.resolve([]),
      'editor.action.formatDocument': noop,
      'workbench.action.terminal.focus': noop,
      'workbench.action.chat.open': noop,
      'workbench.extensions.installExtension': () => Promise.reject(new Error('Instalação de extensões não suportada.')),
      'workbench.extensions.search': noop,
      'workbench.action.openWalkthrough': noop,
      'markdown.showPreview': (uri) => this.showTextDocument(toUri(uri)),
      'git.openChange': noop,
    };
  }

  // ------------------------------------------------------ pedidos ao app
  /** Pede algo ao app (diálogo, quick pick…). Sem app conectado → undefined. */
  request(kind, params) {
    if (!this.appConnected) {
      this.log(`request '${kind}' sem app conectado → undefined`, params && (params.message || params.title || ''));
      return Promise.resolve(undefined);
    }
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.emit({ event: 'request', requestId, kind, params });
    });
  }

  respond(requestId, result) {
    const r = this.pending.get(requestId);
    if (r) {
      this.pending.delete(requestId);
      r(result);
    }
  }

  // --------------------------------------------------------------- webviews
  resourceUrl(uri) {
    const u = toUri(uri);
    if (u.scheme === 'http' || u.scheme === 'https') return u.toString(true);
    return this.server.resourceUrl(u.fsPath);
  }

  registerWebviewViewProvider(ext, viewId, provider, options) {
    this.viewProviders.set(viewId, { ext, provider, options: options || {} });
    this.emit({ event: 'viewProviderRegistered', extensionId: ext.id, viewId });
    return new Disposable(() => {
      if (this.viewProviders.get(viewId) && this.viewProviders.get(viewId).provider === provider) this.viewProviders.delete(viewId);
    });
  }

  /** O app abriu a view: cria o WebviewView e chama resolveWebviewView. */
  async resolveView(viewId) {
    const reg = this.viewProviders.get(viewId);
    if (!reg) throw new Error(`Nenhum provider registrado para a view ${viewId}`);
    for (const entry of this.webviews.values()) {
      if (entry.view && entry.view.viewType === viewId) return this._webviewInfo(entry);
    }
    const view = new WebviewView(this.webviewBridge, viewId, reg.ext);
    const entry = { webview: view.webview, view, ext: reg.ext, title: (reg.ext.views.find((v) => v.id === viewId) || {}).name || viewId };
    this.webviews.set(view.webview.handle, entry);
    view.webview.options = { ...(reg.options.webviewOptions || {}) };
    const cts = new types.CancellationTokenSource();
    await reg.provider.resolveWebviewView(view, { state: undefined }, cts.token);
    return this._webviewInfo(entry);
  }

  createWebviewPanel(ext, panel) {
    const entry = { webview: panel.webview, panel, ext, title: panel.title };
    this.webviews.set(panel.webview.handle, entry);
    this.emit({ event: 'webviewPanelCreated', ...this._webviewInfo(entry) });
    return panel;
  }

  async openWith(uri, viewType, opts) {
    const reg = this.customEditors.get(viewType);
    if (!reg) return this.showTextDocument(uri, opts);
    const { WebviewPanel } = require('./shim/webview');
    const panel = new WebviewPanel(this.webviewBridge, viewType, path.basename(uri.path) || viewType, 1, (reg.options && reg.options.webviewOptions) || {}, reg.ext);
    this.createWebviewPanel(reg.ext, panel);
    const cts = new types.CancellationTokenSource();
    if (typeof reg.provider.resolveCustomTextEditor === 'function') {
      const doc = await this.openTextDocument(uri).catch(() => new TextDocument(uri, ''));
      await reg.provider.resolveCustomTextEditor(doc, panel, cts.token);
    } else if (typeof reg.provider.openCustomDocument === 'function') {
      const doc = await reg.provider.openCustomDocument(uri, {}, cts.token);
      await reg.provider.resolveCustomEditor(doc, panel, cts.token);
    }
    return undefined;
  }

  _webviewInfo(entry) {
    return {
      handle: entry.webview.handle,
      viewType: entry.webview.viewType,
      kind: entry.webview.kind,
      extensionId: entry.ext.id,
      title: entry.panel ? entry.panel.title : entry.view && entry.view.title ? entry.view.title : entry.title,
      url: entry.webview.html ? this.server.webviewUrl(entry.webview.handle, entry.webview._htmlVersion) : null,
    };
  }

  _onWebviewHtml(webview) {
    const entry = this.webviews.get(webview.handle);
    if (!entry) return; // ainda dentro do construtor; resolveView reporta a URL
    this.emit({ event: 'webviewHtml', ...this._webviewInfo(entry) });
  }

  getWebviewHtml(handle) {
    const entry = this.webviews.get(handle);
    if (!entry || !entry.webview.html) return null;
    const preamble = buildPreamble({
      handle,
      viewType: entry.webview.viewType,
      state: entry.webview.state,
      themeVars: this.themeVars,
      themeKind: this.themeKind,
      debug: this.debugWebviews,
    });
    return injectPreamble(entry.webview.html, preamble);
  }

  _postToWebview(handle, message) {
    if (!this.webviews.has(handle)) return false;
    if (this.debugWebviews) this.log(`ext→webview ${handle}:`, summarize(message));
    this.emit({ event: 'postMessage', handle, message });
    return true;
  }

  /** Mensagem vinda do iframe (acquireVsCodeApi().postMessage). */
  webviewMessage(handle, message) {
    const entry = this.webviews.get(handle);
    if (!entry) return false;
    if (this.debugWebviews) this.log(`webview→ext ${handle}:`, summarize(message));
    entry.webview._receive(message);
    return true;
  }

  setWebviewState(handle, state) {
    const entry = this.webviews.get(handle);
    if (entry) entry.webview.state = state;
  }

  setWebviewVisible(handle, visible) {
    const entry = this.webviews.get(handle);
    if (!entry) return;
    if (entry.view) entry.view._setVisible(!!visible);
    if (entry.panel) {
      entry.panel.visible = !!visible;
      entry.panel._onDidChangeViewState.fire({ webviewPanel: entry.panel });
    }
  }

  _disposeWebview(handle, fromApp) {
    const entry = this.webviews.get(handle);
    if (!entry) return;
    this.webviews.delete(handle);
    if (fromApp) {
      if (entry.view) entry.view._dispose();
      if (entry.panel) entry.panel.dispose();
    }
    this.emit({ event: 'webviewDisposed', handle });
  }

  disposeWebview(handle) {
    this._disposeWebview(handle, true);
  }

  setTheme(vars, kind) {
    this.themeVars = vars || {};
    this.themeKind = kind || 'dark';
  }

  // --------------------------------------------------------- documentos
  async openTextDocument(arg) {
    if (arg && typeof arg === 'object' && !Uri.isUri(arg) && !arg.scheme) {
      const doc = new TextDocument(Uri.parse(`untitled:Untitled-${this.documents.size + 1}`), arg.content || '', arg.language);
      this.documents.set(doc.uri.toString(), doc);
      this.events.openDocument.fire(doc);
      return doc;
    }
    const uri = toUri(arg);
    const key = uri.toString();
    const existing = this.documents.get(key);
    if (existing) {
      // Sem watcher no PoC: documento limpo é relido do disco a cada abertura
      // (o CLI do agente edita arquivos por fora).
      if (uri.scheme === 'file' && !existing.isDirty) {
        try {
          if (existing._update(await fs.promises.readFile(uri.fsPath, 'utf8'))) this.events.changeDocument.fire({ document: existing, contentChanges: [], reason: undefined });
        } catch {
          /* mantém o conteúdo conhecido */
        }
      }
      return existing;
    }
    let text;
    if (uri.scheme === 'file') {
      text = await fs.promises.readFile(uri.fsPath, 'utf8');
    } else if (this.contentProviders.has(uri.scheme)) {
      const cts = new types.CancellationTokenSource();
      text = await this.contentProviders.get(uri.scheme).provideTextDocumentContent(uri, cts.token);
    } else if (this.fsProviders.has(uri.scheme)) {
      text = Buffer.from(await this.fsProviders.get(uri.scheme).readFile(uri)).toString('utf8');
    } else if (uri.scheme === 'untitled') {
      text = '';
    } else {
      throw new Error(`Não é possível abrir documento com esquema '${uri.scheme}'`);
    }
    const doc = new TextDocument(uri, text);
    this.documents.set(key, doc);
    this.events.openDocument.fire(doc);
    return doc;
  }

  async _textOf(uri) {
    try {
      const doc = await this.openTextDocument(uri);
      return doc.getText();
    } catch (err) {
      if (uri.scheme === 'file') return '';
      throw err;
    }
  }

  async showTextDocument(docOrUri, columnOrOptions, _preserveFocus) {
    const doc = Uri.isUri(docOrUri) || typeof docOrUri === 'string' ? await this.openTextDocument(docOrUri) : docOrUri;
    const opts = columnOrOptions && typeof columnOrOptions === 'object' ? columnOrOptions : {};
    const sel = opts.selection ? new Selection(opts.selection.start, opts.selection.end) : undefined;
    if (doc.uri.scheme === 'file') {
      this.emit({
        event: 'openFile',
        path: doc.uri.fsPath,
        selection: sel ? { start: { line: sel.start.line, character: sel.start.character }, end: { line: sel.end.line, character: sel.end.character } } : undefined,
        preview: opts.preview,
      });
    } else {
      // Documento virtual: mostra como somente leitura no app.
      this.emit({ event: 'openVirtualDocument', uri: doc.uri.toString(), title: path.basename(doc.uri.path), languageId: doc.languageId, content: doc.getText() });
    }
    const editor = new TextEditor(doc, sel, typeof columnOrOptions === 'number' ? columnOrOptions : opts.viewColumn || 1);
    this._setActiveEditor(editor);
    return editor;
  }

  async openDiff(left, right, title, opts) {
    const [leftContent, rightContent] = await Promise.all([this._textOf(left), this._textOf(right)]);
    this.emit({
      event: 'diff',
      title: title || `${path.basename(left.path)} ↔ ${path.basename(right.path)}`,
      left: { uri: left.toString(), path: left.scheme === 'file' ? left.fsPath : undefined, content: leftContent },
      right: { uri: right.toString(), path: right.scheme === 'file' ? right.fsPath : undefined, content: rightContent },
      preview: opts && opts.preview,
    });
    // O diff aparece como aba TabInputTextDiff (as extensões consultam tabGroups).
    this._diffTabs.push({ left, right, title });
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
    return undefined;
  }

  async applyWorkspaceEdit(edit) {
    const touched = [];
    try {
      for (const op of edit._edits || []) {
        if (op.kind === 'create') {
          await fs.promises.mkdir(path.dirname(op.uri.fsPath), { recursive: true });
          if (!(op.options && op.options.ignoreIfExists && fs.existsSync(op.uri.fsPath))) await fs.promises.writeFile(op.uri.fsPath, '');
          touched.push(op.uri.fsPath);
        } else if (op.kind === 'delete') {
          await fs.promises.rm(op.uri.fsPath, { recursive: !!(op.options && op.options.recursive), force: !!(op.options && op.options.ignoreIfNotExists) });
          touched.push(op.uri.fsPath);
        } else if (op.kind === 'rename') {
          await fs.promises.rename(op.uri.fsPath, op.newUri.fsPath);
          touched.push(op.uri.fsPath, op.newUri.fsPath);
        }
      }
      for (const [uri, edits] of edit.entries()) {
        const doc = await this.openTextDocument(uri);
        let text = doc.getText();
        const sorted = edits.map((e) => ({ s: doc.offsetAt(e.range.start), e: doc.offsetAt(e.range.end), t: e.newText })).sort((a, b) => b.s - a.s);
        for (const e of sorted) text = text.slice(0, e.s) + e.t + text.slice(e.e);
        if (uri.scheme === 'file') {
          await fs.promises.writeFile(uri.fsPath, text);
          touched.push(uri.fsPath);
        }
        if (doc._update(text)) this.events.changeDocument.fire({ document: doc, contentChanges: [], reason: undefined });
      }
    } catch (err) {
      this.log('applyEdit falhou:', err);
      return false;
    }
    if (touched.length) this.emit({ event: 'filesChanged', paths: touched });
    return true;
  }

  notifyFileChanged(fsPath) {
    this.emit({ event: 'filesChanged', paths: [fsPath] });
  }

  // ------------------------------------------------------ editor (do app)
  get activeTextEditor() {
    return this._activeEditor;
  }
  get visibleTextEditors() {
    return this._visibleEditors;
  }

  _setActiveEditor(editor) {
    this._activeEditor = editor;
    this._visibleEditors = editor ? [editor, ...this._visibleEditors.filter((e) => e.document !== editor.document)] : [];
    this.events.activeTextEditor.fire(editor);
    this.events.visibleTextEditors.fire(this._visibleEditors);
  }

  /**
   * Estado do editor publicado pelo Fluent Coder (Monaco):
   * { path, languageId?, text?, selection?:{start:{line,character},end:{…}}, openFiles?:string[] }
   * `path: null` = nenhum editor de texto ativo.
   */
  async setEditorState(state) {
    this._openFiles = Array.isArray(state.openFiles) ? state.openFiles : this._openFiles || [];
    if (!state.path) {
      if (this._activeEditor) this._setActiveEditor(undefined);
      this.events.tabs.fire({ opened: [], closed: [], changed: [] });
      return;
    }
    const uri = Uri.file(state.path);
    let doc = this.documents.get(uri.toString());
    if (!doc) {
      let text = state.text;
      if (typeof text !== 'string') {
        try {
          text = await fs.promises.readFile(state.path, 'utf8');
        } catch {
          text = '';
        }
      }
      doc = new TextDocument(uri, text, state.languageId);
      this.documents.set(uri.toString(), doc);
      this.events.openDocument.fire(doc);
    } else if (typeof state.text === 'string') {
      doc.isDirty = !!state.dirty;
      if (doc._update(state.text)) this.events.changeDocument.fire({ document: doc, contentChanges: [], reason: undefined });
    } else if (doc.isDirty) {
      // Buffer voltou a ficar limpo (salvo): o disco é a verdade de novo.
      doc.isDirty = false;
      try {
        if (doc._update(await fs.promises.readFile(state.path, 'utf8'))) this.events.changeDocument.fire({ document: doc, contentChanges: [], reason: undefined });
      } catch {
        /* arquivo sumiu */
      }
      this.events.saveDocument.fire(doc);
    }
    const s = state.selection;
    const sel = s ? new Selection(new Position(s.start.line, s.start.character), new Position(s.end.line, s.end.character)) : new Selection(0, 0, 0, 0);
    const cur = this._activeEditor;
    if (cur && cur.document === doc) {
      if (!cur.selection.isEqual(sel)) {
        cur.selections = [sel];
        this.events.textEditorSelection.fire({ textEditor: cur, selections: cur.selections, kind: types.TextEditorSelectionChangeKind.Mouse });
      }
    } else {
      this._setActiveEditor(new TextEditor(doc, sel, 1));
      this.events.textEditorSelection.fire({ textEditor: this._activeEditor, selections: this._activeEditor.selections, kind: undefined });
    }
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
  }

  get tabGroups() {
    const host = this;
    const tabs = (this._openFiles || []).map((p) => ({
      label: path.basename(p),
      input: new types.TabInputText(Uri.file(p)),
      isActive: !!(host._activeEditor && host._activeEditor.document.uri.fsPath === p),
      isDirty: false,
      isPinned: false,
      isPreview: false,
    }));
    for (const d of this._diffTabs) tabs.push({ label: d.title || 'diff', input: new types.TabInputTextDiff(d.left, d.right), isActive: false, isDirty: false, isPinned: false, isPreview: false });
    const group = { isActive: true, viewColumn: 1, tabs, activeTab: tabs.find((t) => t.isActive) };
    for (const t of tabs) t.group = group;
    return {
      all: [group],
      activeTabGroup: group,
      onDidChangeTabs: this.events.tabs.event,
      onDidChangeTabGroups: this.events.tabGroups.event,
      close: async (tabOrTabs) => {
        const list = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
        for (const t of list) {
          if (t && t.input instanceof types.TabInputTextDiff) {
            host._diffTabs = host._diffTabs.filter((d) => d.left.toString() !== t.input.original.toString() || d.right.toString() !== t.input.modified.toString());
            host.emit({ event: 'closeDiff', left: t.input.original.toString(), right: t.input.modified.toString() });
          }
        }
        host.events.tabs.fire({ opened: [], closed: list, changed: [] });
        return true;
      },
    };
  }

  // ---------------------------------------------------------- terminal
  createTerminal(ext, options) {
    const host = this;
    const em = new EventEmitter();
    const term = {
      name: options.name || 'Terminal',
      creationOptions: options,
      processId: Promise.resolve(undefined),
      exitStatus: undefined,
      state: { isInteractedWith: false },
      shellIntegration: undefined,
      sendText(text, addNewLine = true) {
        host.emit({ event: 'terminalSendText', name: term.name, text: addNewLine ? text + '\n' : text });
      },
      show() {
        host.emit({ event: 'terminalShow', name: term.name, options: safeOptions(options) });
      },
      hide() {},
      dispose() {
        host.terminals = host.terminals.filter((t) => t !== term);
        host.events.closeTerminal.fire(term);
      },
      onDidWrite: em.event,
    };
    this.terminals.push(term);
    this.events.openTerminal.fire(term);
    this.log(`createTerminal (stub, sem PTY no PoC): ${term.name}`);
    return term;
  }

  handleUri(uri) {
    for (const [id, handler] of this.uriHandlers) {
      if (uri.authority && uri.authority.toLowerCase() !== id) continue;
      try {
        handler.handleUri(uri);
        return true;
      } catch (err) {
        this.log('handleUri falhou:', err);
      }
    }
    return false;
  }
}

function safeOptions(o) {
  return { name: o.name, cwd: o.cwd ? String(o.cwd.fsPath || o.cwd) : undefined, shellPath: o.shellPath, shellArgs: o.shellArgs };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function summarize(m) {
  const s = safeJson(m) || '';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

module.exports = { ExtensionHost, installRequireHook, os, Range };
