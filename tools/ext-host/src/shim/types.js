// Tipos de valor da API `vscode` (classes e enums) usados pelas extensões
// suportadas. Implementações mínimas mas fiéis ao contrato público do VS Code
// — só o que as extensões alvo realmente tocam (ver docs/research/vsix-api-surface.md).
'use strict';
const path = require('path');

// ---------------------------------------------------------------- Disposable
class Disposable {
  static from(...items) {
    return new Disposable(() => {
      for (const d of items) {
        try {
          d && typeof d.dispose === 'function' && d.dispose();
        } catch {
          /* ignora */
        }
      }
    });
  }
  constructor(callOnDispose) {
    this._fn = callOnDispose;
  }
  dispose() {
    if (this._fn) {
      const fn = this._fn;
      this._fn = undefined;
      fn();
    }
  }
}

// -------------------------------------------------------------- EventEmitter
class EventEmitter {
  constructor() {
    this._listeners = [];
    this._disposed = false;
    this.event = (listener, thisArgs, disposables) => {
      const entry = { fn: listener, thisArgs };
      if (!this._disposed) this._listeners.push(entry);
      const d = new Disposable(() => {
        const i = this._listeners.indexOf(entry);
        if (i >= 0) this._listeners.splice(i, 1);
      });
      if (Array.isArray(disposables)) disposables.push(d);
      else if (disposables && typeof disposables.add === 'function') disposables.add(d);
      return d;
    };
  }
  fire(data) {
    for (const { fn, thisArgs } of [...this._listeners]) {
      try {
        fn.call(thisArgs, data);
      } catch (err) {
        console.error('[ext-host] listener lançou:', err);
      }
    }
  }
  dispose() {
    this._disposed = true;
    this._listeners = [];
  }
}

// -------------------------------------------------------------------- Uri
const URI_RE = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

function encodePath(p) {
  // Igual ao VS Code: cada segmento é codificado (inclusive o `:` do drive).
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

class Uri {
  constructor(scheme, authority, p, query, fragment) {
    this.scheme = scheme || 'file';
    this.authority = authority || '';
    this.path = p || '';
    this.query = query || '';
    this.fragment = fragment || '';
    if (this.path && this.path[0] !== '/' && (this.scheme === 'file' || this.authority)) this.path = '/' + this.path;
  }
  static parse(value, _strict) {
    const m = URI_RE.exec(String(value));
    if (!m) return new Uri('file', '', '', '', '');
    const dec = (s) => {
      try {
        return decodeURIComponent(s || '');
      } catch {
        return s || '';
      }
    };
    return new Uri(m[2] || 'file', dec(m[4]), dec(m[5]), dec(m[7]), dec(m[9]));
  }
  static file(fsPath) {
    let p = String(fsPath);
    if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(p)) p = p.replace(/\\/g, '/');
    let authority = '';
    if (p.startsWith('//')) {
      const idx = p.indexOf('/', 2);
      authority = idx === -1 ? p.slice(2) : p.slice(2, idx);
      p = idx === -1 ? '/' : p.slice(idx);
    }
    if (p[0] !== '/') p = '/' + p;
    return new Uri('file', authority, p, '', '');
  }
  static joinPath(base, ...segments) {
    if (!base || !base.path && base.path !== '') throw new Error('[UriError]: cannot call joinPath on URI without path');
    const joined = path.posix.join(base.path || '/', ...segments);
    return base.with({ path: joined });
  }
  static from(c) {
    return new Uri(c.scheme, c.authority, c.path, c.query, c.fragment);
  }
  static isUri(v) {
    return v instanceof Uri || (!!v && typeof v.scheme === 'string' && typeof v.path === 'string' && typeof v.with === 'function');
  }
  static revive(v) {
    if (!v) return v;
    if (v instanceof Uri) return v;
    return new Uri(v.scheme, v.authority, v.path, v.query, v.fragment);
  }
  get fsPath() {
    let value;
    if (this.authority && this.path.length > 1 && this.scheme === 'file') value = `//${this.authority}${this.path}`;
    else if (/^\/[a-zA-Z]:/.test(this.path)) value = this.path[1].toLowerCase() + this.path.slice(2);
    else value = this.path;
    if (process.platform === 'win32') value = value.replace(/\//g, '\\');
    return value;
  }
  with(change) {
    if (!change) return this;
    const pick = (k) => (change[k] === undefined ? this[k] : change[k] === null ? '' : change[k]);
    return new Uri(pick('scheme'), pick('authority'), pick('path'), pick('query'), pick('fragment'));
  }
  toString(skipEncoding) {
    const enc = skipEncoding ? (s) => s : encodeURIComponent;
    let res = '';
    if (this.scheme) res += this.scheme + ':';
    if (this.authority || this.scheme === 'file') res += '//';
    if (this.authority) res += enc(this.authority).replace(/%3A/gi, ':').replace(/%40/g, '@');
    if (this.path) res += skipEncoding ? this.path : encodePath(this.path);
    if (this.query) res += '?' + (skipEncoding ? this.query : encodeURIComponent(this.query).replace(/%3D/g, '=').replace(/%26/g, '&'));
    if (this.fragment) res += '#' + enc(this.fragment);
    return res;
  }
  toJSON() {
    return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath, external: this.toString() };
  }
}

// ------------------------------------------------------- Position / Range
class Position {
  constructor(line, character) {
    this.line = Math.max(0, line | 0);
    this.character = Math.max(0, character | 0);
  }
  isBefore(o) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isBeforeOrEqual(o) {
    return this.isBefore(o) || this.isEqual(o);
  }
  isAfter(o) {
    return !this.isBeforeOrEqual(o);
  }
  isAfterOrEqual(o) {
    return !this.isBefore(o);
  }
  isEqual(o) {
    return this.line === o.line && this.character === o.character;
  }
  compareTo(o) {
    return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1;
  }
  translate(a, b) {
    if (typeof a === 'object' && a) return new Position(this.line + (a.lineDelta || 0), this.character + (a.characterDelta || 0));
    return new Position(this.line + (a || 0), this.character + (b || 0));
  }
  with(a, b) {
    if (typeof a === 'object' && a) return new Position(a.line ?? this.line, a.character ?? this.character);
    return new Position(a ?? this.line, b ?? this.character);
  }
}

class Range {
  constructor(a, b, c, d) {
    let start, end;
    if (typeof a === 'number') {
      start = new Position(a, b);
      end = new Position(c, d);
    } else {
      start = a;
      end = b;
    }
    if (end.isBefore && end.isBefore(start)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(x) {
    if (x instanceof Range) return this.contains(x.start) && this.contains(x.end);
    return x.isAfterOrEqual(this.start) && x.isBeforeOrEqual(this.end);
  }
  isEqual(o) {
    return this.start.isEqual(o.start) && this.end.isEqual(o.end);
  }
  intersection(o) {
    const start = this.start.isAfter(o.start) ? this.start : o.start;
    const end = this.end.isBefore(o.end) ? this.end : o.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(o) {
    return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end);
  }
  with(a, b) {
    if (a && !(a instanceof Position) && typeof a === 'object') return new Range(a.start ?? this.start, a.end ?? this.end);
    return new Range(a ?? this.start, b ?? this.end);
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    let anchor, active;
    if (typeof a === 'number') {
      anchor = new Position(a, b);
      active = new Position(c, d);
    } else {
      anchor = a;
      active = b;
    }
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
  get isReversed() {
    return this.anchor.isAfter(this.active);
  }
}

// ---------------------------------------------------------------- Diversos
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(t) {
    this.value += String(t).replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
    return this;
  }
  appendMarkdown(t) {
    this.value += t;
    return this;
  }
  appendCodeblock(code, lang = '') {
    this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range, text) {
    return new TextEdit(range, text);
  }
  static insert(pos, text) {
    return new TextEdit(new Range(pos, pos), text);
  }
  static delete(range) {
    return new TextEdit(range, '');
  }
}

class WorkspaceEdit {
  constructor() {
    this._edits = [];
  }
  replace(uri, range, newText) {
    this._edits.push({ kind: 'text', uri, range, newText });
  }
  insert(uri, pos, newText) {
    this.replace(uri, new Range(pos, pos), newText);
  }
  delete(uri, range) {
    this.replace(uri, range, '');
  }
  set(uri, edits) {
    for (const e of edits || []) this.replace(uri, e.range, e.newText);
  }
  createFile(uri, options) {
    this._edits.push({ kind: 'create', uri, options });
  }
  deleteFile(uri, options) {
    this._edits.push({ kind: 'delete', uri, options });
  }
  renameFile(oldUri, newUri, options) {
    this._edits.push({ kind: 'rename', uri: oldUri, newUri, options });
  }
  has(uri) {
    return this._edits.some((e) => e.uri.toString() === uri.toString());
  }
  entries() {
    const map = new Map();
    for (const e of this._edits) if (e.kind === 'text') {
      const k = e.uri.toString();
      if (!map.has(k)) map.set(k, [e.uri, []]);
      map.get(k)[1].push(new TextEdit(e.range, e.newText));
    }
    return [...map.values()];
  }
  get size() {
    return new Set(this._edits.map((e) => e.uri.toString())).size;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base.uri || base;
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() {
    return !!this.command;
  }
}

class FileSystemError extends Error {
  constructor(messageOrUri, code = 'Unknown') {
    super(typeof messageOrUri === 'string' ? messageOrUri : messageOrUri ? String(messageOrUri) : code);
    this.code = code;
    this.name = `${code} (FileSystemError)`;
  }
  static FileNotFound(m) {
    return new FileSystemError(m, 'FileNotFound');
  }
  static FileExists(m) {
    return new FileSystemError(m, 'FileExists');
  }
  static FileNotADirectory(m) {
    return new FileSystemError(m, 'FileNotADirectory');
  }
  static FileIsADirectory(m) {
    return new FileSystemError(m, 'FileIsADirectory');
  }
  static NoPermissions(m) {
    return new FileSystemError(m, 'NoPermissions');
  }
  static Unavailable(m) {
    return new FileSystemError(m, 'Unavailable');
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this._emitter = emitter;
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  }
  cancel() {
    if (!this.token.isCancellationRequested) {
      this.token.isCancellationRequested = true;
      this._emitter.fire();
    }
  }
  dispose() {
    this._emitter.dispose();
  }
}

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

class Diagnostic {
  constructor(range, message, severity = 0) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

// Inputs de abas (window.tabGroups) — usados com `instanceof`.
class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}
class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}
class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}
class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
  }
}
class TabInputNotebook {
  constructor(uri, notebookType) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}
class TabInputTerminal {}

// Notebooks/tarefas: só construtores de dados (sem implementação real).
class NotebookCellData {
  constructor(kind, value, languageId) {
    Object.assign(this, { kind, value, languageId });
  }
}
class NotebookCellOutputItem {
  constructor(data, mime) {
    this.data = data;
    this.mime = mime;
  }
  static text(value, mime = 'text/plain') {
    return new NotebookCellOutputItem(Buffer.from(String(value)), mime);
  }
  static json(value, mime = 'application/json') {
    return new NotebookCellOutputItem(Buffer.from(JSON.stringify(value)), mime);
  }
  static error(err) {
    return NotebookCellOutputItem.json({ name: err.name, message: err.message, stack: err.stack }, 'application/vnd.code.notebook.error');
  }
  static stdout(v) {
    return NotebookCellOutputItem.text(v, 'application/vnd.code.notebook.stdout');
  }
  static stderr(v) {
    return NotebookCellOutputItem.text(v, 'application/vnd.code.notebook.stderr');
  }
}
class NotebookRange {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class NotebookEdit {
  static replaceCells(range, cells) {
    return Object.assign(new NotebookEdit(), { range, newCells: cells });
  }
  static insertCells(index, cells) {
    return NotebookEdit.replaceCells(new NotebookRange(index, index), cells);
  }
  static deleteCells(range) {
    return NotebookEdit.replaceCells(range, []);
  }
}
class ShellExecution {
  constructor(commandLine, args, options) {
    Object.assign(this, { commandLine, args, options });
  }
}
class Task {
  constructor(definition, scope, name, source, execution, problemMatchers) {
    Object.assign(this, { definition, scope, name, source, execution, problemMatchers });
  }
}
class TreeItem {
  constructor(labelOrUri, collapsibleState) {
    this.label = labelOrUri;
    this.collapsibleState = collapsibleState;
  }
}

function enumOf(names, start = 0) {
  const e = {};
  names.forEach((n, i) => {
    e[n] = start + i;
    e[start + i] = n;
  });
  return e;
}

const enums = {
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  DiagnosticSeverity: enumOf(['Error', 'Warning', 'Information', 'Hint']),
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  EndOfLine: { LF: 1, CRLF: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  UIKind: { Desktop: 1, Web: 2 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  CommentMode: { Editing: 0, Preview: 1 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  SymbolKind: enumOf(['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter']),
  TaskScope: { Global: 1, Workspace: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  TerminalExitReason: { Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 },
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  EnvironmentVariableMutatorType: { Replace: 1, Append: 2, Prepend: 3 },
  ShellExecutionKind: {},
  CompletionItemKind: enumOf(['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter']),
};

module.exports = {
  Disposable,
  EventEmitter,
  Uri,
  Position,
  Range,
  Selection,
  ThemeColor,
  ThemeIcon,
  MarkdownString,
  TextEdit,
  WorkspaceEdit,
  RelativePattern,
  CodeLens,
  FileSystemError,
  CancellationTokenSource,
  CancellationError,
  Diagnostic,
  TabInputText,
  TabInputTextDiff,
  TabInputWebview,
  TabInputCustom,
  TabInputNotebook,
  TabInputTerminal,
  NotebookCellData,
  NotebookCellOutputItem,
  NotebookRange,
  NotebookEdit,
  ShellExecution,
  Task,
  TreeItem,
  ...enums,
};
