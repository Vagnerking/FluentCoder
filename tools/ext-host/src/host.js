// ExtensionHost: carrega extensões VS Code instaladas localmente, intercepta
// `require('vscode')` e mantém o estado compartilhado do shim (comandos,
// webviews, documentos, editores, abas, terminais, diagnósticos). Independe de
// transporte: os eventos para o app saem por `emit(obj)`; o main.js liga isso
// ao stdio (JSON por linha).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Module = require('module');
const { encodeBinary, decodeBinary } = require('./bincodec');

const types = require('./shim/types');
const { ConfigurationStore } = require('./shim/configuration');
const { JsonMemento, FileSecretStorage, KeyringSecretStorage } = require('./shim/memento');
const { WebviewView } = require('./shim/webview');
const { TextDocument, TextEditor, toRange } = require('./shim/documents');
const { Terminal } = require('./shim/terminal');
const { WatchService } = require('./shim/watcher');
const { CommentService } = require('./shim/comments');
const { TaskService } = require('./shim/tasks');
const { QuickInputService } = require('./shim/quickinput');
const { ProgressService } = require('./shim/progress');
const { NotebookService } = require('./shim/notebooks');
const { createVscodeApi, toUri } = require('./shim/api');
const { ResourceServer } = require('./server');
const { buildPreamble, injectPreamble } = require('./preamble');
const { readContributions, localizeManifest, displayNameOf } = require('./contributions');
const { evaluateWhen } = require('./when');

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

function plainRange(r) {
  return { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } };
}

function toSelection(s) {
  if (!s) return new Selection(0, 0, 0, 0);
  const a = s.anchor || s.start;
  const b = s.active || s.end;
  return new Selection(new Position(a.line, a.character), new Position(b.line, b.character));
}

/** Caminho comparável (Windows: sem diferenciar maiúsculas). */
function pathKey(p) {
  const n = path.resolve(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** Tempo mínimo entre abrir um diff e executar aceitar/rejeitar da extensão. */
const DIFF_SETTLE_MS = 400;

const SEVERITY = { error: 0, warning: 1, info: 2, information: 2, hint: 3 };

class ExtensionHost {
  /**
   * @param {{dataDir:string, workspaceFolders?:string[], language?:string, appRoot?:string,
   *   emit?:(evt:object)=>void, verbose?:boolean, debugWebviews?:boolean, wrapApi?:(api:object, ext:object)=>object,
   *   appConnected?:boolean, secretsBackend?:'keyring'|'file', serverPort?:number}} opts
   */
  constructor(opts) {
    this.dataDir = opts.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.emitFn = opts.emit || (() => {});
    this.verbose = !!opts.verbose;
    this.debugWebviews = !!opts.debugWebviews;
    this.wrapApi = opts.wrapApi;
    this.language = opts.language || 'pt-br';
    /** Linguagens do registro do Monaco (o app manda em `setLanguages`); antes disso, as básicas. */
    this.languageIds = [...DEFAULT_LANGUAGE_IDS];
    this.appRoot = opts.appRoot || path.resolve(__dirname, '..');
    this.secretsBackend = opts.secretsBackend === 'keyring' ? 'keyring' : 'file';
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
    this.diagnostics = new Map(); // uri.toString() → Diagnostic[] (markers do app)
    this.diagnosticCollections = new Set();
    this.terminals = [];
    this._activeTerminal = undefined;
    this.statusBarItems = new Map();
    this.decorationTypes = new Map();
    this.windowState = { focused: true, active: true };
    this.themeVars = {};
    this.themeKind = 'dark';
    this.pending = new Map();
    this.nextRequest = 1;
    this.appConnected = !!opts.appConnected;
    // `files.watcherExclude` lido a cada walk/evento (muda sem reiniciar o host).
    this.watchers = new WatchService((m) => this.log(m), { excludes: () => this.config.lookup('files.watcherExclude') });
    this.comments = new CommentService(this);
    this.tasks = new TaskService(this);
    this.quickInputs = new QuickInputService(this);
    this.progress = new ProgressService(this);
    this.notebooks = new NotebookService(this);
    this._activeEditor = undefined;
    this._visibleEditors = [];
    this._appTabs = []; // [{path, dirty, active, preview}]
    this._diffTabs = []; // [{id, left, right, title, ext, editors}]
    this._activeDiff = null; // id do diff com foco (aba ativa do grupo)
    this._nextDiff = 1;
    this._outputBuf = new Map();
    this._outputTimer = null;
    this.events = {
      never: new EventEmitter(),
      activeTextEditor: new EventEmitter(),
      visibleTextEditors: new EventEmitter(),
      textEditorSelection: new EventEmitter(),
      textEditorVisibleRanges: new EventEmitter(),
      windowState: new EventEmitter(),
      openTerminal: new EventEmitter(),
      closeTerminal: new EventEmitter(),
      activeTerminal: new EventEmitter(),
      terminalState: new EventEmitter(),
      terminalShellIntegration: new EventEmitter(),
      startShellExecution: new EventEmitter(),
      endShellExecution: new EventEmitter(),
      workspaceFolders: new EventEmitter(),
      openDocument: new EventEmitter(),
      closeDocument: new EventEmitter(),
      changeDocument: new EventEmitter(),
      willSaveDocument: new EventEmitter(),
      saveDocument: new EventEmitter(),
      diagnostics: new EventEmitter(),
      tabs: new EventEmitter(),
      tabGroups: new EventEmitter(),
      createFiles: new EventEmitter(),
      deleteFiles: new EventEmitter(),
      renameFiles: new EventEmitter(),
    };
    this.setWorkspaceFolders(opts.workspaceFolders || []);
    this.server = new ResourceServer({ getWebviewHtml: (h) => this.getWebviewHtml(h), log: (m) => this.log(m), preferredPort: opts.serverPort });
    const server = this.server;
    this.webviewBridge = {
      resourceUrl: (uri) => this.resourceUrl(uri),
      get cspSource() {
        return server.origin;
      },
      onHtml: (wv) => this._onWebviewHtml(wv),
      post: (handle, message) => this._postToWebview(handle, message),
      allowRoots: (roots) => roots.forEach((r) => this.server.allowRoot(toUri(r).fsPath)),
      reveal: (handle, preserveFocus, viewColumn) => this.emit({ event: 'revealWebview', handle, preserveFocus, viewColumn: typeof viewColumn === 'number' ? viewColumn : undefined }),
      retitle: (handle, title) => {
        this.emit({ event: 'webviewTitle', handle, title });
        this._panelsChanged();
      },
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
    // Encerrando: os painéis que as extensões descartarem no deactivate NÃO
    // saem da lista persistida (o app os restaura na próxima sessão).
    this._stopping = true;
    clearTimeout(this._panelsTimer);
    for (const ext of this.extensions.values()) await this.deactivate(ext.id);
    this.watchers.closeAll();
    this._flushOutput();
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
  /** Registro de linguagens do Monaco (ids únicos, na ordem do app). */
  setLanguages(list) {
    const ids = [];
    for (const l of list || []) {
      const id = typeof l === 'string' ? l : l && l.id;
      if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length) this.languageIds = ids;
  }

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
    // Traduzido UMA vez aqui: `extensions.getExtension(id).packageJSON` sai
    // localizado, como no VS Code (o scanner de lá entrega o manifesto traduzido).
    const packageJSON = localizeManifest(JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8')), extensionPath, this.language);
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
      activating: null,
      exports: undefined,
      module: null,
      context: null,
      api: null,
      contributions: readContributions(packageJSON, extensionPath, this.language),
    };
    this.config.addDefaults(packageJSON);
    this.server.allowRoot(extensionPath, id);
    const api = createVscodeApi(this, ext);
    ext.api = this.wrapApi ? this.wrapApi(api, ext) : api;
    this.extensions.set(id, ext);
    ext.views = ext.contributions.views.filter((v) => v.type === 'webview').map((v) => ({ id: v.id, name: v.name, container: v.container, when: v.when }));
    this.emit({ event: 'extensionLoaded', extension: this.describe(ext) });
    return ext;
  }

  describe(ext) {
    return {
      id: ext.id,
      name: ext.packageJSON.name,
      displayName: displayNameOf(ext.packageJSON),
      version: ext.packageJSON.version,
      publisher: ext.packageJSON.publisher,
      path: ext.extensionPath,
      isActive: ext.isActive,
      views: ext.views,
      commands: ext.contributions.commands,
      keybindings: ext.contributions.keybindings,
      viewsContainers: ext.contributions.viewsContainers,
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
    ext.envVars = envVars;
    const secretsFile = path.join(storeDir, 'secrets.json');
    const secrets =
      this.secretsBackend === 'keyring'
        ? new KeyringSecretStorage({
            extensionId: ext.id,
            indexFile: path.join(storeDir, 'secret-keys.json'),
            legacyFile: secretsFile,
            backend: (op, account, value) => this.rustRequest('secrets', { op, account, value }),
            log: (m) => this.log(m),
          })
        : new FileSecretStorage(secretsFile);
    return {
      subscriptions: [],
      workspaceState,
      globalState,
      secrets,
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

  /** Ativa uma vez (chamadas concorrentes esperam a mesma ativação). */
  activate(id) {
    const ext = this.extensions.get(id);
    if (!ext) return Promise.reject(new Error(`Extensão não carregada: ${id}`));
    if (ext.isActive) return Promise.resolve(ext.exports);
    if (!ext.activating) {
      ext.activating = this._activate(ext).finally(() => {
        ext.activating = null;
      });
    }
    return ext.activating;
  }

  async _activate(ext) {
    if (!ext.mainPath) {
      ext.isActive = true;
      return undefined;
    }
    const t0 = Date.now();
    ext.module = require(ext.mainPath);
    const tRequire = Date.now() - t0;
    ext.context = this.createContext(ext);
    if (typeof ext.module.activate === 'function') ext.exports = await ext.module.activate(ext.context);
    ext.isActive = true;
    ext.activationMs = Date.now() - t0;
    this.log(`ativada ${ext.id} em ${ext.activationMs}ms (require ${tRequire}ms)`);
    this.emit({ event: 'extensionActivated', extension: this.describe(ext), ms: ext.activationMs });
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
    // Comando contribuído por extensão ainda não ativa: ativa (onCommand) e tenta de novo.
    for (const ext of this.extensions.values()) {
      if (!ext.isActive && ext.contributions.commands.some((x) => x.command === id)) {
        await this.activate(ext.id);
        const again = this.commands.get(id);
        if (again) return again.cb.apply(again.thisArg, args);
      }
    }
    // Comandos do workbench (ex.: Ctrl+Shift+P) vão ao app.
    if (/^workbench\.action\./.test(id)) {
      this.emit({ event: 'appCommand', command: id, args: safeArgs(args) });
      return undefined;
    }
    this.log(`executeCommand sem implementação (ignorado): ${id}`);
    return undefined;
  }

  _installBuiltinCommands() {
    const noop = () => undefined;
    const app = (command) => (...args) => this.emit({ event: 'appCommand', command, args: safeArgs(args) });
    this.builtins = {
      setContext: (key, value) => {
        this.contexts.set(key, value);
        this.emit({ event: 'context', key, value: safeArgs([value])[0] });
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
      'workbench.action.closeActiveEditor': () => {
        const tab = this.tabGroups.activeTabGroup.activeTab;
        return tab ? this.tabGroups.close(tab) : undefined;
      },
      'workbench.action.files.save': () => (this._activeEditor ? this._activeEditor.document.save() : undefined),
      'workbench.action.files.saveAll': () => this.saveAll(),
      'workbench.action.focusActiveEditorGroup': app('focusEditor'),
      'workbench.action.focusFirstEditorGroup': app('focusEditor'),
      'workbench.action.focusSideBar': noop,
      'workbench.action.focusAuxiliaryBar': noop,
      'workbench.action.lockEditorGroup': noop,
      'workbench.action.unlockEditorGroup': noop,
      'workbench.action.moveEditorToNewWindow': noop,
      'workbench.files.action.refreshFilesExplorer': () => this.emit({ event: 'filesChanged', paths: [] }),
      revealInExplorer: (uri) => this.emit({ event: 'revealInExplorer', path: toUri(uri).fsPath }),
      revealFileInOS: (uri) => this.emit({ event: 'revealInExplorer', path: toUri(uri).fsPath, os: true }),
      'vscode.executeDocumentSymbolProvider': () => Promise.resolve([]),
      'vscode.executeWorkspaceSymbolProvider': () => Promise.resolve([]),
      'vscode.executeDefinitionProvider': () => Promise.resolve([]),
      'vscode.executeReferenceProvider': () => Promise.resolve([]),
      'vscode.executeHoverProvider': () => Promise.resolve([]),
      'editor.action.formatDocument': app('formatDocument'),
      'workbench.action.terminal.focus': () => this.emit({ event: 'appCommand', command: 'terminal.focus', args: [] }),
      'workbench.action.terminal.new': () => this.emit({ event: 'appCommand', command: 'terminal.new', args: [] }),
      'workbench.action.chat.open': noop,
      'workbench.extensions.installExtension': () => Promise.reject(new Error('Instalação de extensões não suportada.')),
      'workbench.extensions.search': noop,
      'workbench.action.openWalkthrough': noop,
      'markdown.showPreview': (uri) => this.showTextDocument(toUri(uri)),
      'git.openChange': noop,
      // Sem notebooks: executar célula é no-op (o Claude só chama com um notebook ativo).
      'notebook.cell.execute': noop,
      'notebook.execute': noop,
      'default:type': noop,
      cursorMove: noop,
      'editor.action.revealDefinition': noop,
    };
  }

  /** Comandos contribuídos (Paleta do app), com o estado de ativação. */
  contributedCommands() {
    const out = [];
    for (const ext of this.extensions.values()) {
      for (const c of ext.contributions.commands) {
        if (c.hidden) continue;
        if (c.paletteWhen && !this.evaluateWhen(c.paletteWhen)) continue;
        out.push({ extensionId: ext.id, command: c.command, title: c.title, category: c.category });
      }
    }
    return out;
  }

  /** Valor de uma chave de contexto (`config.*`, setContext, foco publicado pelo app). */
  contextValue(key, extra) {
    if (extra && Object.prototype.hasOwnProperty.call(extra, key)) return extra[key];
    if (key.startsWith('config.')) return this.config.lookup(key.slice(7));
    if (this.contexts.has(key)) return this.contexts.get(key);
    switch (key) {
      case 'isLinux':
        return process.platform === 'linux';
      case 'isWindows':
        return process.platform === 'win32';
      case 'isMac':
        return process.platform === 'darwin';
      case 'isWeb':
        return false;
      case 'workspaceFolderCount':
        return this.workspaceFolders.length;
      case 'activeEditor':
        return this._activeDiff ? 'workbench.editors.textDiffEditor' : this._activeEditor ? 'workbench.editors.files.textFileEditor' : undefined;
      case 'isInDiffEditor':
        return !!this._activeDiff;
      case 'activeWebviewPanelId': {
        const e = this._activePanel && !this._activeDiff ? this.webviews.get(this._activePanel) : null;
        return e ? e.webview.viewType : undefined;
      }
      case 'resourceScheme': {
        const d = this._diffById(this._activeDiff);
        if (d) return d.right.scheme;
        return this._activeEditor ? this._activeEditor.document.uri.scheme : undefined;
      }
      case 'resourceLangId':
        return this._activeEditor ? this._activeEditor.document.languageId : undefined;
      default:
        return undefined;
    }
  }

  evaluateWhen(expr, extra) {
    return evaluateWhen(expr, (k) => this.contextValue(k, extra));
  }

  /**
   * Atalho contribuído (best effort): o app manda a tecla normalizada
   * ("ctrl+escape") e o contexto de foco; executa o 1º binding cujo `when` vale.
   */
  async runKeybinding(key, focusContext) {
    const k = String(key || '').toLowerCase();
    for (const ext of this.extensions.values()) {
      for (const kb of ext.contributions.keybindings) {
        if (kb.key !== k) continue;
        if (!this.evaluateWhen(kb.when, focusContext || {})) continue;
        await this.executeCommand(kb.command, ...(kb.args !== undefined ? [kb.args] : []));
        return { handled: true, command: kb.command };
      }
    }
    return { handled: false };
  }

  // ------------------------------------------------------ pedidos ao app
  /** Pede algo ao app (diálogo, quick pick, edição…). Sem app conectado → undefined. */
  request(kind, params, timeoutMs) {
    if (!this.appConnected) {
      this.log(`request '${kind}' sem app conectado → undefined`, params && (params.message || params.title || ''));
      return Promise.resolve(undefined);
    }
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      let timer = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(requestId);
          resolve(undefined);
        }, timeoutMs);
      }
      this.pending.set(requestId, (v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      });
      this.emit({ event: 'request', requestId, kind, params });
    });
  }

  /**
   * Pedido atendido pelo backend Rust (não pelo frontend): a linha começa com
   * `{"event":"<tipo>"` e o Rust a desvia (ex.: segredos no cofre do SO).
   */
  rustRequest(event, payload, timeoutMs = 20000) {
    const requestId = this.nextRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'tempo esgotado esperando o backend' });
      }, timeoutMs);
      this.pending.set(requestId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      // A ordem das chaves importa: o Rust reconhece pelo prefixo.
      this.emit({ event, requestId, ...payload });
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
    const t0 = Date.now();
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
    const info = this._webviewInfo(entry);
    info.resolveMs = Date.now() - t0;
    this.log(`view ${viewId} resolvida em ${info.resolveMs}ms (${info.handle}, HTML ${info.url ? 'definido' : 'pendente'})`);
    return info;
  }

  createWebviewPanel(ext, panel) {
    const entry = { webview: panel.webview, panel, ext, title: panel.title, customUri: panel._customUri };
    this.webviews.set(panel.webview.handle, entry);
    if (panel.active) {
      this._activePanel = panel.webview.handle;
      this._activeDiff = null;
    }
    this.emit({ event: 'webviewPanelCreated', ...this._webviewInfo(entry) });
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
    this._panelsChanged();
    return panel;
  }

  // ------------------------------------------- persistência dos painéis
  /**
   * Painéis abertos em formato persistível (o app guarda por workspace e
   * devolve em `restoreWebviewPanels` na próxima sessão), como o VS Code faz
   * com `registerWebviewPanelSerializer` e os custom editors.
   */
  panelSnapshot() {
    const out = [];
    for (const entry of this.webviews.values()) {
      if (!entry.panel || entry.panel._disposed) continue;
      const rec = {
        viewType: entry.webview.viewType,
        extensionId: entry.ext.id,
        title: String(entry.panel.title || '').slice(0, 1024),
        viewColumn: typeof entry.panel.viewColumn === 'number' && entry.panel.viewColumn > 0 ? entry.panel.viewColumn : undefined,
        active: !!entry.panel.active,
        options: pickPanelOptions(entry.webview.options),
      };
      if (entry.customUri) rec.customUri = entry.customUri.toString();
      if (entry.webview.state !== undefined) {
        const json = safeJson(entry.webview.state);
        if (json && json.length <= MAX_PERSISTED_STATE) rec.state = entry.webview.state;
      }
      out.push(rec);
    }
    return out.slice(0, MAX_PERSISTED_PANELS);
  }

  /** Avisa o app (com debounce) que a lista persistível mudou. */
  _panelsChanged() {
    if (this._stopping) return;
    clearTimeout(this._panelsTimer);
    this._panelsTimer = setTimeout(() => {
      if (!this._stopping) this.emit({ event: 'webviewPanels', panels: this.panelSnapshot() });
    }, PANELS_DEBOUNCE_MS);
    if (this._panelsTimer.unref) this._panelsTimer.unref();
  }

  /**
   * Restaura UM painel persistido: custom editor → `openWith(uri)` de novo;
   * painel comum → `deserializeWebviewPanel(panel, state)` do serializer da
   * extensão. Sem serializer/editor registrado após ativar, o painel é
   * descartado (como no VS Code). Devolve true se restaurou.
   */
  async restoreWebviewPanel(rec) {
    const ext = this.extensions.get(String(rec.extensionId || '').toLowerCase());
    if (!ext) return false;
    if (!ext.isActive) await this.activate(ext.id);
    const viewColumn = typeof rec.viewColumn === 'number' && rec.viewColumn >= 1 ? rec.viewColumn : -1;
    if (rec.customUri) {
      const reg = this.customEditors.get(rec.viewType);
      if (!reg || reg.ext !== ext) return false;
      let uri;
      try {
        uri = Uri.parse(rec.customUri);
      } catch {
        return false;
      }
      await this.openWith(uri, rec.viewType, { viewColumn, preserveFocus: true, state: rec.state });
      return true;
    }
    const serializer = this.serializers.get(rec.viewType);
    if (!serializer || serializer.ext !== ext || typeof serializer.serializer.deserializeWebviewPanel !== 'function') return false;
    const { WebviewPanel } = require('./shim/webview');
    const panel = new WebviewPanel(this.webviewBridge, rec.viewType, String(rec.title || rec.viewType), { viewColumn, preserveFocus: true }, pickPanelOptions(rec.options), ext);
    panel.webview.state = rec.state;
    this.createWebviewPanel(ext, panel);
    try {
      await serializer.serializer.deserializeWebviewPanel(panel, rec.state);
    } catch (err) {
      this.log(`deserializeWebviewPanel (${rec.viewType}) falhou:`, err);
      panel.dispose();
      return false;
    }
    return true;
  }

  async openWith(uri, viewType, opts) {
    const reg = this.customEditors.get(viewType);
    if (!reg) return this.showTextDocument(uri, opts);
    const { WebviewPanel } = require('./shim/webview');
    const showOptions = { viewColumn: (opts && opts.viewColumn) || -1, preserveFocus: !!(opts && opts.preserveFocus) };
    const panel = new WebviewPanel(this.webviewBridge, viewType, path.basename(uri.path) || viewType, showOptions, (reg.options && reg.options.webviewOptions) || {}, reg.ext);
    panel._customUri = uri;
    if (opts && opts.state !== undefined) panel.webview.state = opts.state;
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
      // Flags de sandbox que o iframe precisa (só o necessário; ver docs).
      enableForms: entry.webview.options.enableForms !== false,
      // Painel = aba na grade de editores: onde abrir e se rouba o foco.
      viewColumn: entry.panel ? entry.panel.viewColumn : undefined,
      preserveFocus: entry.panel ? !!entry.panel._preserveFocus : undefined,
    };
  }

  _onWebviewHtml(webview) {
    const entry = this.webviews.get(webview.handle);
    if (!entry) return; // ainda dentro do construtor; resolveView reporta a URL
    // Ciclo de vida na Saída "Extensões": HTML → iframe montado → UI carregada.
    // Uma UI que não chega a "carregada" fica diagnosticável sem DevTools.
    this.log(`webview ${webview.handle} (${webview.viewType}): HTML definido`);
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
    this.emit({ event: 'postMessage', handle, message: encodeBinary(message) });
    return true;
  }

  /** Mensagem vinda do iframe (acquireVsCodeApi().postMessage). */
  webviewMessage(handle, message) {
    const entry = this.webviews.get(handle);
    if (!entry) return false;
    if (this.debugWebviews) this.log(`webview→ext ${handle}:`, summarize(message));
    entry.webview._receive(decodeBinary(message));
    return true;
  }

  setWebviewState(handle, state) {
    const entry = this.webviews.get(handle);
    if (!entry) return;
    entry.webview.state = state;
    if (entry.panel) this._panelsChanged();
  }

  setWebviewVisible(handle, visible) {
    const entry = this.webviews.get(handle);
    if (!entry) return;
    if (entry.view) entry.view._setVisible(!!visible);
    if (entry.panel) entry.panel._setViewState({ active: entry.panel.active && !!visible, visible: !!visible, viewColumn: entry.panel.viewColumn });
  }

  /** Aba do painel na grade do app: ativa/visível/coluna → onDidChangeViewState. */
  setWebviewPanelState({ handle, active, visible, viewColumn }) {
    const entry = this.webviews.get(handle);
    if (!entry || !entry.panel) return;
    entry.panel._setViewState({ active, visible, viewColumn });
    this._panelsChanged();
    if (active) {
      this._activePanel = handle;
      this._activeDiff = null;
    } else if (this._activePanel === handle) this._activePanel = null;
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
  }

  _disposeWebview(handle, fromApp) {
    const entry = this.webviews.get(handle);
    if (!entry) return;
    this.webviews.delete(handle);
    if (this._activePanel === handle) this._activePanel = null;
    if (entry.panel) {
      this.events.tabs.fire({ opened: [], closed: [], changed: [] });
      this._panelsChanged();
    }
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
      this._bindDocument(doc);
      this.documents.set(doc.uri.toString(), doc);
      this.events.openDocument.fire(doc);
      return doc;
    }
    const uri = toUri(arg);
    const key = uri.toString();
    const existing = this.documents.get(key);
    if (existing) {
      // Documento que o app não espelha: o disco é a verdade (o CLI do agente
      // edita por fora). O watcher também atualiza; reler aqui cobre a corrida.
      if (uri.scheme === 'file' && !existing._appOwned && !existing.isDirty) {
        try {
          this._replaceText(existing, await fs.promises.readFile(uri.fsPath, 'utf8'));
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
      text = await this.contentProviders.get(uri.scheme).provider.provideTextDocumentContent(uri, cts.token);
    } else if (this.fsProviders.has(uri.scheme)) {
      text = Buffer.from(await this.fsProviders.get(uri.scheme).provider.readFile(uri)).toString('utf8');
    } else if (uri.scheme === 'untitled') {
      text = '';
    } else {
      throw new Error(`Não é possível abrir documento com esquema '${uri.scheme}'`);
    }
    // Pode ter sido aberto em paralelo (await acima).
    if (this.documents.has(key)) return this.documents.get(key);
    const doc = new TextDocument(uri, text);
    this._bindDocument(doc);
    this.documents.set(key, doc);
    this.events.openDocument.fire(doc);
    return doc;
  }

  _bindDocument(doc) {
    doc._saveHandler = (d) => this.saveDocument(d);
  }

  /** Troca o texto e dispara onDidChangeTextDocument com a mudança mínima. */
  _replaceText(doc, text, version, reason) {
    const changes = doc._update(text, version);
    if (changes) this.events.changeDocument.fire({ document: doc, contentChanges: changes, reason });
    return !!changes;
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

  // ---- espelho dos modelos do Monaco (o app manda; ver editorBridge.ts)
  _docForPath(p) {
    return this.documents.get(Uri.file(path.resolve(p)).toString());
  }

  /** App abriu um modelo `file://` no Monaco. */
  documentOpened({ path: p, languageId, version, text, dirty }) {
    const uri = Uri.file(path.resolve(p));
    let doc = this.documents.get(uri.toString());
    if (doc) {
      doc._appOwned = true;
      doc.isDirty = !!dirty;
      if (languageId) doc.languageId = languageId;
      this._replaceText(doc, text, version);
      return;
    }
    doc = new TextDocument(uri, text, languageId, version || 1);
    doc._appOwned = true;
    doc.isDirty = !!dirty;
    this._bindDocument(doc);
    this.documents.set(uri.toString(), doc);
    this.events.openDocument.fire(doc);
  }

  /** Mudanças incrementais do modelo (contentChanges do Monaco, 0-based). */
  documentChanged({ path: p, version, changes, dirty, reason, text }) {
    const doc = this._docForPath(p);
    if (!doc) return;
    if (dirty !== undefined) doc.isDirty = !!dirty;
    const why = reason === 'undo' ? types.TextDocumentChangeReason.Undo : reason === 'redo' ? types.TextDocumentChangeReason.Redo : undefined;
    if (typeof text === 'string') {
      this._replaceText(doc, text, version, why);
      return;
    }
    if (version !== undefined && version <= doc.version) return; // repetido
    const contentChanges = doc._applyChanges(changes, version);
    this.events.changeDocument.fire({ document: doc, contentChanges, reason: why });
  }

  documentClosed({ path: p }) {
    const doc = this._docForPath(p);
    if (!doc) return;
    // Continua conhecido (como no VS Code, o documento só some quando ninguém o
    // referencia); passa a seguir o disco.
    doc._appOwned = false;
    doc.isDirty = false;
    this.events.closeDocument.fire(doc);
  }

  /** O app salvou (Ctrl+S ou o nosso save()). */
  documentSaved({ path: p, text }) {
    const doc = this._docForPath(p);
    if (!doc) return;
    if (typeof text === 'string') this._replaceText(doc, text);
    doc.isDirty = false;
    this.events.saveDocument.fire(doc);
    this.watchers.notify('change', path.resolve(p));
  }

  async saveDocument(doc) {
    if (doc.uri.scheme !== 'file') {
      // Lado direito de um diff (esquema virtual): "salvar" no VS Code dispara
      // onWillSave/onDidSave — o Claude Code aceita o diff assim.
      this._fireWillSave(doc);
      this.events.saveDocument.fire(doc);
      return true;
    }
    this._fireWillSave(doc);
    if (doc._appOwned && this.appConnected) {
      const r = await this.request('saveDocument', { path: doc.uri.fsPath });
      return !!(r && r.saved);
    }
    await fs.promises.writeFile(doc.uri.fsPath, doc.getText());
    doc.isDirty = false;
    this.events.saveDocument.fire(doc);
    return true;
  }

  _fireWillSave(doc) {
    const waits = [];
    this.events.willSaveDocument.fire({ document: doc, reason: types.TextDocumentSaveReason.Manual, waitUntil: (p) => waits.push(p) });
    return waits;
  }

  async saveAll() {
    const dirty = [...this.documents.values()].filter((d) => d.isDirty);
    for (const d of dirty) await this.saveDocument(d);
    return true;
  }

  async showTextDocument(docOrUri, columnOrOptions, preserveFocusArg) {
    const doc = Uri.isUri(docOrUri) || typeof docOrUri === 'string' || (docOrUri && docOrUri.scheme && !docOrUri.getText) ? await this.openTextDocument(docOrUri) : docOrUri;
    const opts = columnOrOptions && typeof columnOrOptions === 'object' ? columnOrOptions : {};
    const preserveFocus = opts.preserveFocus !== undefined ? !!opts.preserveFocus : !!preserveFocusArg;
    const sel = opts.selection ? toSelection(opts.selection) : undefined;
    if (doc.uri.scheme === 'file') {
      this.emit({ event: 'openFile', path: doc.uri.fsPath, selection: sel ? plainRange(sel) : undefined, preview: opts.preview, preserveFocus });
    } else {
      // Documento virtual: mostra como somente leitura no app.
      this.emit({ event: 'openVirtualDocument', uri: doc.uri.toString(), title: path.basename(doc.uri.path), languageId: doc.languageId, content: doc.getText() });
    }
    let editor = this._visibleEditors.find((e) => e.document === doc);
    if (!editor) editor = new TextEditor(doc, sel, typeof columnOrOptions === 'number' ? columnOrOptions : opts.viewColumn || 1, this);
    else if (sel) editor._acceptSelections([sel]);
    if (!preserveFocus || !this._activeEditor) this._setActiveEditor(editor);
    return editor;
  }

  // ---- edições (TextEditor.edit / workspace.applyEdit)
  /**
   * Aplica edições num documento. Arquivo aberto/abrível no app → o app aplica
   * no modelo do Monaco (com undo, sem gravar no disco). Sem app → disco.
   */
  async applyTextEdits(doc, edits, opts = {}) {
    const r = await this._applyEditsBatch([{ uri: doc.uri, edits }], opts);
    return r;
  }

  async _applyEditsBatch(batch, opts = {}) {
    const appEdits = [];
    for (const { uri, edits } of batch) {
      const doc = this.documents.get(uri.toString()) || (await this.openTextDocument(uri));
      if (uri.scheme === 'file' && this.appConnected) {
        appEdits.push({ path: uri.fsPath, edits: edits.map((e) => ({ range: plainRange(toRange(e.range)), text: e.text !== undefined ? e.text : e.newText })) });
        continue;
      }
      // Documento virtual ou sem app: aplica aqui (de trás para frente).
      let text = doc.getText();
      const sorted = edits
        .map((e) => ({ s: doc.offsetAt(toRange(e.range).start), e: doc.offsetAt(toRange(e.range).end), t: e.text !== undefined ? e.text : e.newText }))
        .sort((a, b) => b.s - a.s);
      for (const e of sorted) text = text.slice(0, e.s) + e.t + text.slice(e.e);
      if (uri.scheme === 'file') {
        await fs.promises.writeFile(uri.fsPath, text);
        this.emit({ event: 'filesChanged', paths: [uri.fsPath] });
      } else if (this.fsProviders.has(uri.scheme) && !this.fsProviders.get(uri.scheme).options.isReadonly) {
        try {
          await this.fsProviders.get(uri.scheme).provider.writeFile(uri, Buffer.from(text), { create: true, overwrite: true });
        } catch {
          /* provider só leitura: o documento em memória basta */
        }
      }
      this._replaceText(doc, text);
      if (uri.scheme !== 'file') {
        doc.isDirty = true;
        this._emitDiffContent(uri, text);
      }
    }
    if (!appEdits.length) return true;
    const r = await this.request('applyEdit', { edits: appEdits, undoStopBefore: opts.undoStopBefore !== false, undoStopAfter: opts.undoStopAfter !== false });
    if (!r || !r.applied) return false;
    // O app devolve o texto final dos modelos: garante que o documento já está
    // atualizado quando a promise resolve (como no VS Code).
    for (const d of r.docs || []) {
      const doc = this._docForPath(d.path);
      if (doc) {
        doc._appOwned = true;
        doc.isDirty = d.dirty !== false;
        if (typeof d.text === 'string' && (d.version === undefined || d.version > doc.version || doc.getText() !== d.text)) this._replaceText(doc, d.text, d.version);
      }
    }
    return true;
  }

  async applyWorkspaceEdit(edit) {
    const touched = [];
    try {
      for (const op of edit._edits || []) {
        if (op.kind === 'create') {
          await fs.promises.mkdir(path.dirname(op.uri.fsPath), { recursive: true });
          const exists = fs.existsSync(op.uri.fsPath);
          if (exists && !(op.options && (op.options.overwrite || op.options.ignoreIfExists))) throw new Error(`Arquivo já existe: ${op.uri.fsPath}`);
          if (!(exists && op.options && op.options.ignoreIfExists)) await fs.promises.writeFile(op.uri.fsPath, op.options && op.options.contents ? Buffer.from(op.options.contents) : '');
          touched.push(op.uri.fsPath);
          this.events.createFiles.fire({ files: [op.uri] });
        } else if (op.kind === 'delete') {
          await fs.promises.rm(op.uri.fsPath, { recursive: !!(op.options && op.options.recursive), force: !!(op.options && op.options.ignoreIfNotExists) });
          touched.push(op.uri.fsPath);
          this.events.deleteFiles.fire({ files: [op.uri] });
        } else if (op.kind === 'rename') {
          if (fs.existsSync(op.newUri.fsPath) && !(op.options && op.options.overwrite)) {
            if (op.options && op.options.ignoreIfExists) continue;
            throw new Error(`Destino já existe: ${op.newUri.fsPath}`);
          }
          await fs.promises.mkdir(path.dirname(op.newUri.fsPath), { recursive: true });
          await fs.promises.rename(op.uri.fsPath, op.newUri.fsPath);
          touched.push(op.uri.fsPath, op.newUri.fsPath);
          this.events.renameFiles.fire({ files: [{ oldUri: op.uri, newUri: op.newUri }] });
        }
      }
      const batch = edit.entries().map(([uri, edits]) => ({ uri, edits }));
      if (batch.length && !(await this._applyEditsBatch(batch))) return false;
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

  /** Watcher viu mudança num arquivo: documentos não espelhados seguem o disco. */
  async _onDiskChange(kind, abs) {
    const doc = this._docForPath(abs);
    if (!doc || doc._appOwned || doc.isDirty || kind === 'delete') return;
    try {
      this._replaceText(doc, await fs.promises.readFile(abs, 'utf8'));
    } catch {
      /* sumiu */
    }
  }

  // ------------------------------------------------------ editor (do app)
  get activeTextEditor() {
    return this._activeEditor;
  }
  get visibleTextEditors() {
    return this._visibleEditors;
  }

  _setActiveEditor(editor) {
    if (this._activeEditor === editor) return;
    this._activeEditor = editor;
    if (editor && !this._visibleEditors.includes(editor)) this._setVisibleEditors([editor, ...this._visibleEditors.filter((e) => e.document !== editor.document)]);
    this.events.activeTextEditor.fire(editor);
  }

  _setVisibleEditors(list) {
    const same = list.length === this._visibleEditors.length && list.every((e, i) => e === this._visibleEditors[i]);
    this._visibleEditors = list;
    if (!same) this.events.visibleTextEditors.fire(list);
  }

  _editorFor(doc, viewColumn) {
    return this._visibleEditors.find((e) => e.document === doc) || new TextEditor(doc, undefined, viewColumn || 1, this);
  }

  /**
   * Estado dos editores publicado pelo app (eventos do Monaco, sem polling):
   * { active: {path, selections, visibleRanges?, viewColumn?} | null,
   *   visible: [{path, selections?, viewColumn?}], tabs: [{path, dirty, active, preview?}] }
   * Documentos citados já foram enviados por `documentOpened`.
   */
  editorsChanged(state) {
    const visible = [];
    for (const v of state.visible || []) {
      const doc = this._docForPath(v.path);
      if (!doc) continue;
      const ed = this._editorFor(doc, v.viewColumn);
      if (v.selections) ed._acceptSelections(v.selections.map(toSelection));
      visible.push(ed);
    }
    let active;
    if (state.active && state.active.path) {
      const doc = this._docForPath(state.active.path);
      if (doc) {
        active = visible.find((e) => e.document === doc) || this._editorFor(doc, state.active.viewColumn);
        if (state.active.selections) active._acceptSelections(state.active.selections.map(toSelection));
        if (!visible.includes(active)) visible.unshift(active);
      }
    }
    // Editores dos diffs abertos continuam visíveis (o Claude depende disso).
    for (const d of this._diffTabs) for (const e of d.editors) if (!visible.includes(e)) visible.push(e);
    if (Array.isArray(state.tabs)) this._appTabs = state.tabs.filter((t) => t && typeof t.path === 'string');
    // O usuário voltou para um arquivo: o diff/painel deixa de ser a aba ativa.
    if (active) this._activeDiff = null;
    if (active && this._activePanel) {
      const e = this.webviews.get(this._activePanel);
      if (!e || !e.panel || !e.panel.active) this._activePanel = null;
    }
    this._setVisibleEditors(visible);
    if (active !== this._activeEditor) {
      this._activeEditor = active;
      this.events.activeTextEditor.fire(active);
      if (active) this.events.textEditorSelection.fire({ textEditor: active, selections: active.selections, kind: undefined });
    }
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
  }

  selectionChanged({ path: p, selections, kind }) {
    const doc = this._docForPath(p);
    const ed = doc && this._visibleEditors.find((e) => e.document === doc);
    if (!ed) return;
    const sels = (selections || []).map(toSelection);
    if (sels.length === ed.selections.length && sels.every((s, i) => s.isEqual(ed.selections[i]))) return;
    ed._acceptSelections(sels);
    const k = kind === 'keyboard' ? types.TextEditorSelectionChangeKind.Keyboard : kind === 'mouse' ? types.TextEditorSelectionChangeKind.Mouse : kind === 'command' ? types.TextEditorSelectionChangeKind.Command : undefined;
    this.events.textEditorSelection.fire({ textEditor: ed, selections: sels, kind: k });
  }

  visibleRangesChanged({ path: p, ranges }) {
    const doc = this._docForPath(p);
    const ed = doc && this._visibleEditors.find((e) => e.document === doc);
    if (!ed || !Array.isArray(ranges)) return;
    ed.visibleRanges = ranges.map(toRange);
    this.events.textEditorVisibleRanges.fire({ textEditor: ed, visibleRanges: ed.visibleRanges });
  }

  // ---- extensão → editor do app
  setEditorSelections(editor, selections) {
    if (editor.document.uri.scheme !== 'file') return;
    this.emit({ event: 'setSelection', path: editor.document.uri.fsPath, selections: selections.map((s) => ({ anchor: { line: s.anchor.line, character: s.anchor.character }, active: { line: s.active.line, character: s.active.character } })) });
    this.events.textEditorSelection.fire({ textEditor: editor, selections, kind: types.TextEditorSelectionChangeKind.Command });
  }

  revealRange(editor, range, revealType) {
    if (editor.document.uri.scheme !== 'file') return;
    this.emit({ event: 'revealRange', path: editor.document.uri.fsPath, range: plainRange(range), revealType: revealType || 0 });
  }

  createDecorationType(ext, options) {
    const key = `d${crypto.randomBytes(6).toString('hex')}`;
    const icon = this._decorationIcon(ext);
    const opts = sanitizeDecorationOptions(options || {}, icon);
    this.decorationTypes.set(key, { ext, options: opts, icon });
    this.emit({ event: 'decorationType', key, options: opts });
    return {
      key,
      dispose: () => {
        if (this.decorationTypes.delete(key)) this.emit({ event: 'decorationTypeDisposed', key });
      },
    };
  }

  /** Resolver de ícones de decoração da extensão (raízes: pasta dela + workspace). */
  _decorationIcon(ext) {
    this._iconCache = this._iconCache || new Map();
    return (v) => iconDataUri(v, [ext.extensionPath, ...this.workspaceFolders.map((f) => f.uri.fsPath)], this._iconCache);
  }

  setDecorations(editor, type, rangesOrOptions) {
    if (!type || !this.decorationTypes.has(type.key)) return;
    const uri = editor.document.uri;
    // Documento virtual só se for um lado de um diff aberto (a revisão do app o mostra).
    const diff = uri.scheme === 'file' ? null : this._diffTabs.find((d) => d.right.toString() === uri.toString() || d.left.toString() === uri.toString());
    if (uri.scheme !== 'file' && !diff) return;
    const items = (rangesOrOptions || []).slice(0, 5000).map((r) => {
      if (r instanceof Range || (r && r.start && r.end && !r.range)) return { range: plainRange(toRange(r)) };
      const o = { range: plainRange(toRange(r.range)) };
      if (r.hoverMessage) o.hoverMessage = markdownText(r.hoverMessage);
      if (r.renderOptions) o.renderOptions = sanitizeDecorationOptions(r.renderOptions, this.decorationTypes.get(type.key).icon);
      return o;
    });
    if (diff) this.emit({ event: 'decorations', uri: uri.toString(), diffId: diff.id, key: type.key, items });
    else this.emit({ event: 'decorations', path: uri.fsPath, key: type.key, items });
  }

  // ---------------------------------------------------------- diagnósticos
  /** Markers do Monaco publicados pelo app: [{path, diagnostics:[{range,message,severity,source,code}]}]. */
  setDiagnostics(entries) {
    const uris = [];
    for (const e of entries || []) {
      if (!e || typeof e.path !== 'string') continue;
      const uri = Uri.file(path.resolve(e.path));
      const list = (e.diagnostics || []).map((d) => {
        const diag = new types.Diagnostic(toRange(d.range), String(d.message || ''), typeof d.severity === 'number' ? d.severity : SEVERITY[String(d.severity).toLowerCase()] ?? 0);
        if (d.source) diag.source = String(d.source);
        if (d.code !== undefined) diag.code = d.code;
        return diag;
      });
      if (list.length) this.diagnostics.set(uri.toString(), list);
      else this.diagnostics.delete(uri.toString());
      uris.push(uri);
    }
    if (uris.length) this.events.diagnostics.fire({ uris });
  }

  /** getDiagnostics: markers do app + coleções criadas pelas extensões. */
  getDiagnostics(uri) {
    const merged = new Map(this.diagnostics);
    for (const coll of this.diagnosticCollections) {
      coll.forEach((u, list) => {
        const k = u.toString();
        merged.set(k, [...(merged.get(k) || []), ...list]);
      });
    }
    if (uri) return merged.get(toUri(uri).toString()) || [];
    return [...merged.entries()].map(([k, v]) => [Uri.parse(k), v]);
  }

  /** Coleção de diagnósticos de uma extensão mudou: espelha como markers no app. */
  publishCollection(name, uri, list) {
    if (!uri || uri.scheme !== 'file') return;
    this.emit({
      event: 'extDiagnostics',
      owner: `ext:${name}`,
      path: uri.fsPath,
      diagnostics: (list || []).slice(0, 1000).map((d) => ({ range: plainRange(d.range), message: String(d.message), severity: d.severity, source: d.source })),
    });
    this.events.diagnostics.fire({ uris: [uri] });
  }

  // ---------------------------------------------------------------- diffs
  _diffById(id) {
    return id ? this._diffTabs.find((d) => d.id === id) : undefined;
  }

  async openDiff(left, right, title, opts = {}) {
    const [leftDoc, rightDoc] = await Promise.all([this.openTextDocument(left).catch(() => null), this.openTextDocument(right).catch(() => null)]);
    const leftContent = leftDoc ? leftDoc.getText() : '';
    const rightContent = rightDoc ? rightDoc.getText() : '';
    // Mesmo par já aberto: só reativa.
    let diff = this._diffTabs.find((d) => d.left.toString() === left.toString() && d.right.toString() === right.toString());
    const ext = this._ownerOfScheme(right.scheme) || this._ownerOfScheme(left.scheme);
    if (!diff) {
      const editors = [leftDoc, rightDoc].filter(Boolean).map((d) => new TextEditor(d, undefined, 1, this));
      diff = { id: `diff${this._nextDiff++}`, left, right, title: title || `${path.basename(left.path)} ↔ ${path.basename(right.path)}`, ext, editors, openedAt: Date.now() };
      this._diffTabs.push(diff);
    }
    this._activeDiff = diff.id;
    const filePath = left.scheme === 'file' ? left.fsPath : right.scheme === 'file' ? right.fsPath : right.path;
    const isNewFile = left.scheme === 'file' ? !fs.existsSync(left.fsPath) : !leftContent;
    const reviewable = !!(ext && ext.contributions.editorTitle.some((m) => /accept/i.test(m.command)));
    this.emit({
      event: 'diff',
      diffId: diff.id,
      title: diff.title,
      extensionId: ext ? ext.id : undefined,
      extensionName: ext ? displayNameOf(ext.packageJSON) : undefined,
      filePath,
      isNewFile,
      reviewable,
      left: { uri: left.toString(), path: left.scheme === 'file' ? left.fsPath : undefined, content: leftContent },
      right: { uri: right.toString(), path: right.scheme === 'file' ? right.fsPath : undefined, content: rightContent, readonly: !!(this.fsProviders.get(right.scheme) && this.fsProviders.get(right.scheme).options.isReadonly) },
      preview: opts && opts.preview,
      preserveFocus: !!(opts && opts.preserveFocus),
    });
    // Diff = aba TabInputTextDiff ativa + dois editores visíveis (o Claude Code
    // liga `claude-code.viewingProposedDiff` pelos visibleTextEditors).
    this._setVisibleEditors([...this._visibleEditors.filter((e) => !diff.editors.includes(e)), ...diff.editors]);
    if (!(opts && opts.preserveFocus) && diff.editors.length) {
      const modified = diff.editors[diff.editors.length - 1];
      this._activeEditor = modified;
      this.events.activeTextEditor.fire(modified);
    }
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
    return undefined;
  }

  _ownerOfScheme(scheme) {
    const reg = this.fsProviders.get(scheme) || this.contentProviders.get(scheme);
    return reg ? reg.ext : undefined;
  }

  _closeDiff(diff, fromApp) {
    if (!this._diffTabs.includes(diff)) return;
    this._diffTabs = this._diffTabs.filter((d) => d !== diff);
    if (this._activeDiff === diff.id) this._activeDiff = null;
    this._setVisibleEditors(this._visibleEditors.filter((e) => !diff.editors.includes(e)));
    if (this._activeEditor && diff.editors.includes(this._activeEditor)) {
      this._activeEditor = this._visibleEditors.find((e) => e.document.uri.scheme === 'file');
      this.events.activeTextEditor.fire(this._activeEditor);
    }
    if (!fromApp) this.emit({ event: 'closeDiff', diffId: diff.id, left: diff.left.toString(), right: diff.right.toString() });
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
  }

  /**
   * Aceitar/Rejeitar no overlay do app, com a semântica do VS Code:
   * 1. comando do menu `editor/title` da extensão cujo `when` vale (ex.:
   *    `claude-code.acceptProposedDiff` com `claude-code.viewingProposedDiff`);
   * 2. aceitar sem comando aplicável = "salvar" o lado direito
   *    (onWillSave/onDidSave — o Claude aceita assim com files.autoSave off);
   *    rejeitar = fechar a aba do diff.
   * `text` = conteúdo final do lado direito (o usuário pode editar).
   */
  async diffAction(diffId, action, text) {
    const diff = this._diffById(diffId);
    if (!diff) return { ok: false, error: 'diff não está mais aberto' };
    // A extensão só passa a escutar aceitar/rejeitar depois de ver a aba
    // (o Claude Code confere a cada 100 ms): um clique instantâneo se perderia.
    const settle = DIFF_SETTLE_MS - (Date.now() - diff.openedAt);
    if (settle > 0) await new Promise((r) => setTimeout(r, settle));
    const rightDoc = this.documents.get(diff.right.toString());
    if (typeof text === 'string' && rightDoc && text !== rightDoc.getText()) {
      this._replaceText(rightDoc, text);
      rightDoc.isDirty = true;
    }
    // A aba do diff passa a ser a ativa (os comandos leem activeTab).
    this._activeDiff = diff.id;
    this.events.tabs.fire({ opened: [], closed: [], changed: [] });
    const want = action === 'accept' ? /accept/i : /reject/i;
    const ext = diff.ext;
    const candidates = ext ? ext.contributions.editorTitle.filter((m) => want.test(m.command)) : [];
    const match = candidates.find((m) => this.commands.has(m.command) && this.evaluateWhen(m.when));
    if (match) {
      await this.executeCommand(match.command);
      return { ok: true, via: match.command };
    }
    if (action === 'accept') {
      if (rightDoc && this.config.lookup('files.autoSave') === 'off') {
        await this.saveDocument(rightDoc);
        return { ok: true, via: 'save' };
      }
      const any = candidates.find((m) => this.commands.has(m.command));
      if (any) {
        await this.executeCommand(any.command);
        return { ok: true, via: any.command };
      }
      return { ok: false, error: 'a extensão não oferece um comando para aceitar este diff' };
    }
    this._closeDiff(diff, false);
    return { ok: true, via: 'close' };
  }

  /** Extensão editou o lado direito de um diff aberto (ex.: rejeitar um hunk): o app atualiza a revisão. */
  _emitDiffContent(uri, text) {
    for (const d of this._diffTabs) {
      if (d.right.toString() === uri.toString()) this.emit({ event: 'diffContent', diffId: d.id, side: 'right', text });
    }
  }

  /**
   * Usuário editou o lado direito na revisão do app: o documento do host segue
   * (onDidChangeTextDocument), como no VS Code — o Claude recalcula os hunks.
   */
  diffEdited(diffId, text) {
    const diff = this._diffById(diffId);
    if (!diff) return false;
    const doc = this.documents.get(diff.right.toString());
    if (!doc || doc.getText() === text) return false;
    this._replaceText(doc, text);
    doc.isDirty = true;
    return true;
  }

  /** Usuário fechou o diff no app (Esc/fechar): como fechar a aba no VS Code. */
  diffClosed(diffId) {
    const diff = this._diffById(diffId);
    if (diff) this._closeDiff(diff, true);
  }

  get tabGroups() {
    const host = this;
    const tabs = (this._appTabs || []).map((t) => ({
      label: path.basename(t.path),
      input: new types.TabInputText(Uri.file(t.path)),
      isActive: !host._activeDiff && !!t.active,
      isDirty: !!t.dirty,
      isPinned: false,
      isPreview: !!t.preview,
    }));
    for (const d of this._diffTabs) {
      tabs.push({ label: d.title || 'diff', input: new types.TabInputTextDiff(d.left, d.right), isActive: host._activeDiff === d.id, isDirty: false, isPinned: false, isPreview: false, _diffId: d.id });
    }
    // Painéis de webview = abas da grade de editores (TabInputWebview / TabInputCustom).
    for (const entry of this.webviews.values()) {
      if (!entry.panel) continue;
      const active = !host._activeDiff && host._activePanel === entry.webview.handle;
      const input = entry.customUri ? new types.TabInputCustom(entry.customUri, entry.webview.viewType) : new types.TabInputWebview(entry.webview.viewType);
      tabs.push({ label: entry.panel.title || entry.webview.viewType, input, isActive: active, isDirty: false, isPinned: false, isPreview: false, _webviewHandle: entry.webview.handle });
    }
    if (this._activePanel && !this._activeDiff) for (const t of tabs) if (t.input instanceof types.TabInputText) t.isActive = false;
    const group = { isActive: true, viewColumn: 1, tabs, activeTab: tabs.find((t) => t.isActive) };
    for (const t of tabs) t.group = group;
    return {
      all: [group],
      activeTabGroup: group,
      onDidChangeTabs: this.events.tabs.event,
      onDidChangeTabGroups: this.events.tabGroups.event,
      close: async (tabOrTabs) => {
        const list = (Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs]).filter(Boolean);
        for (const t of list) {
          if (t.input instanceof types.TabInputTextDiff) {
            const d = host._diffTabs.find((x) => x.left.toString() === t.input.original.toString() && x.right.toString() === t.input.modified.toString());
            if (d) host._closeDiff(d, false);
          } else if (t._webviewHandle) {
            const entry = host.webviews.get(t._webviewHandle);
            if (entry && entry.panel) entry.panel.dispose();
          } else if (t.input instanceof types.TabInputText && t.input.uri.scheme === 'file') {
            host.emit({ event: 'closeEditor', path: t.input.uri.fsPath });
          } else if (t.group && Array.isArray(t.tabs)) {
            // Fechar um grupo inteiro.
            for (const x of t.tabs) if (x.input instanceof types.TabInputTextDiff && x._diffId) host.diffClosed(x._diffId);
          }
        }
        host.events.tabs.fire({ opened: [], closed: list, changed: [] });
        return true;
      },
    };
  }

  // ---------------------------------------------------------- terminal
  createTerminal(ext, options) {
    const term = new Terminal(this, { ...options, _extensionId: ext.id }, [ext.envVars]);
    this.terminals.push(term);
    this.events.openTerminal.fire(term);
    if (!this.appConnected) term._onOpened(undefined);
    return term;
  }

  _terminal(id) {
    return this.terminals.find((t) => t.id === id);
  }

  _setActiveTerminal(term) {
    if (this._activeTerminal === term) return;
    this._activeTerminal = term;
    this.events.activeTerminal.fire(term);
  }

  get activeTerminal() {
    return this._activeTerminal;
  }

  /** App criou o PTY do terminal. */
  terminalOpened(id, pid, shellIntegration, dims) {
    const t = this._terminal(id);
    if (t) t._onOpened(pid, !!shellIntegration, dims);
  }

  /** Teclado/resize da aba de um pseudoterminal (pty da extensão). */
  terminalInput(id, data) {
    const t = this._terminal(id);
    if (t) t._pseudoInput(data);
  }

  terminalResize(id, cols, rows) {
    const t = this._terminal(id);
    if (t) t._pseudoResize(cols, rows);
  }

  /** Sequência OSC 633 do PTY interpretada pelo app (shell integration real). */
  terminalShell(p) {
    const t = this._terminal(p.id);
    if (t) t._shellEvent(p);
  }

  /** PTY encerrou (processo saiu ou o usuário fechou a aba). */
  terminalClosed(id, exitCode, reason) {
    const t = this._terminal(id);
    if (!t) return;
    this.terminals = this.terminals.filter((x) => x !== t);
    t.exitStatus = { code: typeof exitCode === 'number' ? exitCode : undefined, reason: reason || (typeof exitCode === 'number' ? types.TerminalExitReason.Process : types.TerminalExitReason.User) };
    t._onClosed();
    t._disposed = true;
    if (this._activeTerminal === t) this._setActiveTerminal(this.terminals[this.terminals.length - 1]);
    this.events.closeTerminal.fire(t);
  }

  // ------------------------------------------------------------- CodeLens
  /** `languages.registerCodeLensProvider` → lentes no Monaco (o app pede por documento). */
  registerCodeLensProvider(ext, selector, provider) {
    const reg = { ext, selector, provider };
    this.codeLensProviders = this.codeLensProviders || new Set();
    this.codeLensProviders.add(reg);
    const sub = provider && typeof provider.onDidChangeCodeLenses === 'function' ? provider.onDidChangeCodeLenses(() => this.emit({ event: 'codeLensChanged' })) : null;
    this.emit({ event: 'codeLensProviders', count: this.codeLensProviders.size });
    return new Disposable(() => {
      this.codeLensProviders.delete(reg);
      if (sub) sub.dispose();
      this.emit({ event: 'codeLensProviders', count: this.codeLensProviders.size });
    });
  }

  async provideCodeLenses(p) {
    const doc = this._docForPath(p) || (await this.openTextDocument(Uri.file(path.resolve(p))).catch(() => null));
    if (!doc || !this.codeLensProviders) return [];
    this._lensCommands = this._lensCommands || new Map();
    // Comandos das lentes anteriores deste arquivo saem (o app pede de novo a cada mudança).
    for (const [id, c] of this._lensCommands) if (c.path === p) this._lensCommands.delete(id);
    const out = [];
    for (const reg of this.codeLensProviders) {
      if (!matchSelector(reg.selector, doc)) continue;
      let lenses = [];
      try {
        const cts = new types.CancellationTokenSource();
        lenses = (await reg.provider.provideCodeLenses(doc, cts.token)) || [];
        for (let i = 0; i < lenses.length; i++) {
          if (!lenses[i].command && typeof reg.provider.resolveCodeLens === 'function') lenses[i] = (await reg.provider.resolveCodeLens(lenses[i], cts.token)) || lenses[i];
        }
      } catch (err) {
        this.log(`provideCodeLenses (${reg.ext.id}) falhou:`, err);
        continue;
      }
      for (const lens of lenses.slice(0, 500)) {
        if (!lens || !lens.range || !lens.command || !lens.command.title) continue;
        const id = `lens${(this._nextLens = (this._nextLens || 0) + 1)}`;
        this._lensCommands.set(id, { path: p, command: lens.command.command, args: lens.command.arguments || [] });
        out.push({ id, range: plainRange(toRange(lens.range)), title: String(lens.command.title), tooltip: lens.command.tooltip ? String(lens.command.tooltip) : undefined, hasCommand: !!lens.command.command });
      }
    }
    return out;
  }

  executeCodeLens(id) {
    const c = this._lensCommands && this._lensCommands.get(id);
    if (!c || !c.command) return undefined;
    return this.executeCommand(c.command, ...c.args);
  }

  // ------------------------------------------------------------ URI handler
  /**
   * Deep link `fluent-coder://<publisher.nome>/…` (ou `vscode://`, ex.:
   * openExternal da própria extensão). Ativa a extensão dona da autoridade se
   * preciso (onUri) e chama o handler registrado.
   */
  async handleUri(uriOrString) {
    const uri = typeof uriOrString === 'string' ? Uri.parse(uriOrString) : uriOrString;
    const id = String(uri.authority || '').toLowerCase();
    const ext = this.extensions.get(id);
    if (ext && !ext.isActive) await this.activate(ext.id);
    const handler = this.uriHandlers.get(id);
    if (!handler) {
      this.log(`handleUri: nenhuma extensão trata ${uri.toString(true)}`);
      return false;
    }
    try {
      await handler.handleUri(uri);
      return true;
    } catch (err) {
      this.log('handleUri falhou:', err);
      return false;
    }
  }

  // ------------------------------------------------------------ saída (Output)
  /** Espelha os output channels das extensões na aba "Saída" do app (em lote). */
  outputAppend(channel, text) {
    if (!this.appConnected) return;
    const cur = this._outputBuf.get(channel) || '';
    // Teto por janela de envio: canais muito verbosos não afogam o protocolo.
    if (cur.length > 256 * 1024) return;
    this._outputBuf.set(channel, cur + text);
    if (!this._outputTimer) this._outputTimer = setTimeout(() => this._flushOutput(), 250);
  }

  _flushOutput() {
    clearTimeout(this._outputTimer);
    this._outputTimer = null;
    for (const [channel, text] of this._outputBuf) if (text) this.emit({ event: 'output', channel, text });
    this._outputBuf.clear();
  }
}

/** Linguagens conhecidas antes de o app mandar o registro real do Monaco. */
const DEFAULT_LANGUAGE_IDS = ['plaintext', 'typescript', 'javascript', 'csharp', 'razor', 'json', 'markdown'];

/**
 * Pontuação de um `DocumentSelector` para um documento — o algoritmo de
 * `languages.match` do VS Code (`languageSelector.ts`): 10 = casamento exato
 * (linguagem, esquema ou padrão), 5 = curinga `*`, 0 = não casa. Lista = maior
 * pontuação. Documentos daqui são sempre "sincronizados"; `notebookType` não
 * casa (sem editor de notebook).
 */
function scoreSelector(selector, doc) {
  if (!selector || !doc) return 0;
  if (Array.isArray(selector)) {
    let ret = 0;
    for (const s of selector) {
      const v = scoreSelector(s, doc);
      if (v === 10) return 10;
      if (v > ret) ret = v;
    }
    return ret;
  }
  const languageId = doc.languageId;
  const uri = doc.uri;
  if (typeof selector === 'string') {
    if (selector === '*') return 5;
    return selector === languageId ? 10 : 0;
  }
  if (typeof selector !== 'object') return 0;
  const { language, scheme, pattern, notebookType } = selector;
  let ret = 0;
  if (scheme) {
    if (uri && scheme === uri.scheme) ret = 10;
    else if (scheme === '*') ret = 5;
    else return 0;
  }
  if (language) {
    if (language === languageId) ret = 10;
    else if (language === '*') ret = Math.max(ret, 5);
    else return 0;
  }
  if (notebookType) return 0;
  if (pattern) {
    const { globToRegExp } = require('./shim/api');
    const fsPath = uri && uri.fsPath ? uri.fsPath.split(path.sep).join('/') : '';
    const pat = typeof pattern === 'string' ? pattern : pattern.pattern;
    const base = typeof pattern === 'object' && pattern.baseUri ? pattern.baseUri.fsPath : typeof pattern === 'object' && pattern.base ? pattern.base : null;
    const target = base ? path.relative(base, uri.fsPath).split(path.sep).join('/') : fsPath;
    if (typeof pat !== 'string' || !(target === pat || globToRegExp(pat).test(target))) return 0;
    ret = 10;
  }
  return ret;
}

/** `DocumentSelector` (string de linguagem, filtro ou lista) casa com o documento? */
function matchSelector(selector, doc) {
  if (!selector) return false;
  if (Array.isArray(selector)) return selector.some((s) => matchSelector(s, doc));
  if (typeof selector === 'string') return selector === '*' || selector === doc.languageId;
  if (selector.language && selector.language !== '*' && selector.language !== doc.languageId) return false;
  if (selector.scheme && selector.scheme !== '*' && selector.scheme !== doc.uri.scheme) return false;
  if (selector.pattern) {
    const pat = typeof selector.pattern === 'string' ? selector.pattern : selector.pattern.pattern;
    const base = typeof selector.pattern === 'object' && selector.pattern.baseUri ? selector.pattern.baseUri.fsPath : null;
    const { globToRegExp } = require('./shim/api');
    const target = base ? path.relative(base, doc.uri.fsPath).split(path.sep).join('/') : doc.uri.fsPath.split(path.sep).join('/');
    if (!globToRegExp(pat).test(target) && !globToRegExp(`**/${pat}`).test(target)) return false;
  }
  return true;
}

/** Só propriedades de estilo conhecidas e valores sem `;{}<` (viram CSS no app). */
/** Teto do estado (setState) persistido por painel e de painéis por sessão. */
const MAX_PERSISTED_STATE = 256 * 1024;
const MAX_PERSISTED_PANELS = 32;
const PANELS_DEBOUNCE_MS = 250;

/**
 * Só as opções booleanas do webview/painel. `localResourceRoots` NÃO é
 * persistido nem restaurado (a extensão o define de novo no deserialize; o
 * padrão já cobre a pasta da extensão e o workspace).
 */
function pickPanelOptions(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of ['enableScripts', 'enableForms', 'enableCommandUris', 'enableFindWidget', 'retainContextWhenHidden']) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

/**
 * Só propriedades de estilo conhecidas e valores sem `;{}<` (viram CSS no
 * app). Ícones (`gutterIconPath`, `contentIconPath`) passam por `icon(v)`,
 * que devolve um `data:` URI de imagem pequena de uma raiz permitida — sem
 * resolver, são descartados.
 */
function sanitizeDecorationOptions(o, icon) {
  const ALLOWED = ['backgroundColor', 'border', 'borderColor', 'borderRadius', 'borderStyle', 'borderWidth', 'color', 'fontStyle', 'fontWeight', 'opacity', 'outline', 'outlineColor', 'outlineStyle', 'outlineWidth', 'textDecoration', 'cursor', 'letterSpacing', 'isWholeLine', 'overviewRulerColor', 'overviewRulerLane', 'rangeBehavior', 'gutterIconSize'];
  const out = {};
  const clean = (v) => {
    if (v && typeof v === 'object' && typeof v.id === 'string') return { themeColor: v.id };
    if (typeof v === 'string' && !/[;{}<>\\]/.test(v) && v.length < 200) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    return undefined;
  };
  for (const k of ALLOWED) if (o[k] !== undefined && clean(o[k]) !== undefined) out[k] = clean(o[k]);
  if (o.gutterIconPath && typeof icon === 'function') {
    const data = icon(o.gutterIconPath);
    if (data) out.gutterIconPath = { dataUri: data };
  }
  for (const side of ['before', 'after']) {
    if (o[side] && typeof o[side] === 'object') {
      const s = {};
      for (const k of ['contentText', 'color', 'backgroundColor', 'fontStyle', 'fontWeight', 'margin', 'textDecoration', 'border', 'borderColor', 'width', 'height']) {
        if (o[side][k] !== undefined) {
          const c = k === 'contentText' ? (typeof o[side][k] === 'string' ? o[side][k].slice(0, 500) : undefined) : clean(o[side][k]);
          if (c !== undefined) s[k] = c;
        }
      }
      if (o[side].contentIconPath && typeof icon === 'function') {
        const data = icon(o[side].contentIconPath);
        if (data) s.contentIconPath = { dataUri: data };
      }
      out[side] = s;
    }
  }
  for (const theme of ['light', 'dark']) if (o[theme] && typeof o[theme] === 'object') out[theme] = sanitizeDecorationOptions(o[theme], icon);
  return out;
}

const ICON_MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
/** Teto de um ícone de decoração embutido como data: URI. */
const MAX_ICON_BYTES = 64 * 1024;

/**
 * Ícone de decoração (Uri/caminho) → `data:` URI, só de dentro de `roots`
 * (pasta da extensão e do workspace, conferido no realpath), só imagens
 * conhecidas e ≤ 64 KB. Remoto (http) e o resto → undefined.
 */
function iconDataUri(v, roots, cache) {
  let fsPath;
  try {
    if (typeof v === 'string') fsPath = /^[a-z][\w+.-]*:\/\//i.test(v) ? (v.startsWith('file:') ? Uri.parse(v).fsPath : null) : v;
    else if (v && typeof v === 'object' && (v.scheme === 'file' || v.scheme === undefined) && typeof (v.fsPath || v.path) === 'string') fsPath = v.fsPath || v.path;
  } catch {
    return undefined;
  }
  if (!fsPath || fsPath.includes('\0')) return undefined;
  const mime = ICON_MIME[path.extname(fsPath).toLowerCase()];
  if (!mime) return undefined;
  if (cache && cache.has(fsPath)) return cache.get(fsPath);
  let data;
  try {
    const real = fs.realpathSync(path.resolve(fsPath));
    const inside = roots.some((r) => {
      try {
        const rr = fs.realpathSync(r);
        return real === rr || real.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
      } catch {
        return false;
      }
    });
    const st = inside ? fs.statSync(real) : null;
    if (st && st.isFile() && st.size <= MAX_ICON_BYTES) data = `data:${mime};base64,${fs.readFileSync(real).toString('base64')}`;
  } catch {
    data = undefined;
  }
  if (cache) cache.set(fsPath, data);
  return data;
}

function markdownText(m) {
  if (Array.isArray(m)) return m.map(markdownText).join('\n\n');
  if (m && typeof m === 'object') return String(m.value || '');
  return String(m || '');
}

/** Argumentos serializáveis (Uris viram string) para eventos ao app. */
function safeArgs(args) {
  try {
    return JSON.parse(JSON.stringify(args, (_k, v) => (v instanceof Uri ? v.toString() : v)));
  } catch {
    return [];
  }
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

module.exports = { ExtensionHost, installRequireHook, sanitizeDecorationOptions, iconDataUri, matchSelector, scoreSelector, DEFAULT_LANGUAGE_IDS, pathKey, os, Range };
