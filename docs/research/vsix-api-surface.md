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

## O que é stub / lacuna no shim (PoC)

| Área | Estado | Impacto |
|---|---|---|
| `window.createTerminal` | stub (sem PTY); `sendText`/`show` viram eventos `terminalSendText`/`terminalShow` | comando "Abrir no terminal" do Claude não abre terminal real |
| `window.showMessage` (com botões)/`showQuickPick`/`showInputBox`/`showOpenDialog`/`showSaveDialog` | encaminhados ao app como `request`; o app usa `ConfirmDialog`, `QuickPick`, `QuickInput` e o diálogo nativo do Tauri. Sem o dock montado, o pedido fica pendente | `canPickMany`, botões/validação do input box não suportados |
| `TextEditor.edit`, `insertSnippet`, decorações | não suportados (retornam `false`/no-op) | inserção direta no editor indisponível |
| `workspace.applyEdit` | aplica no **disco** e emite `filesChanged` (o app recarrega) | buffers sujos no Monaco podem divergir |
| `workspace.createFileSystemWatcher` | eventos nunca disparam | extensões não percebem mudanças externas |
| `languages.getDiagnostics` | sempre vazio (o app ainda não publica diagnósticos) | contexto de erros não chega ao agente |
| `authentication`, `tasks`, `debug`, `notebooks`, `scm`, `comments` | stubs inertes | — |
| `secrets` | JSON 0600 no dataDir do host (não usa keyring do SO) | aceitável só para PoC |
| propostas `chat.*`, `lm.*` | **ausentes de propósito** (`enabledApiProposals` não é honrado) | Codex registra "chat session item provider not registered" e segue |
| `vscode.diff` | resolve os dois lados (inclusive esquemas virtuais via providers da extensão) e emite `diff` com conteúdo; fechar via `tabGroups.close` emite `closeDiff` | aceitar/rejeitar diff do Claude depende de comandos da extensão (`claude-vscode.acceptProposedDiff`) |

## Validação (10/10/2026, config. temporária = usuário deslogado)

| Verificação | Claude Code 2.1.296 | Codex 26.1007.21434 |
|---|---|---|
| `headless-check.js` (protocolo stdio real): ativa, resolve view, HTML + assets 200, preâmbulo antes do CSP | ok — `index.js` 5,5 MB + `index.css` | ok — 10 assets via `<base href>` (módulos ES) |
| Round trip sintético webview → extensão → webview | `request/init` → `from-extension/response/init_response` em ~135 ms | `ready` → `chat-font-settings` |
| `webkit-harness.py` (WebKitGTK offscreen, iframe real + relay igual ao do app) | renderiza a tela de login; 14 ↑ / 27 ↓ (init, get_claude_state, list_sessions, `launch_claude`, io_message…) | renderiza "Sign in with ChatGPT"; 151 ↑ / 124 ↓ (capn-rpc, persisted-atom, mcp-request/response, fetch) |
| Tema | `body.vscode-dark`, `--vscode-foreground`/`--vscode-focusBorder` = tokens Fluent | idem |

Não validado aqui (fica para o teste no app): estado logado/conversa real (exigiria a configuração real do usuário e chamadas pagas), fluxos de login OAuth (Claude usa `env.openExternal` + URI handler `vscode://` — nosso `uriScheme` é `fluent-coder` e o SO não roteia esse esquema; o login do Codex usa callback em localhost pelo app-server), diff proposto do Claude (`vscode.diff` → modal).

## Varredura estática × shim

Contagem de referências no bundle (não de chamadas em tempo de execução). "ok" = existe no shim (pode ser stub, ver tabela acima).

| API | anthropic.claude-code | openai.chatgpt | shim |
|---|---:|---:|---|
| `chat.registerChatSessionItemProvider` | – | 1 | ausente |
| `CodeLens` | – | 1 | ok |
| `commands.executeCommand` | 54 | 26 | ok |
| `commands.getCommands` | 1 | – | ok |
| `commands.registerCommand` | 32 | 10 | ok |
| `comments.createCommentController` | 1 | – | ok |
| `CommentThreadCollapsibleState` | 2 | – | ok |
| `CommentThreadState` | 1 | – | ok |
| `ConfigurationTarget` | 5 | 3 | ok |
| `DiagnosticSeverity` | 1 | 9 | ok |
| `Disposable` | 7 | 3 | ok |
| `EndOfLine` | 1 | – | ok |
| `env.appName` | 5 | 6 | ok |
| `env.clipboard` | 4 | 3 | ok |
| `env.isTelemetryEnabled` | 1 | – | ok |
| `env.language` | – | 1 | ok |
| `env.machineId` | 3 | – | ok |
| `env.openExternal` | 3 | 1 | ok |
| `env.remoteName` | 4 | 5 | ok |
| `env.sessionId` | 2 | – | ok |
| `env.shell` | 3 | – | ok |
| `env.uiKind` | 1 | – | ok |
| `env.uriScheme` | – | 1 | ok |
| `EventEmitter` | 10 | 6 | ok |
| `ExtensionMode` | 2 | – | ok |
| `extensions.all` | 1 | – | ok |
| `extensions.getExtension` | 4 | 2 | ok |
| `FileChangeType` | 1 | – | ok |
| `FileSystemError` | 6 | – | ok |
| `FileType` | 1 | 2 | ok |
| `l10n.t` | – | 3 | ok |
| `languages.getDiagnostics` | 2 | 2 | ok |
| `languages.onDidChangeDiagnostics` | 1 | – | ok |
| `languages.registerCodeLensProvider` | – | 1 | ok |
| `lm.getModelProxy` | – | 1 | ausente |
| `lm.isModelProxyAvailable` | – | 2 | ausente |
| `lm.onDidChangeModelProxyAvailability` | – | 1 | ausente |
| `NotebookCellData` | 1 | – | ok |
| `NotebookCellKind` | 1 | – | ok |
| `NotebookCellOutputItem` | 2 | – | ok |
| `NotebookEdit` | 1 | – | ok |
| `NotebookEditorRevealType` | 1 | – | ok |
| `NotebookRange` | 1 | – | ok |
| `Position` | 5 | 4 | ok |
| `ProgressLocation` | 1 | – | ok |
| `Range` | 11 | 7 | ok |
| `RelativePattern` | – | 1 | ok |
| `Selection` | 6 | 2 | ok |
| `ShellExecution` | – | 1 | ok |
| `StatusBarAlignment` | 1 | – | ok |
| `SymbolKind` | – | 26 | ok |
| `TabInputCustom` | – | 2 | ok |
| `TabInputText` | 2 | 1 | ok |
| `TabInputTextDiff` | 8 | – | ok |
| `TabInputWebview` | 2 | – | ok |
| `Task` | – | 1 | ok |
| `tasks.executeTask` | – | 1 | ok |
| `tasks.onDidEndTaskProcess` | – | 1 | ok |
| `TaskScope` | – | 1 | ok |
| `TextDocumentChangeReason` | 4 | – | ok |
| `TextEditorRevealType` | 6 | 1 | ok |
| `ThemeColor` | 1 | – | ok |
| `UIKind` | 1 | – | ok |
| `Uri` | 43 | 32 | ok |
| `version` | 2 | 4 | ok |
| `version.split` | 1 | – | ok |
| `ViewColumn` | 8 | 6 | ok |
| `window.activeNotebookEditor` | 1 | – | ok |
| `window.activeTerminal` | 1 | – | ok |
| `window.activeTextEditor` | 11 | 6 | ok |
| `window.createOutputChannel` | 1 | 1 | ok |
| `window.createStatusBarItem` | 1 | – | ok |
| `window.createTerminal` | 2 | 1 | ok |
| `window.createTextEditorDecorationType` | 1 | 2 | ok |
| `window.createWebviewPanel` | 2 | 1 | ok |
| `window.onDidChangeActiveTextEditor` | 1 | 1 | ok |
| `window.onDidChangeTerminalShellIntegration` | 2 | 1 | ok |
| `window.onDidChangeTextEditorSelection` | 2 | 1 | ok |
| `window.onDidChangeVisibleTextEditors` | 3 | – | ok |
| `window.onDidChangeWindowState` | – | 1 | ok |
| `window.onDidEndTerminalShellExecution` | 1 | – | ok |
| `window.onDidStartTerminalShellExecution` | 1 | – | ok |
| `window.registerCustomEditorProvider` | – | 1 | ok |
| `window.registerUriHandler` | 1 | 1 | ok |
| `window.registerWebviewPanelSerializer` | 1 | – | ok |
| `window.registerWebviewViewProvider` | 3 | 2 | ok |
| `window.setStatusBarMessage` | 6 | – | ok |
| `window.showErrorMessage` | 12 | 2 | ok |
| `window.showInformationMessage` | 19 | 5 | ok |
| `window.showInputBox` | 3 | – | ok |
| `window.showOpenDialog` | – | 1 | ok |
| `window.showQuickPick` | 2 | – | ok |
| `window.showSaveDialog` | – | 1 | ok |
| `window.showTextDocument` | 6 | 1 | ok |
| `window.showWarningMessage` | 4 | 1 | ok |
| `window.state` | 1 | 1 | ok |
| `window.tabGroups` | 27 | 2 | ok |
| `window.terminals` | 2 | – | ok |
| `window.visibleTextEditors` | 6 | 1 | ok |
| `window.withProgress` | 1 | – | ok |
| `workspace.applyEdit` | 3 | – | ok |
| `workspace.asRelativePath` | 3 | 3 | ok |
| `workspace.createFileSystemWatcher` | – | 1 | ok |
| `workspace.findFiles` | 2 | 2 | ok |
| `workspace.fs` | 1 | 8 | ok |
| `workspace.getConfiguration` | 23 | 3 | ok |
| `workspace.getWorkspaceFolder` | 2 | 5 | ok |
| `workspace.isTrusted` | – | 1 | ok |
| `workspace.name` | – | 1 | ok |
| `workspace.onDidChangeConfiguration` | 10 | 3 | ok |
| `workspace.onDidChangeTextDocument` | 3 | 1 | ok |
| `workspace.onDidChangeWorkspaceFolders` | 2 | 1 | ok |
| `workspace.onDidCloseTextDocument` | 2 | – | ok |
| `workspace.onDidOpenTextDocument` | 1 | – | ok |
| `workspace.onDidSaveTextDocument` | 1 | – | ok |
| `workspace.onWillSaveTextDocument` | 3 | – | ok |
| `workspace.openTextDocument` | 12 | 4 | ok |
| `workspace.registerFileSystemProvider` | 4 | – | ok |
| `workspace.registerTextDocumentContentProvider` | 1 | – | ok |
| `workspace.rootPath` | 1 | – | ok |
| `workspace.textDocuments` | 7 | – | ok |
| `workspace.workspaceFile` | 1 | – | ok |
| `workspace.workspaceFolders` | 22 | 12 | ok |
| `WorkspaceEdit` | 3 | – | ok |
