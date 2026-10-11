// Gera `src/extensions/capabilities.json`: o que o shim (`require('vscode')`)
// deste host oferece, para o classificador de compatibilidade da view
// Extensões (`src/extensions/compatibility.ts`).
//
//   node tools/ext-host/discovery/capabilities.js          → grava o JSON
//   node tools/ext-host/discovery/capabilities.js --check  → falha se o JSON
//                                                             commitado divergir
//
// Fonte de verdade: o PRÓPRIO objeto de API do shim (o que existe), os estados
// anotados em `coverage.js` (parcial/stub documentados — os mesmos de
// docs/research/vsix-api-surface.md) e a detecção de stubs inertes
// (`noopDisposable()`, eventos que nunca disparam). Pontos de contribuição e
// eventos de ativação vêm do que `contributions.js`/`host.js` honram.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExtensionHost } = require('../src/host');
const { createVscodeApi, VSCODE_VERSION } = require('../src/shim/api');
const { STATUS } = require('./coverage');

const OUT = path.join(__dirname, '..', '..', '..', 'src', 'extensions', 'capabilities.json');

/** Propostas: o host não honra `enabledApiProposals`. */
const PROPOSED_PREFIXES = ['chat.', 'lm.', 'languageModels.', 'interactive.', 'ai.', 'speech.'];

/** Stubs conhecidos além dos detectados automaticamente (inertes por desenho). */
const EXTRA_STUBS = {
  'window.registerTreeDataProvider': 'tree views não são renderizadas (só webview views)',
  'window.createTreeView': 'tree views não são renderizadas (só webview views)',
  'window.registerTerminalLinkProvider': 'links de terminal contribuídos não aparecem',
  'window.registerTerminalProfileProvider': 'perfis de terminal contribuídos não aparecem',
  'window.registerFileDecorationProvider': 'decorações de arquivo no Explorador não aparecem',
  'authentication.getSession': 'sem provedores de autenticação (sempre indefinido)',
  'authentication.registerAuthenticationProvider': 'provedores de autenticação não são expostos',
  'debug.startDebugging': 'sem adaptadores de depuração de extensões',
  'debug.registerDebugAdapterDescriptorFactory': 'sem adaptadores de depuração de extensões',
  'debug.registerDebugConfigurationProvider': 'sem adaptadores de depuração de extensões',
  'scm.createSourceControl': 'controle de código-fonte de extensões não aparece no app',
  'workspace.registerNotebookSerializer': 'sem editor de notebook',
  'notebooks.createNotebookController': 'sem editor de notebook (execução inerte)',
};

/**
 * Pontos de `contributes` e como o app os honra.
 *   supported   — usado como no VS Code
 *   partial     — usado com limitação (nota)
 *   ignored     — inofensivo: ignorado sem afetar a função principal
 *   unsupported — a extensão depende dele e ele não existe aqui
 */
const CONTRIBUTION_POINTS = {
  commands: ['supported', 'Paleta de Comandos (com o título do package.json)'],
  configuration: ['supported', 'defaults + overrides próprios do host (nunca o settings do VS Code)'],
  configurationDefaults: ['ignored', ''],
  keybindings: ['partial', 'best effort: no editor só os de editorTextFocus; no webview, todos'],
  menus: ['partial', 'só commandPalette, editor/title (diffs) e comments/*'],
  views: ['partial', 'só views de webview (no Fluent Chat); tree views não são renderizadas'],
  viewsContainers: ['partial', 'metadados (as views de webview viram uma aba no Fluent Chat)'],
  viewsWelcome: ['ignored', ''],
  customEditors: ['supported', 'abas da grade de editores (registerCustomEditorProvider)'],
  walkthroughs: ['ignored', ''],
  icons: ['ignored', ''],
  colors: ['ignored', 'cores contribuídas não entram no tema do app'],
  jsonValidation: ['ignored', 'esquemas JSON contribuídos não validam arquivos no editor'],
  // Contribuições DECLARATIVAS: aplicadas pelo app sem executar código
  // (modo "somente contribuições", src/extensions/contributions/).
  languages: ['supported', 'registradas no Monaco sem executar código; C#, Razor/CSHTML e as linguagens com LSP próprio mantêm o mapeamento do app'],
  grammars: ['supported', 'gramáticas TextMate (Oniguruma) com limite de tempo por linha e validação contra ReDoS; C#/Razor/CSHTML mantêm o pipeline do app'],
  snippets: ['supported', 'IntelliSense do Monaco (tabstops, placeholders, escolhas, variáveis)'],
  themes: ['supported', 'temas de cor (editor, terminal e tokens da UI) sem executar código'],
  iconThemes: ['supported', 'temas de ícones de arquivos (SVG/PNG só via <img>, fontes ≤ 2 MB)'],
  productIconThemes: ['partial', 'ícones de produto por fonte: troca os codicons da UI (melhor esforço)'],
  debuggers: ['unsupported', 'sem adaptadores de depuração de extensões'],
  breakpoints: ['unsupported', 'sem adaptadores de depuração de extensões'],
  notebooks: ['unsupported', 'sem editor de notebook'],
  notebookRenderer: ['unsupported', 'sem editor de notebook'],
  taskDefinitions: ['partial', 'tasks.registerTaskProvider/executeTask funcionam; a UI de tarefas do app não lista as contribuídas'],
  problemMatchers: ['ignored', ''],
  problemPatterns: ['ignored', ''],
  terminal: ['unsupported', 'perfis de terminal contribuídos não aparecem'],
  authentication: ['unsupported', 'provedores de autenticação não são expostos'],
  resourceLabelFormatters: ['unsupported', 'workspaces virtuais/remotos de extensões não existem aqui'],
  semanticTokenTypes: ['ignored', ''],
  semanticTokenModifiers: ['ignored', ''],
  semanticTokenScopes: ['ignored', ''],
  submenus: ['ignored', ''],
  typescriptServerPlugins: ['unsupported', 'o servidor TypeScript do app não carrega plugins de extensões'],
  html: ['ignored', ''],
  css: ['ignored', ''],
  markdown: ['ignored', ''],
  'markdown.previewStyles': ['ignored', ''],
  'markdown.previewScripts': ['ignored', ''],
  'markdown.markdownItPlugins': ['ignored', ''],
  remoteHelp: ['ignored', ''],
  continueEditSession: ['ignored', ''],
  chatParticipants: ['unsupported', 'API proposta de chat do VS Code (ausente)'],
  languageModelTools: ['unsupported', 'API proposta de modelos de linguagem (ausente)'],
  mcpServerDefinitionProviders: ['unsupported', 'provedores MCP do VS Code não são expostos'],
};

/** Eventos de ativação que o host dispara. */
const ACTIVATION_EVENTS = {
  '*': ['supported', 'ativada ao subir o host'],
  onStartupFinished: ['supported', 'ativada ao subir o host'],
  onCommand: ['supported', 'ao executar um comando contribuído (Paleta)'],
  onView: ['partial', 'só views de webview (ao abrir a aba no Fluent Chat)'],
  onWebviewPanel: ['supported', 'painéis restaurados ao reiniciar'],
  onCustomEditor: ['supported', ''],
  onUri: ['supported', 'deep link fluent-coder://<publisher.nome>/…'],
  onLanguage: ['unsupported', 'o host não ativa extensões ao abrir um arquivo da linguagem'],
  workspaceContains: ['unsupported', 'o host não ativa extensões pelo conteúdo do workspace'],
  onFileSystem: ['unsupported', 'sistemas de arquivos de extensões não são montados no Explorador'],
  onDebug: ['unsupported', 'sem adaptadores de depuração de extensões'],
  onDebugResolve: ['unsupported', 'sem adaptadores de depuração de extensões'],
  onDebugInitialConfigurations: ['unsupported', 'sem adaptadores de depuração de extensões'],
  onDebugDynamicConfigurations: ['unsupported', 'sem adaptadores de depuração de extensões'],
  onDebugAdapterProtocolTracker: ['unsupported', 'sem adaptadores de depuração de extensões'],
  onNotebook: ['unsupported', 'sem editor de notebook'],
  onNotebookSerializer: ['unsupported', 'sem editor de notebook'],
  onRenderer: ['unsupported', 'sem editor de notebook'],
  onAuthenticationRequest: ['unsupported', 'provedores de autenticação não são expostos'],
  onTerminalProfile: ['unsupported', 'perfis de terminal contribuídos não aparecem'],
  onSearch: ['unsupported', ''],
  onWalkthrough: ['ignored', ''],
  onOpenExternalUri: ['unsupported', ''],
  onIssueReporterOpened: ['ignored', ''],
  onChatParticipant: ['unsupported', 'API proposta de chat do VS Code (ausente)'],
  onLanguageModelTool: ['unsupported', 'API proposta de modelos de linguagem (ausente)'],
  onTaskType: ['unsupported', 'a UI de tarefas do app não dispara a ativação'],
  onEditSession: ['ignored', ''],
};

function build() {
  const host = new ExtensionHost({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fluent-caps-')) });
  const api = createVscodeApi(host, { id: 'capabilities', packageJSON: {}, extensionPath: '/', contributions: { commands: [], keybindings: [], editorTitle: [], views: [] } });
  const never = host.events.never.event;
  const apis = {};
  const notes = {};
  const set = (key, state, note) => {
    apis[key] = state;
    if (note) notes[key] = note;
  };
  const isStubFn = (fn) => {
    if (typeof fn !== 'function') return false;
    if (fn === never) return true;
    const src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ');
    return /^(\(\)|function\s*\w*\(\))\s*(=>)?\s*\{?\s*(return\s+)?noopDisposable\(\);?\s*\}?$/.test(src) || /^\w+\(\) \{ return noopDisposable\(\); \}$/.test(src);
  };
  for (const [ns, value] of Object.entries(api)) {
    const isNamespace = /^[a-z]/.test(ns) && value && typeof value === 'object';
    if (!isNamespace) {
      set(ns, 'implemented');
      continue;
    }
    for (const member of Object.getOwnPropertyNames(value)) {
      const key = `${ns}.${member}`;
      const d = Object.getOwnPropertyDescriptor(value, member);
      const v = d && 'value' in d ? d.value : undefined;
      if (STATUS[key]) {
        const [st, note] = STATUS[key];
        set(key, st === 'implementado' ? 'implemented' : st === 'parcial' ? 'partial' : st === 'stub' ? 'stub' : 'implemented', note);
      } else if (EXTRA_STUBS[key]) set(key, 'stub', EXTRA_STUBS[key]);
      else if (v !== undefined && isStubFn(v)) set(key, 'stub', /^on[A-Z]/.test(member) ? 'evento que nunca dispara neste host' : 'registrar não tem efeito neste host');
      else set(key, 'implemented');
    }
  }
  const sorted = Object.fromEntries(Object.keys(apis).sort().map((k) => [k, apis[k]]));
  const sortedNotes = Object.fromEntries(Object.keys(notes).sort().map((k) => [k, notes[k]]));
  const pairs = (obj) => Object.fromEntries(Object.entries(obj).map(([k, [state, note]]) => [k, note ? { state, note } : { state }]));
  return {
    $comment: 'GERADO por tools/ext-host/discovery/capabilities.js — não editar à mão.',
    hostVersion: VSCODE_VERSION,
    proposedPrefixes: PROPOSED_PREFIXES,
    apis: sorted,
    notes: sortedNotes,
    contributionPoints: pairs(CONTRIBUTION_POINTS),
    activationEvents: pairs(ACTIVATION_EVENTS),
  };
}

function main() {
  const json = JSON.stringify(build(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== json) {
      console.error('capabilities.json desatualizado: rode `node tools/ext-host/discovery/capabilities.js`.');
      process.exit(1);
    }
    console.log('capabilities.json em dia.');
    process.exit(0);
  }
  fs.writeFileSync(OUT, json);
  const counts = {};
  for (const s of Object.values(JSON.parse(json).apis)) counts[s] = (counts[s] || 0) + 1;
  console.log(`capabilities.json: shim ${VSCODE_VERSION} · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  process.exit(0);
}

if (require.main === module) main();
module.exports = { build, CONTRIBUTION_POINTS, ACTIVATION_EVENTS, PROPOSED_PREFIXES };
