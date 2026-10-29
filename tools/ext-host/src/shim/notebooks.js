// Notebooks: o Fluent Coder NÃO tem editor de notebook, mas as APIs devolvem
// objetos coerentes para as extensões não lançarem:
//
// - `workspace.openNotebookDocument(uri)` lê o .ipynb (JSON, só leitura) e
//   devolve um NotebookDocument com as células (texto, tipo, linguagem,
//   metadados); `openNotebookDocument(tipo, data?)` cria um sem título.
//   Abrir entra em `notebookDocuments` + `onDidOpenNotebookDocument`.
// - `window.showNotebookDocument` mostra um aviso em pt-BR (não há editor de
//   notebook) e devolve um NotebookEditor inerte; `activeNotebookEditor`
//   continua indefinido.
// - controllers: `createNotebookCellExecution` devolve uma execução inerte.
'use strict';
const fs = require('fs');
const path = require('path');
const { Uri, EventEmitter, Range, Position } = require('./types');

const NOTICE = 'O Fluent Coder não tem editor de notebooks: abra o arquivo .ipynb no VS Code/Jupyter. A extensão pode ler o notebook, mas ele não é exibido aqui.';
/** Teto do .ipynb lido (outputs grandes ficam de fora mesmo). */
const MAX_NOTEBOOK_BYTES = 32 * 1024 * 1024;

let untitled = 1;

function cellText(src) {
  return Array.isArray(src) ? src.join('') : typeof src === 'string' ? src : '';
}

/** TextDocument mínimo de uma célula (só leitura). */
function cellDocument(nbUri, index, text, languageId) {
  const lines = text.split(/\r?\n/);
  const uri = nbUri.with({ scheme: 'vscode-notebook-cell', fragment: `c${index}` });
  return {
    uri,
    fileName: uri.fsPath,
    languageId,
    version: 1,
    isDirty: false,
    isClosed: false,
    isUntitled: nbUri.scheme === 'untitled',
    eol: 1,
    lineCount: lines.length,
    getText(range) {
      if (!range) return text;
      const start = this.offsetAt(range.start);
      return text.slice(start, this.offsetAt(range.end));
    },
    lineAt(lineOrPos) {
      const n = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
      const t = lines[Math.max(0, Math.min(lines.length - 1, n))];
      return { lineNumber: n, text: t, range: new Range(n, 0, n, t.length), isEmptyOrWhitespace: !t.trim() };
    },
    offsetAt(pos) {
      let off = 0;
      for (let i = 0; i < pos.line && i < lines.length; i++) off += lines[i].length + 1;
      return Math.min(text.length, off + pos.character);
    },
    positionAt(offset) {
      let rest = Math.max(0, offset);
      for (let i = 0; i < lines.length; i++) {
        if (rest <= lines[i].length) return new Position(i, rest);
        rest -= lines[i].length + 1;
      }
      return new Position(lines.length - 1, lines[lines.length - 1].length);
    },
    save: () => Promise.resolve(false),
  };
}

/** NotebookData/JSON do .ipynb → NotebookDocument (só leitura). */
function createNotebookDocument(uri, notebookType, cellsData, metadata) {
  const doc = {
    uri,
    notebookType,
    version: 1,
    isDirty: false,
    isUntitled: uri.scheme === 'untitled',
    isClosed: false,
    metadata: metadata || {},
    cellCount: 0,
    cellAt(i) {
      return cells[Math.max(0, Math.min(cells.length - 1, i))];
    },
    getCells(range) {
      return range ? cells.slice(range.start, range.end) : cells.slice();
    },
    save: () => Promise.resolve(false),
  };
  const cells = cellsData.map((c, index) => ({
    index,
    notebook: doc,
    kind: c.kind,
    document: cellDocument(uri, index, c.value, c.languageId),
    metadata: c.metadata || {},
    outputs: [],
    executionSummary: undefined,
  }));
  doc.cellCount = cells.length;
  return doc;
}

/** Células de um .ipynb (nbformat 4). */
function parseIpynb(text) {
  const nb = JSON.parse(text);
  const lang = (nb.metadata && ((nb.metadata.language_info && nb.metadata.language_info.name) || (nb.metadata.kernelspec && nb.metadata.kernelspec.language))) || 'python';
  const cells = (Array.isArray(nb.cells) ? nb.cells : []).map((c) => ({
    kind: c.cell_type === 'markdown' || c.cell_type === 'raw' ? 1 : 2,
    value: cellText(c.source),
    languageId: c.cell_type === 'markdown' ? 'markdown' : c.cell_type === 'raw' ? 'raw' : lang,
    metadata: c.metadata || {},
  }));
  return { cells, metadata: nb.metadata || {} };
}

class NotebookService {
  constructor(host) {
    this.host = host;
    this.documents = [];
    this.onDidOpen = new EventEmitter();
    this.onDidClose = new EventEmitter();
    this._noticeShown = false;
  }

  async open(uriOrType, content) {
    let doc;
    if (typeof uriOrType === 'string' && !uriOrType.includes('/') && !uriOrType.includes('\\')) {
      // openNotebookDocument(notebookType, data?) → sem título.
      const cells = (content && Array.isArray(content.cells) ? content.cells : []).map((c) => ({ kind: c.kind, value: String(c.value || ''), languageId: c.languageId || 'plaintext', metadata: c.metadata }));
      doc = createNotebookDocument(Uri.parse(`untitled:Untitled-${untitled++}.ipynb`), uriOrType, cells, content && content.metadata);
    } else {
      const uri = typeof uriOrType === 'string' ? Uri.file(uriOrType) : Uri.revive(uriOrType);
      const existing = this.documents.find((d) => d.uri.toString() === uri.toString());
      if (existing) return existing;
      if (uri.scheme !== 'file') throw new Error(`Notebook fora do disco não é suportado: ${uri.toString()}`);
      const st = await fs.promises.stat(uri.fsPath);
      if (st.size > MAX_NOTEBOOK_BYTES) throw new Error(`Notebook grande demais (${Math.round(st.size / 1048576)} MB).`);
      const text = await fs.promises.readFile(uri.fsPath, 'utf8');
      let parsed;
      try {
        parsed = path.extname(uri.fsPath).toLowerCase() === '.ipynb' ? parseIpynb(text) : { cells: [{ kind: 2, value: text, languageId: 'plaintext' }], metadata: {} };
      } catch (err) {
        throw new Error(`Notebook inválido (${path.basename(uri.fsPath)}): ${err.message}`);
      }
      doc = createNotebookDocument(uri, 'jupyter-notebook', parsed.cells, parsed.metadata);
    }
    this.documents.push(doc);
    this.onDidOpen.fire(doc);
    return doc;
  }

  /** Não há editor de notebook: aviso em pt-BR e um NotebookEditor inerte. */
  async show(docOrUri, options) {
    const doc = docOrUri && docOrUri.notebookType ? docOrUri : await this.open(docOrUri);
    this.host.log(`showNotebookDocument (${doc.uri.toString()}): sem editor de notebook no Fluent Coder`);
    if (this.host.appConnected) this.host.request('showMessage', { severity: 'warning', message: `${NOTICE}\n\n${doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString()}`, items: [] }).catch(() => {});
    return {
      notebook: doc,
      selection: { start: 0, end: 0 },
      selections: [{ start: 0, end: 0 }],
      visibleRanges: [],
      viewColumn: options && typeof options.viewColumn === 'number' ? options.viewColumn : undefined,
      revealRange() {},
    };
  }

  createController(id, notebookType, label) {
    return {
      id,
      notebookType,
      label,
      supportedLanguages: [],
      supportsExecutionOrder: false,
      executeHandler: undefined,
      interruptHandler: undefined,
      onDidChangeSelectedNotebooks: this.host.events.never.event,
      // Execução inerte: as extensões podem chamar start/end/replaceOutput sem quebrar.
      createNotebookCellExecution(cell) {
        const tokenSrc = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        return {
          cell,
          token: tokenSrc,
          executionOrder: undefined,
          start() {},
          end() {},
          clearOutput: () => Promise.resolve(),
          replaceOutput: () => Promise.resolve(),
          appendOutput: () => Promise.resolve(),
          replaceOutputItems: () => Promise.resolve(),
          appendOutputItems: () => Promise.resolve(),
        };
      },
      updateNotebookAffinity() {},
      dispose() {},
    };
  }
}

module.exports = { NotebookService, parseIpynb, NOTICE };
