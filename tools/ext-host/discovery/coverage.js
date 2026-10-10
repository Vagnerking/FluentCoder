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
  'comments.createCommentController': ['stub', 'threads de comentário não aparecem no editor'],
  'languages.registerCodeLensProvider': ['implementado', 'lentes no Monaco; clique executa o comando da extensão'],
  'tasks.executeTask': ['stub', 'rejeita: tarefas não suportadas'],
  'tasks.onDidEndTaskProcess': ['stub', 'nunca dispara'],
  'window.activeNotebookEditor': ['stub', 'sem notebooks'],
  'window.onDidEndTerminalShellExecution': ['parcial', 'nunca dispara (sem integração real de shell)'],
  'window.onDidChangeTerminalShellIntegration': ['parcial', 'integração simulada ao criar o PTY (executeCommand = digitar a linha)'],
  'window.onDidStartTerminalShellExecution': ['parcial', 'dispara ao executeCommand da integração simulada'],
  'window.registerWebviewPanelSerializer': ['parcial', 'registrado; painéis não são restaurados ao reiniciar o app'],
  'window.registerCustomEditorProvider': ['parcial', 'abre como painel na sidebar de agentes'],
  'window.createWebviewPanel': ['parcial', 'aba na sidebar de agentes (não no grid de editores)'],
  'window.showQuickPick': ['parcial', 'sem canPickMany/botões'],
  'window.showInputBox': ['parcial', 'sem validateInput'],
  'window.createTextEditorDecorationType': ['parcial', 'cores/bordas/texto antes-depois; sem ícones de gutter'],
  'window.withProgress': ['parcial', 'texto na barra de status; sem cancelamento'],
  'window.tabGroups': ['parcial', 'um grupo: abas de arquivo do app + abas de diff'],
  'window.terminals': ['parcial', 'só os terminais criados por extensões'],
  'window.activeTerminal': ['parcial', 'só os terminais criados por extensões'],
  'window.createStatusBarItem': ['implementado', ''],
};

// Tipos de valor/enums (Task, ShellExecution, Notebook*) contam como implementados:
// os construtores se comportam como os do VS Code; o que é stub é o recurso que
// os consome (tasks.executeTask, notebooks).
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
