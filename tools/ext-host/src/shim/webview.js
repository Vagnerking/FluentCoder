// Webview, WebviewView e WebviewPanel. O HTML que a extensão atribui em
// `webview.html` é servido pelo servidor HTTP local do host (ver server.js) e
// renderizado num <iframe> do Fluent Coder; mensagens trafegam
// extensão ↔ host ↔ (stdio/Tauri) ↔ app ↔ iframe.
'use strict';
const { EventEmitter, Uri, Disposable } = require('./types');

let nextHandle = 1;

/**
 * `bridge` é o lado do host: { resourceUrl(uri), cspSource, onHtml(webview),
 * post(handle, message) → boolean, allowRoots(roots) }.
 */
class Webview {
  constructor(bridge, { viewType, extension, kind }) {
    this.handle = `wv${nextHandle++}`;
    this.viewType = viewType;
    this.kind = kind; // 'view' | 'panel' | 'customEditor'
    this.extension = extension;
    this._bridge = bridge;
    this._html = '';
    this._htmlVersion = 0;
    this._options = { enableScripts: false };
    this._onDidReceiveMessage = new EventEmitter();
    this.onDidReceiveMessage = this._onDidReceiveMessage.event;
    this.state = undefined; // setState() do webview (relay), reentregue ao recarregar
  }
  get options() {
    return this._options;
  }
  set options(v) {
    this._options = { ...(v || {}) };
    if (Array.isArray(this._options.localResourceRoots)) this._bridge.allowRoots(this._options.localResourceRoots);
  }
  get html() {
    return this._html;
  }
  set html(v) {
    this._html = String(v ?? '');
    this._htmlVersion++;
    this._bridge.onHtml(this);
  }
  get cspSource() {
    return this._bridge.cspSource;
  }
  asWebviewUri(uri) {
    return Uri.parse(this._bridge.resourceUrl(uri));
  }
  postMessage(message) {
    return Promise.resolve(this._bridge.post(this.handle, message));
  }
  /** Chamado pelo host quando o iframe envia uma mensagem. */
  _receive(message) {
    this._onDidReceiveMessage.fire(message);
  }
}

class WebviewView {
  constructor(bridge, viewType, extension) {
    this.viewType = viewType;
    this.webview = new Webview(bridge, { viewType, extension, kind: 'view' });
    this.title = undefined;
    this.description = undefined;
    this.badge = undefined;
    this._visible = true;
    this._onDidChangeVisibility = new EventEmitter();
    this.onDidChangeVisibility = this._onDidChangeVisibility.event;
    this._onDidDispose = new EventEmitter();
    this.onDidDispose = this._onDidDispose.event;
    this._bridge = bridge;
  }
  get visible() {
    return this._visible;
  }
  _setVisible(v) {
    if (this._visible === v) return;
    this._visible = v;
    this._onDidChangeVisibility.fire();
  }
  show(preserveFocus) {
    this._bridge.reveal && this._bridge.reveal(this.webview.handle, !!preserveFocus);
  }
  _dispose() {
    this._onDidDispose.fire();
  }
}

class WebviewPanel {
  constructor(bridge, viewType, title, showOptions, options, extension) {
    this.viewType = viewType;
    this._title = title;
    this.webview = new Webview(bridge, { viewType, extension, kind: 'panel' });
    this.webview.options = options || {};
    this.options = options || {};
    // Coluna pedida (pode ser Active=-1/Beside=-2); o app devolve a real
    // (`webviewPanelState`) depois de abrir a aba na grade de editores.
    this.viewColumn = typeof showOptions === 'number' ? showOptions : (showOptions && showOptions.viewColumn) || 1;
    this._preserveFocus = !!(showOptions && typeof showOptions === 'object' && showOptions.preserveFocus);
    this.active = !this._preserveFocus;
    this.visible = true;
    this.iconPath = undefined;
    this._disposed = false;
    this._onDidDispose = new EventEmitter();
    this.onDidDispose = this._onDidDispose.event;
    this._onDidChangeViewState = new EventEmitter();
    this.onDidChangeViewState = this._onDidChangeViewState.event;
    this._bridge = bridge;
  }
  get title() {
    return this._title;
  }
  set title(v) {
    this._title = v;
    this._bridge.retitle && this._bridge.retitle(this.webview.handle, v);
  }
  reveal(viewColumn, preserveFocus) {
    this._bridge.reveal && this._bridge.reveal(this.webview.handle, !!preserveFocus, viewColumn);
  }
  /** Estado de visualização publicado pelo app (aba na grade de editores). */
  _setViewState({ active, visible, viewColumn }) {
    const next = { active: !!active, visible: !!visible, viewColumn: typeof viewColumn === 'number' && viewColumn > 0 ? viewColumn : this.viewColumn };
    if (next.active === this.active && next.visible === this.visible && next.viewColumn === this.viewColumn) return;
    Object.assign(this, next);
    this._onDidChangeViewState.fire({ webviewPanel: this });
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._bridge.disposeWebview && this._bridge.disposeWebview(this.webview.handle);
    this._onDidDispose.fire();
  }
}

module.exports = { Webview, WebviewView, WebviewPanel, Disposable };
