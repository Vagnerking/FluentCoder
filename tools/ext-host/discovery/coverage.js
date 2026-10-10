// Tabela de cobertura (markdown): caminhos `vscode.*` referenciados no bundle de
// cada extensão (varredura estática) × o que o shim implementa, com o ESTADO:
//   implementado · parcial (funciona com limitação documentada) · stub (existe
//   mas é inerte) · proposta (API proposta, fora do escopo) · ausente.
// Uso: node tools/ext-host/discovery/coverage.js <ext1/main.js> [<ext2/main.js> …]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanSource } = require('./static-scan');
const { ExtensionHost } = require('../src/host');
const { createVscodeApi } = require('../src/shim/api');

/** Estado de cada caminho que NÃO é "implementado" (o padrão quando existe). */
const STATUS = {
  'commands.getCommands': ['parcial', 'só comandos registrados por extensões (sem os internos do VS Code)'],
  'comments.createCommentController': ['implementado', 'threads no Monaco (view zone + overlay Fluent) com as ações dos menus comments/*; "+" nas faixas do commentingRangeProvider, responder, editar/apagar; barra de hunks do Claude no diff'],
  'languages.registerCodeLensProvider': ['implementado', 'lentes no Monaco; clique executa o comando da extensão'],
  'tasks.executeTask': ['implementado', 'Shell/ProcessExecution num terminal integrado ("Tarefa: …"); CustomExecution no pseudoterminal da extensão'],
  'tasks.onDidEndTaskProcess': ['implementado', 'exitCode do PTY'],
  'window.activeNotebookEditor': ['stub', 'sem editor de notebook (indefinido); openNotebookDocument lê o .ipynb só leitura e showNotebookDocument avisa em pt-BR'],
  'window.onDidEndTerminalShellExecution': ['implementado', 'OSC 633 real (bash/zsh/fish) com exitCode; outros shells: integração simulada'],
  'window.onDidChangeTerminalShellIntegration': ['implementado', 'ao ver as sequências OSC 633 e a cada mudança de cwd; fallback simulado em 2,5 s'],
  'window.onDidStartTerminalShellExecution': ['implementado', 'OSC 633 real (comandos digitados e executeCommand); execution.read() com a saída'],
  'window.registerWebviewPanelSerializer': ['implementado', 'painéis (e custom editors) restaurados ao reiniciar o app: deserializeWebviewPanel com o estado do setState'],
  'window.registerCustomEditorProvider': ['implementado', 'abre como aba da grade de editores (TabInputCustom)'],
  'window.createWebviewPanel': ['implementado', 'aba da grade de editores (viewColumn/Beside/preserveFocus, onDidChangeViewState, dispose)'],
  'window.showQuickPick': ['implementado', 'canPickMany, separadores, onDidSelectItem, token (sobre createQuickPick)'],
  'window.showInputBox': ['implementado', 'validateInput ao vivo (síncrono/assíncrono, severidade)'],
  'window.createTextEditorDecorationType': ['implementado', 'cores/bordas, ícone de gutter, régua (lane), isWholeLine, before/after com texto/ícone e renderOptions por faixa'],
  'window.withProgress': ['implementado', 'Notification = aviso com barra e Cancelar; Window/SCM = barra de status; CancellationToken real'],
  'window.tabGroups': ['parcial', 'um grupo lógico: abas de arquivo do app + diffs + painéis de webview'],
  'window.terminals': ['parcial', 'só os terminais criados por extensões'],
  'window.activeTerminal': ['parcial', 'só os terminais criados por extensões'],
  'window.createStatusBarItem': ['implementado', ''],
};

// Tipos de valor/enums (Task, ShellExecution, Notebook*) contam como implementados:
// os construtores se comportam como os do VS Code; o que é stub é o recurso que
// os consome (notebooks).
const PROPOSED = /^(chat|lm|languageModels|interactive)\./;

function main() {
  const files = process.argv.slice(2);
  const scans = files.map((f) => scanSource(fs.readFileSync(f, 'utf8')).paths);
  const host = new ExtensionHost({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-cov-')) });
  const api = createVscodeApi(host, { id: 'coverage', packageJSON: {}, extensionPath: '/', contributions: { commands: [], keybindings: [], editorTitle: [], views: [] } });

  function exists(key) {
    let cur = api;
    for (const p of key.split('.')) {
      if (cur == null || !(p in Object(cur))) return false;
      cur = cur[p];
    }
    return true;
  }

  function state(key) {
    if (PROPOSED.test(key)) return ['proposta', 'API proposta (enabledApiProposals não é honrado)'];
    if (!exists(key)) return ['ausente', ''];
    return STATUS[key] || ['implementado', ''];
  }

  // `version.split` etc. são acessos a propriedades de string, não API.
  const keys = [...new Set(scans.flatMap((s) => [...s.keys()]))].filter((k) => !/^version\./.test(k)).sort((a, b) => a.localeCompare(b));
  const counts = {};
  for (const k of keys) counts[state(k)[0]] = (counts[state(k)[0]] || 0) + 1;
  const nonProposed = keys.filter((k) => state(k)[0] !== 'proposta').length;
  const usable = (counts.implementado || 0) + (counts.parcial || 0);
  console.log(`Caminhos: ${keys.length} (${nonProposed} não propostos) · implementado ${counts.implementado || 0} · parcial ${counts.parcial || 0} · stub ${counts.stub || 0} · ausente ${counts.ausente || 0} · proposta ${counts.proposta || 0}`);
  console.log(`Cobertura funcional (implementado+parcial / não propostos): ${((100 * usable) / nonProposed).toFixed(1)}% · presentes no shim: ${((100 * (nonProposed - (counts.ausente || 0))) / nonProposed).toFixed(1)}%\n`);
  console.log(`| API | ${files.map((f) => path.basename(path.dirname(f.replace(/\/out\//, '/'))).replace(/-\d.*$/, '')).join(' | ')} | estado | observação |`);
  console.log(`|---|${files.map(() => '---:').join('|')}|---|---|`);
  for (const k of keys) {
    const [st, note] = state(k);
    console.log(`| \`${k}\` | ${scans.map((s) => s.get(k) || '–').join(' | ')} | ${st} | ${note} |`);
  }
  process.exit(0);
}

if (require.main === module) main();
module.exports = { STATUS };
