// Validação das mensagens app → host (stdin). Toda mensagem precisa de um
// `method` conhecido e `params` no formato esperado — o resto é recusado antes
// de tocar no estado do host. Validadores pequenos, sem dependências.
'use strict';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max = 1 << 20) => typeof v === 'string' && v.length <= max;
const isOptStr = (v, max) => v === undefined || v === null || isStr(v, max);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (p) => isObj(p) && isNum(p.line) && isNum(p.character) && p.line >= 0 && p.character >= 0;
const isRange = (r) => isObj(r) && isPos(r.start) && isPos(r.end);
const isSel = (s) => isObj(s) && ((isPos(s.anchor) && isPos(s.active)) || (isPos(s.start) && isPos(s.end)));
const isPath = (p) => isStr(p, 4096) && p.length > 0 && !p.includes('\0');
const arr = (v, fn, max = 10000) => Array.isArray(v) && v.length <= max && v.every(fn);
const optArr = (v, fn, max) => v === undefined || arr(v, fn, max);

/** method → (params) => true se válido. */
const SCHEMAS = {
  initialize: (p) => isObj(p) && optArr(p.workspaceFolders, (f) => f === null || isPath(f), 64) && isOptStr(p.dataDir, 4096) && isOptStr(p.secrets, 16),
  listInstalled: () => true,
  loadExtension: (p) => isObj(p) && (isStr(p.id, 256) || isPath(p.path)),
  activate: (p) => isObj(p) && isStr(p.id, 256),
  resolveView: (p) => isObj(p) && isStr(p.viewId, 256),
  webviewMessage: (p) => isObj(p) && isStr(p.handle, 64),
  webviewState: (p) => isObj(p) && isStr(p.handle, 64),
  webviewVisible: (p) => isObj(p) && isStr(p.handle, 64),
  webviewPanelState: (p) => isObj(p) && isStr(p.handle, 64) && typeof p.visible === 'boolean' && typeof p.active === 'boolean' && (p.viewColumn === undefined || (isNum(p.viewColumn) && p.viewColumn >= 1 && p.viewColumn <= 64)),
  webviewLog: (p) => isObj(p) && isStr(p.handle, 64) && (p.level === 'error' || p.level === 'warn') && isStr(p.text, 4000),
  webviewUrl: (p) => isObj(p) && isStr(p.handle, 64),
  disposeWebview: (p) => isObj(p) && isStr(p.handle, 64),
  setTheme: (p) => isObj(p) && (p.vars === undefined || isObj(p.vars)) && isOptStr(p.kind, 32),
  setWorkspaceFolders: (p) => isObj(p) && arr(p.folders || [], isPath, 64),
  respond: (p) => isObj(p) && isNum(p.requestId),
  executeCommand: (p) => isObj(p) && isStr(p.command, 512) && (p.args === undefined || Array.isArray(p.args)),
  listCommands: () => true,
  runKeybinding: (p) => isObj(p) && isStr(p.key, 64) && (p.context === undefined || isObj(p.context)),
  shutdown: () => true,
  // Espelho do editor (Monaco → host)
  documentOpened: (p) => isObj(p) && isPath(p.path) && isStr(p.text, 64 << 20) && isOptStr(p.languageId, 128),
  documentChanged: (p) =>
    isObj(p) && isPath(p.path) && (p.text === undefined || isStr(p.text, 64 << 20)) && optArr(p.changes, (c) => isObj(c) && isRange(c.range) && isStr(c.text, 64 << 20), 100000),
  documentClosed: (p) => isObj(p) && isPath(p.path),
  documentSaved: (p) => isObj(p) && isPath(p.path),
  editorsChanged: (p) =>
    isObj(p) &&
    (p.active === null || p.active === undefined || (isObj(p.active) && isPath(p.active.path) && optArr(p.active.selections, isSel, 1000))) &&
    optArr(p.visible, (v) => isObj(v) && isPath(v.path), 64) &&
    optArr(p.tabs, (t) => isObj(t) && isPath(t.path), 1000),
  selectionChanged: (p) => isObj(p) && isPath(p.path) && arr(p.selections, isSel, 1000),
  visibleRangesChanged: (p) => isObj(p) && isPath(p.path) && arr(p.ranges, isRange, 100),
  diagnostics: (p) => isObj(p) && arr(p.entries, (e) => isObj(e) && isPath(e.path) && arr(e.diagnostics || [], (d) => isObj(d) && isRange(d.range), 100000), 100000),
  windowState: (p) => isObj(p) && typeof p.focused === 'boolean',
  // Terminais
  terminalOpened: (p) => isObj(p) && isStr(p.id, 64),
  terminalClosed: (p) => isObj(p) && isStr(p.id, 64),
  terminalShell: (p) =>
    isObj(p) &&
    isStr(p.id, 64) &&
    ['ready', 'cwd', 'start', 'data', 'end'].includes(p.type) &&
    isOptStr(p.cwd, 4096) &&
    isOptStr(p.commandLine, 64 * 1024) &&
    isOptStr(p.data, 4 << 20) &&
    (p.exitCode === undefined || p.exitCode === null || isNum(p.exitCode)),
  // Diffs / URIs
  diffAction: (p) => isObj(p) && isStr(p.diffId, 64) && (p.action === 'accept' || p.action === 'reject') && (p.text === undefined || isStr(p.text, 64 << 20)),
  diffClosed: (p) => isObj(p) && isStr(p.diffId, 64),
  diffEdited: (p) => isObj(p) && isStr(p.diffId, 64) && isStr(p.text, 64 << 20),
  // QuickPick/InputBox (interações da UI)
  quickInputEvent: (p) =>
    isObj(p) &&
    isStr(p.id, 64) &&
    ['value', 'accept', 'hide', 'active', 'selection', 'button', 'itemButton'].includes(p.type) &&
    isOptStr(p.value, 1 << 20) &&
    optArr(p.indexes, (i) => isNum(i) && i >= 0, 5000) &&
    (p.button === undefined || (isNum(p.button) && p.button >= 0)) &&
    (p.item === undefined || (isNum(p.item) && p.item >= 0)),
  // Comentários (threads no editor)
  commentAction: (p) => isObj(p) && isStr(p.handle, 64) && isStr(p.command, 512) && (p.commentIndex === undefined || (isNum(p.commentIndex) && p.commentIndex >= 0)) && isOptStr(p.text, 1 << 20),
  commentReaction: (p) => isObj(p) && isStr(p.handle, 64) && isNum(p.commentIndex) && p.commentIndex >= 0 && isStr(p.reaction, 256),
  commentingRanges: (p) => isObj(p) && isStr(p.uri, 8192) && !p.uri.includes('\0'),
  commentThreads: () => true,
  provideCodeLenses: (p) => isObj(p) && isPath(p.path),
  executeCodeLens: (p) => isObj(p) && isStr(p.id, 64),
  handleUri: (p) => isObj(p) && isStr(p.uri, 8192) && /^(fluent-coder|vscode):\/\//i.test(p.uri),
};

/** @returns {string|null} erro (pt-BR) ou null se válida */
function validateMessage(msg) {
  if (!isObj(msg)) return 'mensagem não é um objeto';
  if (msg.id !== undefined && !(isNum(msg.id) || isStr(msg.id, 128))) return 'id inválido';
  if (typeof msg.method !== 'string') return 'method ausente';
  const schema = SCHEMAS[msg.method];
  if (!schema) return `método desconhecido: ${msg.method}`;
  const params = msg.params === undefined ? {} : msg.params;
  if (!schema(params)) return `parâmetros inválidos para ${msg.method}`;
  return null;
}

module.exports = { validateMessage, SCHEMAS };
