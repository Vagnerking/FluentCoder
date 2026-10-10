// TextDocument / TextEditor mínimos. O conteúdo vem do disco (ou do provider
// do esquema virtual) e, para o editor ativo, do texto que o Fluent Coder
// publica — o Monaco é a fonte da verdade para buffers sujos.
'use strict';
const path = require('path');
const { Uri, Position, Range, Selection, EndOfLine } = require('./types');

const EXT_LANG = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.md': 'markdown', '.cs': 'csharp', '.cshtml': 'razor', '.razor': 'razor', '.rs': 'rust', '.py': 'python',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.go': 'go', '.java': 'java', '.xml': 'xml', '.yml': 'yaml', '.yaml': 'yaml',
  '.sh': 'shellscript', '.toml': 'toml', '.sql': 'sql', '.txt': 'plaintext', '.csproj': 'xml', '.sln': 'plaintext',
};

function languageIdFor(fsPath) {
  return EXT_LANG[path.extname(fsPath).toLowerCase()] || 'plaintext';
}

class TextDocument {
  constructor(uri, text, languageId) {
    this.uri = uri;
    this.languageId = languageId || languageIdFor(uri.path);
    this.version = 1;
    this.isDirty = false;
    this.isClosed = false;
    this.isUntitled = uri.scheme === 'untitled';
    this.encoding = 'utf8';
    this._setText(text);
  }
  _setText(text) {
    this._text = String(text ?? '');
    this.eol = this._text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
    this._lines = this._text.split(/\r\n|\r|\n/);
    this._lineStarts = [];
    let off = 0;
    const re = /\r\n|\r|\n/g;
    this._lineStarts.push(0);
    let m;
    while ((m = re.exec(this._text))) {
      off = m.index + m[0].length;
      this._lineStarts.push(off);
    }
  }
  _update(text) {
    if (text === this._text) return false;
    this._setText(text);
    this.version++;
    return true;
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
    const text = this._lines[Math.min(Math.max(0, line), this._lines.length - 1)] ?? '';
    const firstNonWs = text.search(/\S/);
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex: firstNonWs === -1 ? text.length : firstNonWs,
      isEmptyOrWhitespace: firstNonWs === -1,
    };
  }
  offsetAt(pos) {
    const line = Math.min(Math.max(0, pos.line), this._lines.length - 1);
    return Math.min(this._lineStarts[line] + Math.min(pos.character, this._lines[line].length), this._text.length);
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
    const text = this.lineAt(pos.line).text;
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
    return Promise.resolve(true);
  }
}

class TextEditor {
  constructor(document, selection, viewColumn = 1) {
    this.document = document;
    this.selections = [selection || new Selection(0, 0, 0, 0)];
    this.visibleRanges = [new Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    this.options = { tabSize: 4, insertSpaces: true, cursorStyle: 1, lineNumbers: 1 };
    this.viewColumn = viewColumn;
    this._onReveal = null;
  }
  get selection() {
    return this.selections[0];
  }
  set selection(s) {
    this.selections = [s];
  }
  edit() {
    // Edições diretas no editor não são suportadas no PoC (workspace.applyEdit é).
    return Promise.resolve(false);
  }
  insertSnippet() {
    return Promise.resolve(false);
  }
  setDecorations() {}
  revealRange(range) {
    this._onReveal && this._onReveal(range);
  }
  show() {}
  hide() {}
}

module.exports = { TextDocument, TextEditor, languageIdFor, Uri };
