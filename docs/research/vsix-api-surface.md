# Superfície da API `vscode` usada pelas extensões Claude Code e Codex

- **Data:** 10/10/2026
- **Alvo:** `anthropic.claude-code@2.1.296` (linux-x64) e `openai.chatgpt@26.1007.21434` (Codex, linux-x64), lidas de `~/.vscode/extensions/` (somente leitura).
- **Ferramentas (reexecutáveis):** `tools/ext-host/discovery/`
  - `static-scan.js <main.js>` — varredura estática do bundle: acha os identificadores ligados a `require("vscode")` e conta os caminhos `vscode.a.b`.
  - `run.js <pasta-da-extensão>` — descoberta dinâmica: ativa a extensão real no shim, embrulhado num `Proxy` de gravação (`record.js`), resolve as webview views contribuídas e simula a 1ª mensagem do webview (`init` no Claude, `ready` no Codex). Caminhos que não existem no shim seriam marcados `missing` e devolvem um stub chamável que segue gravando.
  - `coverage.js <main.js>…` — cruza a varredura estática com o shim (tabela abaixo).

> Sem prompts a modelos: a descoberta só chama `activate()`, `resolveWebviewView()` e o handshake do webview. Rodamos com `CLAUDE_CONFIG_DIR`/`CODEX_HOME` apontando para pastas temporárias para não tocar a configuração real do usuário.

## Resultado da descoberta dinâmica

| | Claude Code | Codex |
|---|---|---|
| `activate()` | ok (~250 ms), 30 comandos registrados | ok (~270 ms), 10 comandos registrados |
| Webview views registradas | `claudeVSCodeSidebar`, `claudeVSCodeSidebarSecondary`, `claudeVSCodeSessionsList` | `chatgpt.sidebarView`, `chatgpt.sidebarSecondaryView` (+ custom editor `chatgpt.conversationEditor`) |
| `setContext` emitidos | `claude-vscode.sessionsListEnabled`, `…primaryEditorEnabled`, `…sideBarActive`, `…updateSupported=false` | `chatgpt.doesNotSupportSecondarySidebar=false`, `chatgpt.lspMcpEnabled=false` |
| Caminhos ausentes no shim tocados | **nenhum** | **nenhum** (as propostas `chat`/`lm` são acessadas dentro de `try` e falham de forma tratada) |
| Processo filho | `claude` nativo (`resources/native-binary/claude`) para "config cache"; servidor MCP de IDE em `127.0.0.1:<porta>` + lock em `$CLAUDE_CONFIG_DIR/ide/<porta>.lock` | `bin/linux-x86_64/codex app-server` (initialize ok) |

Caminhos tocados em tempo de execução (ativação + resolve + handshake), `(acessos/chamadas)`:

- **Claude Code:** `commands.executeCommand (8/8)`, `commands.registerCommand (30/30)`, `Disposable`, `env.appName`, `env.machineId`, `env.remoteName`, `env.sessionId`, `env.shell`, `EventEmitter`, `ExtensionMode`, `extensions.all`, `extensions.getExtension (3/3)`, `NotebookCellOutputItem`, `RelativePattern`, `StatusBarAlignment`, `Uri`, `version`, `window.createOutputChannel`, `window.createStatusBarItem`, `window.onDidChangeActiveTextEditor`, `window.onDidChangeTextEditorSelection`, `window.onDidChangeVisibleTextEditors`, `window.registerUriHandler`, `window.registerWebviewPanelSerializer`, `window.registerWebviewViewProvider (3/3)`, `window.tabGroups.all`, `window.tabGroups.onDidChangeTabGroups`, `window.tabGroups.onDidChangeTabs`, `workspace.createFileSystemWatcher`, `workspace.getConfiguration (62/62)`, `workspace.onDidChangeConfiguration`, `workspace.onDidChangeTextDocument`, `workspace.onDidChangeWorkspaceFolders`, `workspace.onDidCloseTextDocument`, `workspace.onDidOpenTextDocument`, `workspace.registerFileSystemProvider (4/4)`, `workspace.registerTextDocumentContentProvider`, `workspace.workspaceFolders`.
- **Codex:** `commands.executeCommand (3/3)` (inclui `_codex.microphone.available`, da extensão irmã `openai.codex-audio` — ignorado), `commands.registerCommand (10/10)`, `ConfigurationTarget`, `DiagnosticSeverity`, `Disposable`, `env.appName`, `EventEmitter`, `extensions.getExtension (4/4)`, `languages.registerCodeLensProvider`, `Uri`, `version`, `window.activeTextEditor`, `window.createOutputChannel`, `window.onDidChangeActiveTextEditor`, `window.onDidChangeTerminalShellIntegration`, `window.onDidChangeTextEditorSelection`, `window.onDidChangeWindowState`, `window.registerCustomEditorProvider`, `window.registerUriHandler`, `window.registerWebviewViewProvider (2/2)`, `window.state`, `window.tabGroups.all`, `workspace.fs.readFile` (lê o próprio `webview/index.html`), `workspace.getConfiguration (41/41)`, `workspace.onDidChangeConfiguration`, `workspace.onDidChangeWorkspaceFolders`.

Limitação do gravador: os bundles usam o `__toESM` do esbuild, que copia só as chaves **existentes** do módulo. Um namespace inteiro ausente (ex.: `vscode.chat`) vira `undefined` na cópia sem passar pelo `Proxy` — por isso a varredura estática complementa a dinâmica.

## Contrato do webview (o que as UIs esperam)

- **Claude Code:** HTML gerado em `getHtmlForWebview` com CSP `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:; script-src 'nonce-…'; worker-src ${cspSource}` e assets `webview/index.js` + `webview/index.css` via `asWebviewUri`. Mensagens: webview → extensão `{type:"request", requestId, channelId, request:{type:"init"|…}}`, `launch_claude`, `io_message`…; extensão → webview **embrulhadas** em `{type:"from-extension", message:{…}}`. Lê `--vscode-editor-font-*` e `--vscode-chat-font-*` (a própria extensão injeta) e as cores `--vscode-*` do tema. `getState/setState` via `acquireVsCodeApi()`.
- **Codex:** lê `webview/index.html` com `workspace.fs.readFile`, troca `<!-- PROD_BASE_TAG_HERE -->` por `<base href="${asWebviewUri(webview)}/">` e injeta um CSP próprio (`cspSource` + origem do Sentry). Módulos ES (`type="module" crossorigin`) relativos ao `<base>` — o servidor responde com `Access-Control-Allow-Origin: *`. Handshake: webview → `{type:"ready"}`; extensão → `chat-font-settings`, estado do app-server, prompts, estado persistido. RPC "capn" por `{type:"vscode-capn-rpc-connect"|"vscode-capn-rpc-message", sessionId, message}` e mensagens grandes em pedaços (`chunked-message-ack`).

## Estado do shim (hardening, 10/10/2026)

Re-descoberta dinâmica (`run.js`) após o hardening: **nenhum caminho ausente**
tocado na ativação + resolve + handshake das duas extensões.

| Área | Estado | Detalhe |
|---|---|---|
| Editor (`TextDocument`/`TextEditor`) | implementado | espelho dos modelos do Monaco por eventos (texto incremental, versão, dirty, undo/redo), `edit`/`insertSnippet`/`applyEdit` no modelo com undo, seleção/reveal, decorações (subconjunto de estilos) |
| `vscode.diff` + aceitar/rejeitar | implementado | revisão do Monaco (`ClaudeDiffReview`); comandos `editor/title` da extensão com `when`; fallback "salvar"/fechar aba. Validado com o Claude Code real (`flows-check.js`) |
| `window.createTerminal` | implementado | terminal integrado real (PTY), env/`environmentVariableCollection`, `processId`, `onDidCloseTerminal`/`exitStatus`; shell integration simulada (sem `onDidEndTerminalShellExecution`) |
| `registerUriHandler` / `env.uriScheme` | implementado | `fluent-coder://<extensão>/…` via `tauri-plugin-deep-link` + repasse à instância aberta |
| `context.secrets` | implementado | cofre do SO (`keyring`), migração do JSON, fallback 0600 |
| `createFileSystemWatcher` | implementado | `fs.watch` sem polling, glob, pastas pesadas puladas |
| `languages.getDiagnostics` | implementado | markers do Monaco + coleções das extensões (viram markers) |
| `languages.registerCodeLensProvider` | implementado | lentes no Monaco |
| status bar / `withProgress` / output channels | implementado / parcial | itens na barra do app; progresso como texto; canais na aba Saída |
| diálogos (`showMessage`/`QuickPick`/`InputBox`/arquivo) | parcial | sem `canPickMany`/`validateInput`/botões |
| `createWebviewPanel` / custom editor | parcial | abas na sidebar de agentes (não no grid de editores) |
| `tasks`, notebooks, `comments` | stub | tarefas rejeitam (só o instalador WSL do Codex no Windows usa); sem notebooks; hunks inline do Claude (comments) não aparecem |
| propostas `chat.*`, `lm.*` | ausentes de propósito | `enabledApiProposals` não é honrado |

## Validação (10/10/2026, config. temporária = usuário deslogado)

| Verificação | Claude Code 2.1.296 | Codex 26.1007.21434 |
|---|---|---|
| `headless-check.js` (protocolo stdio real): ativa, resolve view, HTML + assets 200, preâmbulo antes do CSP | ok — `index.js` 5,5 MB + `index.css` | ok — 10 assets via `<base href>` (módulos ES) |
| Round trip sintético webview → extensão → webview | `request/init` → `from-extension/response/init_response` em ~135 ms | `ready` → `chat-font-settings` |
| `webkit-harness.py` (WebKitGTK offscreen, iframe real + relay igual ao do app) | renderiza a tela de login; 14 ↑ / 27 ↓ (init, get_claude_state, list_sessions, `launch_claude`, io_message…) | renderiza "Sign in with ChatGPT"; 151 ↑ / 124 ↓ (capn-rpc, persisted-atom, mcp-request/response, fetch) |
| Tema | `body.vscode-dark`, `--vscode-foreground`/`--vscode-focusBorder` = tokens Fluent | idem |
| **Hardening:** tempo até interativo após o "clique" (host + página quentes, cache de compilação quente; `webkit-harness.py` → `timings`) | ativada 181 ms, iframe pronto 514 ms, **interativo 608 ms** (antes: 247 / 1178 / 1253 ms com a página fria; 666 ms com a página quente) | ativada 213 ms, iframe pronto 940 ms; botões do login após a animação de abertura da própria UI (~5,4 s) |
| **Hardening:** `flows-check.js` (extensão real, CLI simulado no WebSocket MCP dela) | **19/19**: editor espelhado visto pelas ferramentas MCP, diff aceito (texto editado) e rejeitado pelos comandos da extensão, `close_tab`, terminal com shell integration, URI handler | — (o Codex não usa `vscode.diff`) |

Não validado aqui (fica para o teste no app): estado logado/conversa real (exigiria a configuração real do usuário e chamadas pagas) e o diff vindo do CHAT do Claude (fluxo `claude-vscode`, aceito via "salvar" o lado direito — coberto por teste unitário com extensão falsa). Login: o Claude **não** usa `vscode://` para login (o URI handler dele só trata `/open` e `/install-plugin`; o `claude` faz o OAuth com callback local/código); o Codex monta o callback dos conectores com `env.uriScheme` (`fluent-coder://openai.chatgpt/connector/oauth_callback`, roteado pelo deep link) e o login do ChatGPT usa callback em localhost do app-server.

## Varredura estática × shim (cobertura)

Gerada por `node tools/ext-host/discovery/coverage.js <claude>/extension.js <codex>/out/extension.js`.
Contagem de referências no bundle (não de chamadas em tempo de execução).
Estados: **implementado** · **parcial** (funciona com limitação) · **stub**
(existe, inerte) · **proposta** (fora de escopo) · **ausente**. Tipos de valor
e enums (Task, Notebook*) contam como implementados — o stub é o recurso que os
consome.

Caminhos: 123 (119 não propostos) · implementado 101 · parcial 14 · stub 4 · ausente 0 · proposta 4
Cobertura funcional (implementado+parcial / não propostos): 96.6% · presentes no shim: 100.0%

| API | anthropic.claude-code | openai.chatgpt | estado | observação |
|---|---:|---:|---|---|
| `chat.registerChatSessionItemProvider` | – | 1 | proposta | API proposta (enabledApiProposals não é honrado) |
| `CodeLens` | – | 1 | implementado |  |
| `commands.executeCommand` | 54 | 26 | implementado |  |
| `commands.getCommands` | 1 | – | parcial | só comandos registrados por extensões (sem os internos do VS Code) |
| `commands.registerCommand` | 32 | 10 | implementado |  |
| `comments.createCommentController` | 1 | – | stub | threads de comentário não aparecem no editor |
| `CommentThreadCollapsibleState` | 2 | – | implementado |  |
| `CommentThreadState` | 1 | – | implementado |  |
| `ConfigurationTarget` | 5 | 3 | implementado |  |
| `DiagnosticSeverity` | 1 | 9 | implementado |  |
| `Disposable` | 7 | 3 | implementado |  |
| `EndOfLine` | 1 | – | implementado |  |
| `env.appName` | 5 | 6 | implementado |  |
| `env.clipboard` | 4 | 3 | implementado |  |
| `env.isTelemetryEnabled` | 1 | – | implementado |  |
| `env.language` | – | 1 | implementado |  |
| `env.machineId` | 3 | – | implementado |  |
| `env.openExternal` | 3 | 1 | implementado |  |
| `env.remoteName` | 4 | 5 | implementado |  |
| `env.sessionId` | 2 | – | implementado |  |
| `env.shell` | 3 | – | implementado |  |
| `env.uiKind` | 1 | – | implementado |  |
| `env.uriScheme` | – | 1 | implementado |  |
| `EventEmitter` | 10 | 6 | implementado |  |
| `ExtensionMode` | 2 | – | implementado |  |
| `extensions.all` | 1 | – | implementado |  |
| `extensions.getExtension` | 4 | 2 | implementado |  |
| `FileChangeType` | 1 | – | implementado |  |
| `FileSystemError` | 6 | – | implementado |  |
| `FileType` | 1 | 2 | implementado |  |
| `l10n.t` | – | 3 | implementado |  |
| `languages.getDiagnostics` | 2 | 2 | implementado |  |
| `languages.onDidChangeDiagnostics` | 1 | – | implementado |  |
| `languages.registerCodeLensProvider` | – | 1 | implementado | lentes no Monaco; clique executa o comando da extensão |
| `lm.getModelProxy` | – | 1 | proposta | API proposta (enabledApiProposals não é honrado) |
| `lm.isModelProxyAvailable` | – | 2 | proposta | API proposta (enabledApiProposals não é honrado) |
| `lm.onDidChangeModelProxyAvailability` | – | 1 | proposta | API proposta (enabledApiProposals não é honrado) |
| `NotebookCellData` | 1 | – | implementado |  |
| `NotebookCellKind` | 1 | – | implementado |  |
| `NotebookCellOutputItem` | 2 | – | implementado |  |
| `NotebookEdit` | 1 | – | implementado |  |
| `NotebookEditorRevealType` | 1 | – | implementado |  |
| `NotebookRange` | 1 | – | implementado |  |
| `Position` | 5 | 4 | implementado |  |
| `ProgressLocation` | 1 | – | implementado |  |
| `Range` | 11 | 7 | implementado |  |
| `RelativePattern` | – | 1 | implementado |  |
| `Selection` | 6 | 2 | implementado |  |
| `ShellExecution` | – | 1 | implementado |  |
| `StatusBarAlignment` | 1 | – | implementado |  |
| `SymbolKind` | – | 26 | implementado |  |
| `TabInputCustom` | – | 2 | implementado |  |
| `TabInputText` | 2 | 1 | implementado |  |
| `TabInputTextDiff` | 8 | – | implementado |  |
| `TabInputWebview` | 2 | – | implementado |  |
| `Task` | – | 1 | implementado |  |
| `tasks.executeTask` | – | 1 | stub | rejeita: tarefas não suportadas |
| `tasks.onDidEndTaskProcess` | – | 1 | stub | nunca dispara |
| `TaskScope` | – | 1 | implementado |  |
| `TextDocumentChangeReason` | 4 | – | implementado |  |
| `TextEditorRevealType` | 6 | 1 | implementado |  |
| `ThemeColor` | 1 | – | implementado |  |
| `UIKind` | 1 | – | implementado |  |
| `Uri` | 43 | 32 | implementado |  |
| `version` | 2 | 4 | implementado |  |
| `ViewColumn` | 8 | 6 | implementado |  |
| `window.activeNotebookEditor` | 1 | – | stub | sem notebooks |
| `window.activeTerminal` | 1 | – | parcial | só os terminais criados por extensões |
| `window.activeTextEditor` | 11 | 6 | implementado |  |
| `window.createOutputChannel` | 1 | 1 | implementado |  |
| `window.createStatusBarItem` | 1 | – | implementado |  |
| `window.createTerminal` | 2 | 1 | implementado |  |
| `window.createTextEditorDecorationType` | 1 | 2 | parcial | cores/bordas/texto antes-depois; sem ícones de gutter |
| `window.createWebviewPanel` | 2 | 1 | parcial | aba na sidebar de agentes (não no grid de editores) |
| `window.onDidChangeActiveTextEditor` | 1 | 1 | implementado |  |
| `window.onDidChangeTerminalShellIntegration` | 2 | 1 | parcial | integração simulada ao criar o PTY (executeCommand = digitar a linha) |
| `window.onDidChangeTextEditorSelection` | 2 | 1 | implementado |  |
| `window.onDidChangeVisibleTextEditors` | 3 | – | implementado |  |
| `window.onDidChangeWindowState` | – | 1 | implementado |  |
| `window.onDidEndTerminalShellExecution` | 1 | – | parcial | nunca dispara (sem integração real de shell) |
| `window.onDidStartTerminalShellExecution` | 1 | – | parcial | dispara ao executeCommand da integração simulada |
| `window.registerCustomEditorProvider` | – | 1 | parcial | abre como painel na sidebar de agentes |
| `window.registerUriHandler` | 1 | 1 | implementado |  |
| `window.registerWebviewPanelSerializer` | 1 | – | parcial | registrado; painéis não são restaurados ao reiniciar o app |
| `window.registerWebviewViewProvider` | 3 | 2 | implementado |  |
| `window.setStatusBarMessage` | 6 | – | implementado |  |
| `window.showErrorMessage` | 12 | 2 | implementado |  |
| `window.showInformationMessage` | 19 | 5 | implementado |  |
| `window.showInputBox` | 3 | – | parcial | sem validateInput |
| `window.showOpenDialog` | – | 1 | implementado |  |
| `window.showQuickPick` | 2 | – | parcial | sem canPickMany/botões |
| `window.showSaveDialog` | – | 1 | implementado |  |
| `window.showTextDocument` | 6 | 1 | implementado |  |
| `window.showWarningMessage` | 4 | 1 | implementado |  |
| `window.state` | 1 | 1 | implementado |  |
| `window.tabGroups` | 27 | 2 | parcial | um grupo: abas de arquivo do app + abas de diff |
| `window.terminals` | 2 | – | parcial | só os terminais criados por extensões |
| `window.visibleTextEditors` | 6 | 1 | implementado |  |
| `window.withProgress` | 1 | – | parcial | texto na barra de status; sem cancelamento |
| `workspace.applyEdit` | 3 | – | implementado |  |
| `workspace.asRelativePath` | 3 | 3 | implementado |  |
| `workspace.createFileSystemWatcher` | – | 1 | implementado |  |
| `workspace.findFiles` | 2 | 2 | implementado |  |
| `workspace.fs` | 1 | 8 | implementado |  |
| `workspace.getConfiguration` | 23 | 3 | implementado |  |
| `workspace.getWorkspaceFolder` | 2 | 5 | implementado |  |
| `workspace.isTrusted` | – | 1 | implementado |  |
| `workspace.name` | – | 1 | implementado |  |
| `workspace.onDidChangeConfiguration` | 10 | 3 | implementado |  |
| `workspace.onDidChangeTextDocument` | 3 | 1 | implementado |  |
| `workspace.onDidChangeWorkspaceFolders` | 2 | 1 | implementado |  |
| `workspace.onDidCloseTextDocument` | 2 | – | implementado |  |
| `workspace.onDidOpenTextDocument` | 1 | – | implementado |  |
| `workspace.onDidSaveTextDocument` | 1 | – | implementado |  |
| `workspace.onWillSaveTextDocument` | 3 | – | implementado |  |
| `workspace.openTextDocument` | 12 | 4 | implementado |  |
| `workspace.registerFileSystemProvider` | 4 | – | implementado |  |
| `workspace.registerTextDocumentContentProvider` | 1 | – | implementado |  |
| `workspace.rootPath` | 1 | – | implementado |  |
| `workspace.textDocuments` | 7 | – | implementado |  |
| `workspace.workspaceFile` | 1 | – | implementado |  |
| `workspace.workspaceFolders` | 22 | 12 | implementado |  |
| `WorkspaceEdit` | 3 | – | implementado |  |
