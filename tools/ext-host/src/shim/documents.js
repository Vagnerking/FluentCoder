// TextDocument / TextEditor. Para arquivos abertos no editor do Fluent Coder o
// Monaco é a fonte da verdade: o app manda o texto ao abrir e, depois, só as
// mudanças incrementais (`documentChanged`), aplicadas aqui na mesma ordem do
// VS Code (`contentChanges` sequenciais). Documentos que o app não abriu vêm do
// disco (e do watcher) ou do provider do esquema virtual.
'use strict';
const path = require('path');
const { Uri, Position, Range, Selection, EndOfLine } = require('./types');

const EXT_LANG = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'jsonc', '.md': 'markdown', '.cs': 'csharp', '.cshtml': 'razor', '.razor': 'razor', '.rs': 'rust', '.py': 'python',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.go': 'go', '.java': 'java', '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml',
  '.sh': 'shellscript', '.bash': 'shellscript', '.toml': 'toml', '.sql': 'sql', '.txt': 'plaintext', '.csproj': 'xml', '.sln': 'plaintext',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin', '.swift': 'swift', '.vue': 'vue',
  '.ps1': 'powershell', '.dockerfile': 'dockerfile',
};

function languageIdFor(fsPath) {
  const base = path.basename(fsPath).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  return EXT_LANG[path.extname(fsPath).toLowerCase()] || 'plaintext';
}

function toPosition(p) {
  return p instanceof Position ? p : new Position(p.line, p.character);
}
function toRange(r) {
  return r instanceof Range ? r : new Range(toPosition(r.start), toPosition(r.end));
}

class TextDocument {
  constructor(uri, text, languageId, version = 1) {
    this.uri = uri;
    this.languageId = languageId || languageIdFor(uri.path);
    this.version = version;
    this.isDirty = false;
    this.isClosed = false;
    this.isUntitled = uri.scheme === 'untitled';
    this.encoding = 'utf8';
    /** Documento espelhado de um modelo do Monaco (o app manda as mudanças). */
    this._appOwned = false;
    this._saveHandler = null;
    this._setText(text);
  }
  _setText(text) {
    this._text = String(text ?? '');
    this.eol = this._text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
    this._lines = this._text.split(/\r\n|\r|\n/);
    this._lineStarts = [0];
    const re = /\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(this._text))) this._lineStarts.push(m.index + m[0].length);
  }
  /**
   * Troca o texto inteiro. Devolve a `contentChanges` mínima (prefixo/sufixo
   * comuns) ou null se nada mudou.
   */
  _update(text, version) {
    text = String(text ?? '');
    if (text === this._text) {
      if (version !== undefined) this.version = version;
      return null;
    }
    const old = this._text;
    let start = 0;
    const max = Math.min(old.length, text.length);
    while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
    let endOld = old.length;
    let endNew = text.length;
    while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) {
      endOld--;
      endNew--;
    }
    const range = new Range(this.positionAt(start), this.positionAt(endOld));
    const change = { range, rangeOffset: start, rangeLength: endOld - start, text: text.slice(start, endNew) };
    this._setText(text);
    this.version = version !== undefined ? version : this.version + 1;
    return [change];
  }
  /**
   * Aplica mudanças incrementais do Monaco (cada uma relativa ao texto já com
   * as anteriores aplicadas). Devolve as `contentChanges` do evento.
   */
  _applyChanges(changes, version) {
    const out = [];
    for (const ch of changes || []) {
      const range = toRange(ch.range);
      const s = this.offsetAt(range.start);
      const e = this.offsetAt(range.end);
      const text = String(ch.text ?? '');
      out.push({ range, rangeOffset: s, rangeLength: e - s, text });
      this._setText(this._text.slice(0, s) + text + this._text.slice(e));
    }
    this.version = version !== undefined ? version : this.version + 1;
    return out;
  }
  get fileName() {
    return this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.path;
  }
  get lineCount() {
    return this._lines.length;
  }
  getText(range) {
    if (!range) return this._text;
    return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  lineAt(lineOrPos) {
    const line = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
    if (line < 0 || line >= this._lines.length) throw new Error('Illegal value for `line`');
    const text = this._lines[line];
    const firstNonWs = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: line < this._lines.length - 1 ? new Range(line, 0, line + 1, 0) : new Range(line, 0, line, text.length),
      firstNonWhitespaceCharacterIndex: firstNonWs === -1 ? text.length : firstNonWs,
      isEmptyOrWhitespace: firstNonWs === -1,
    };
  }
  offsetAt(pos) {
    const line = Math.min(Math.max(0, pos.line), this._lines.length - 1);
    return Math.min(this._lineStarts[line] + Math.min(Math.max(0, pos.character), this._lines[line].length), this._text.length);
  }
  positionAt(offset) {
    offset = Math.max(0, Math.min(offset, this._text.length));
    let lo = 0;
    let hi = this._lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, Math.min(offset - this._lineStarts[lo], this._lines[lo].length));
  }
  getWordRangeAtPosition(pos, regex = /[\w$]+/g) {
    const text = this._lines[pos.line] ?? '';
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let m;
    while ((m = re.exec(text))) {
      if (m.index <= pos.character && m.index + m[0].length >= pos.character) return new Range(pos.line, m.index, pos.line, m.index + m[0].length);
      if (!m[0]) re.lastIndex++;
    }
    return undefined;
  }
  validateRange(r) {
    return new Range(this.validatePosition(r.start), this.validatePosition(r.end));
  }
  validatePosition(p) {
    return this.positionAt(this.offsetAt(p));
  }
  save() {
    return this._saveHandler ? this._saveHandler(this) : Promise.resolve(!this.isDirty);
  }
}

/** Snippet → texto puro (placeholders viram o texto padrão; tabstops somem). */
function snippetToText(value) {
  let s = String(value || '');
  for (let i = 0; i < 5; i++) s = s.replace(/\$\{\d+:([^{}]*)\}/g, '$1');
  return s
    .replace(/\$\{\d+\|([^|}]*)[^}]*\}/g, '$1')
    .replace(/\$\{\d+\}|\$\d+/g, '')
    .replace(/\\([$}\\])/g, '$1');
}

/**
 * Editor visível. `host` (opcional) liga edições/seleção/decorações ao app.
 */
class TextEditor {
  constructor(document, selection, viewColumn = 1, host = null) {
    this.document = document;
    this._selections = [selection || new Selection(0, 0, 0, 0)];
    this.visibleRanges = [new Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    this.options = { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 };
    this.viewColumn = viewColumn;
    this._host = host;
  }
  get selection() {
    return this._selections[0];
  }
  set selection(s) {
    this.selections = [s];
  }
  get selections() {
    return this._selections;
  }
  set selections(list) {
    this._selections = (list || []).map((s) => (s instanceof Selection ? s : new Selection(s.anchor || s.start, s.active || s.end)));
    if (this._host) this._host.setEditorSelections(this, this._selections);
  }
  /** Atualização vinda do app (não ecoa de volta). */
  _acceptSelections(list) {
    this._selections = list;
  }
  edit(callback, options = {}) {
    const edits = [];
    let eol;
    const builder = {
      replace: (loc, text) => edits.push({ range: loc instanceof Position ? new Range(loc, loc) : toRange(loc), text: String(text ?? '') }),
      insert: (pos, text) => edits.push({ range: new Range(toPosition(pos), toPosition(pos)), text: String(text ?? '') }),
      delete: (range) => edits.push({ range: toRange(range), text: '' }),
      setEndOfLine: (e) => {
        eol = e;
      },
    };
    try {
      callback(builder);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this._host) return Promise.resolve(false);
    if (!edits.length && eol === undefined) return Promise.resolve(true);
    return this._host.applyTextEdits(this.document, edits, { undoStopBefore: options.undoStopBefore !== false, undoStopAfter: options.undoStopAfter !== false, eol });
  }
  insertSnippet(snippet, location) {
    const text = snippetToText(snippet && typeof snippet === 'object' ? snippet.value : snippet);
    const ranges = location ? (Array.isArray(location) ? location : [location]).map((l) => (l instanceof Position ? new Range(l, l) : toRange(l))) : this._selections;
    return this.edit((b) => ranges.forEach((r) => b.replace(r, text)));
  }
  setDecorations(decorationType, rangesOrOptions) {
    if (this._host) this._host.setDecorations(this, decorationType, rangesOrOptions || []);
  }
  revealRange(range, revealType) {
    if (this._host) this._host.revealRange(this, toRange(range), revealType);
  }
  show(column) {
    if (this._host) this._host.showTextDocument(this.document, column);
  }
  hide() {}
}

module.exports = { TextDocument, TextEditor, languageIdFor, snippetToText, toRange, toPosition, Uri };
