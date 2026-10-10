# Extensões VS Code hospedadas — contratos

O Fluent Coder roda as extensões **reais** do Claude Code (`anthropic.claude-code`)
e do Codex (`openai.chatgpt`) instaladas pelo usuário no VS Code, mostra a
**própria UI de webview delas** dentro do app (tema Fluent) e as integra ao
editor, ao terminal, à revisão de diffs, à Paleta e à barra de status. Não é
reimplementação da UI e não é um VS Code Server embutido.

Pesquisa/cobertura da API: [docs/research/vsix-api-surface.md](../research/vsix-api-surface.md).

## Arquitetura

```
App (React)
 ├─ ExtensionHostRuntime (GLOBAL, montado 1× no App)      ← editor, diffs, terminais, diálogos, saída, status bar, deep links
 │    ├─ editorBridge.ts  (eventos do Monaco ⇄ TextDocument/TextEditor)
 │    ├─ terminalBridge.ts (createTerminal ⇄ TerminalPanel/PTY)
 │    └─ diffs.ts + useExtensionDiffs (vscode.diff ⇄ ClaudeDiffReview)
 └─ ExtensionDock → ExtensionWebview <iframe>             ← só abas/webviews
        │ window.postMessage (relay validado: origem + contentWindow + handle + tipo)
        ▼
src/extensions/client.ts ──invoke(ext_host_send)──▶ Rust src-tauri/src/ext_host/ ──stdin──▶ node tools/ext-host/main.js
                         ◀─evento ext-host://message──  (linhas JSON do stdout) ◀──stdout──┘   │ valida (src/protocol.js)
                                                     │                                        │ require('vscode') → shim
                                       {"event":"secrets"…} → cofre do SO (secrets.rs)        ▼
                                                                          extensão real (~/.vscode/extensions/…)
                                                                          + servidor HTTP 127.0.0.1:<porta>/<token>/
```

- **Sidecar Node** (`tools/ext-host/`, CommonJS puro, sem dependências):
  `main.js` (protocolo stdio), `src/host.js` (estado), `src/shim/*` (API
  `vscode`: `api.js`, `documents.js`, `terminal.js`, `watcher.js`,
  `memento.js`, `webview.js`, `configuration.js`, `types.js`),
  `src/server.js` (HTTP), `src/preamble.js` (injeção no HTML),
  `src/protocol.js` (validação), `src/when.js` (cláusulas `when`),
  `src/contributions.js` (`contributes`). `require('vscode')` é interceptado em
  `Module._load`; cada extensão recebe o próprio objeto de API.
- **stdout do sidecar é exclusivo do protocolo.** `process.stdout.write` é
  desviado para o stderr antes de carregar qualquer extensão. Nunca escrever no
  stdout fora de `send()` em `main.js`.
- **Backend Rust** (`src-tauri/src/ext_host/`): `mod.rs` (processo + relay),
  `node.rs` (localizar o Node), `secrets.rs` (cofre do SO), `deep_link.rs`
  (`fluent-coder://`). Comandos: `ext_host_start`, `ext_host_send`,
  `ext_host_stop`, `ext_host_open_external` (só `http(s)`/`mailto`),
  `deep_link_take_pending`, `deep_link_ack`.
- **Dados do host** em `<app_data_dir>/ext-host/`: `settings.json` (overrides —
  **nunca** o settings do VS Code), `extensions/<id>/` (globalState,
  workspaceState, `secret-keys.json` = só os NOMES dos segredos, globalStorage),
  `logs/`, `machine-id`, `server-port` (porta preferida), `compile-cache/`.

## Protocolo (JSON por linha)

App → host `{id?, method, params}` (id numérico ou string `"<janela>:<n>"` —
várias janelas compartilham o sidecar e cada uma só resolve as próprias
respostas); respostas `{id, result|error}`; eventos `{event, …}`.

| Grupo | Métodos app → host |
|---|---|
| ciclo de vida | `initialize` (workspaceFolders, dataDir, language, `secrets: "keyring"`, debugWebviews), `listInstalled`, `loadExtension`, `activate`, `shutdown` |
| webviews | `resolveView`, `webviewMessage`, `webviewState`, `webviewVisible`, `webviewUrl`, `disposeWebview`, `setTheme` |
| editor | `documentOpened`, `documentChanged` (mudanças incrementais 0-based + versão + dirty + undo/redo), `documentClosed`, `documentSaved`, `editorsChanged` (ativo, visíveis, abas), `selectionChanged`, `visibleRangesChanged`, `diagnostics`, `windowState` |
| ações | `executeCommand`, `listCommands`, `runKeybinding`, `diffAction` (accept/reject + texto final), `diffClosed`, `terminalOpened` (pid), `terminalClosed` (exitCode), `handleUri`, `provideCodeLenses`, `executeCodeLens`, `respond`, `setWorkspaceFolders` |

Eventos host → app: `postMessage`, `webviewHtml`, `webviewPanelCreated`,
`webviewTitle`, `webviewDisposed`, `revealWebview`, `revealView`, `context`,
`request` (showMessage, quickPick, inputBox, openDialog, saveDialog, **applyEdit**,
**saveDocument**, **clipboardRead** → o app responde com `respond`), `openFile`
(com seleção), `openVirtualDocument`, `diff`/`closeDiff`, `setSelection`,
`revealRange`, `decorationType`/`decorations`/`decorationTypeDisposed`,
`extDiagnostics`, `statusBarItem`, `statusMessage`, `output`/`outputShow`,
`terminalCreate`/`terminalShow`/`terminalSendText`/`terminalDispose`,
`closeEditor`, `appCommand`, `codeLensProviders`/`codeLensChanged`,
`openExternal`, `clipboardWrite`, `filesChanged`, `extensionLoaded`,
`extensionActivated` (com ms), `log`.

## Regras de segurança (obrigatórias)

1. **Servidor de recursos só em `127.0.0.1`**, token aleatório de 128 bits
   por sessão no caminho (`/<token>/…`; sem token → 404). Só `GET`/`HEAD`.
2. **Recursos só de raízes permitidas** (pasta da extensão, `localResourceRoots`,
   pastas do workspace), checadas no caminho normalizado **e no realpath**
   (symlink para fora → 403). Separador codificado (`%2F`, `%5C`) ou NUL no
   caminho → 400. Nunca servir fora disso.
3. **CORS só para a própria origem** do servidor (os iframes dos webviews);
   nada de `Access-Control-Allow-Origin: *`. `X-Content-Type-Options:
   nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
   same-site`. HTML do webview com `Cache-Control: no-store`.
4. **CSP da extensão não é alterado.** O preâmbulo entra como primeiro filho
   do `<head>`, antes do `<meta http-equiv=CSP>` (um CSP via `<meta>` só vale
   para o que vem depois), então roda sem nonce **sem afrouxar** o CSP.
5. **iframe com `sandbox` mínimo**: `allow-scripts allow-same-origin
   allow-forms allow-pointer-lock allow-downloads` (o conjunto do VS Code; sem
   `allow-popups`/`allow-modals`; `allow-forms` sai se `enableForms: false`),
   `allow="clipboard-read; clipboard-write"`, `referrerPolicy="no-referrer"`.
   `allow-same-origin` é seguro porque a origem do iframe (127.0.0.1:porta) é
   diferente da do app — o iframe não alcança `window.__TAURI__` nem o DOM do
   app. **Nenhuma integração Node/Tauri no webview.** `window.open` e links
   web saem pelo relay para o navegador do sistema.
6. **Toda mensagem cruzando fronteira é validada**:
   - iframe → app: `parseIframeMessage` (fonte = `contentWindow` do iframe,
     origem do host, `handle` esperado, tipo conhecido; `key` com tecla ≤ 32
     chars; `clipboard` com op `write`/`read` e texto ≤ 16 MB);
   - app → Rust: `ext_host_send` só aceita objeto JSON com `"method"`, sem
     quebra de linha, ≤ 64 MB;
   - Rust → sidecar / app → sidecar: `validateMessage` (método conhecido +
     parâmetros no formato; caminhos sem NUL; faixas não negativas;
     `handleUri` só `fluent-coder://`/`vscode://`);
   - sidecar → Rust (segredos): conta `<publisher.nome>/<chave>` validada,
     valor ≤ 64 KB;
   - deep link: só `fluent-coder://<publisher>.<nome>/…`, sem espaço/controle,
     ≤ 8 KB.
7. **Saídas externas**: `openExternal` só `http(s)`/`mailto` (Rust recusa o
   resto); `fluent-coder:`/`vscode:` viram `handleUri` interno.
8. **Segredos no cofre do SO** (Secret Service no Linux, Keychain no macOS,
   Credential Manager no Windows) via crate `keyring`. Os segredos nunca vão ao
   frontend (o Rust desvia as linhas `{"event":"secrets"…}`). Arquivo JSON
   `0600` só como **fallback** se o cofre falhar (registrado na saída
   "Extensões"). Segredos antigos em `secrets.json` são **migrados** para o
   cofre na 1ª operação e o arquivo é apagado.
9. **Nada da configuração real do usuário é escrito** (`~/.vscode`,
   `~/.claude/settings.json`, `~/.codex`): a extensão é lida da pasta
   instalada (somente leitura) e o estado do host fica no `app_data_dir`.
10. **Terminais de extensão**: env com nomes válidos (sem `=`/NUL);
    `shellPath` precisa existir no PATH (`which`); `strictEnv` respeitado.
11. **Estilos de decoração** viram CSS no app: só propriedades conhecidas e
    valores sem `; { } < > \` (`sanitizeDecorationOptions` no sidecar e
    `renderDecorationType` no app).

## Desempenho

- **Prewarm**: o `ExtensionHostRuntime` sobe o Node + servidor ~1,2 s após o
  startup (ocioso). As extensões **só ativam ao abrir a view** — ou ao passar
  o ponteiro/foco na aba (`extHost.prewarm`), o que adianta a ativação.
- **Cache de compilação do V8** (`module.enableCompileCache`, Node 22.1+) em
  `<dataDir>/compile-cache`: o `require` dos bundles grandes cai ~30–35% a
  partir da 2ª sessão.
- **Recursos** da pasta da extensão com `Cache-Control: immutable` + `ETag`
  (304); porta preferida persistida (origem estável entre sessões quando livre).
- **Sem polling**: o editor é espelhado por eventos do Monaco (o snapshot de
  400 ms do PoC foi removido). Conteúdo vai incremental; seleção/abas com
  debounce de 40 ms; rolagem 150 ms; diagnósticos 300 ms e só dos recursos que
  mudaram. Nada é espelhado antes de alguma extensão ativar.
- Medição: `python3 tools/ext-host/scripts/webkit-harness.py claude` imprime
  `timings` (ms desde o "clique": `activated`, `resolved`, `iframeReady`,
  `interactive`) com o host e a página já quentes, como no app.

## Webview no iframe

- HTML de `webview.html` em `http://127.0.0.1:<porta>/<token>/wv/<handle>/index.html`;
  `asWebviewUri` → `/<token>/res/<caminho absoluto>`; `cspSource` = origem.
- **Relay:** o preâmbulo envia ao pai `{__fluentExt:1, handle, type}`
  (`message`, `setState`, `ready`, `link`, `key`, `clipboard`). Mensagens da
  extensão vão **cruas** ao iframe (como no VS Code); controle do app
  (`theme`, `clipboardText`) leva `__fluentCtl:1` e é consumido pelo preâmbulo.
  Mensagens antes do `ready` ficam retidas (`PendingQueue`).
- `getState/setState`: o estado volta embutido no preâmbulo quando o iframe
  recarrega (retainContextWhenHidden aproximado).
- **Tema:** `src/extensions/theme.ts` mapeia os tokens Fluent em ~150
  variáveis `--vscode-*`. Ao mudar tokens do app, revisar o mapa.
- **Teclado:** atalhos com Ctrl/Cmd (exceto edição: A/C/V/X/Z/Y, setas,
  Home/End, Backspace/Delete, Enter, Tab, espaço) e F1–F12 que a extensão
  **não** tratou (`defaultPrevented`) sobem ao app: primeiro os `keybindings`
  contribuídos pelas extensões (contexto `webviewFocus`), senão o atalho é
  re-disparado no documento do app (Paleta, Ctrl+P, Ctrl+B, Ctrl+`…).
- **Área de transferência:** `navigator.clipboard` nativo primeiro; se o
  WebKitGTK recusar, o app faz a operação (`clipboard` → `clipboardText`);
  seleção copiada/recortada também é espelhada no clipboard do app.

## Integração com o editor

- Abas no topo da sidebar secundária (o Fluent Chat): as abas nativas
  **Chat** e **Agentes** (prop `nativeTabs` do `ExtensionDock`; ver
  [Fluent Chat](agentes-ia.md)) | uma aba por extensão suportada instalada |
  painéis (`createWebviewPanel`) abertos pelas extensões, fecháveis. Aba
  lembrada em `ui.agentsDockTab`; `requestedTab` foca uma aba de fora (Paleta).
  Sem extensões/Node, só as abas nativas aparecem.
- Em `npm run tauri dev` (DEV), cada webview mostra um rodapé
  `↑ N (tipo) · ↓ M (tipo)` com os contadores do relay, e o console do app
  registra `[ext-host] webview→ext …` / `ext→webview …`; o stderr do processo
  Tauri mostra `[ext-host:<pid>] …` (logs do host com `debugWebviews`).
- `TextDocument` de arquivo aberto no Monaco = espelho do modelo (versão,
  dirty pela `alternativeVersionId` vs. a salva, `onDidChangeTextDocument`
  com `contentChanges` e `reason` undo/redo). Arquivo não aberto = disco +
  watcher.
- `TextEditor.edit` / `insertSnippet` / `WorkspaceEdit` / `workspace.applyEdit`
  com app conectado: o **app aplica no modelo** (`pushEditOperations`, com
  paradas de undo), a aba fica suja e o salvar é o do app. Arquivo fechado é
  aberto antes (como o VS Code). Criar/renomear/apagar arquivos vão ao disco
  (+ `onDidCreate/Rename/DeleteFiles`). Sem app (headless) → disco.
- `showTextDocument` (seleção/preview/preserveFocus), `TextEditor.selection(s)`
  (setter), `revealRange` → editor do app.
- Decorações → `model.deltaDecorations` + CSS gerado (`.extd-<chave>`),
  `ThemeColor` resolvido pelo mapa do tema.
- `languages.getDiagnostics`/`onDidChangeDiagnostics` = markers do Monaco
  (exceto os `ext:*`) + coleções das extensões; coleções viram markers
  `ext:<nome>` no app.
- `createFileSystemWatcher`: `fs.watch` por pasta (Linux pula `node_modules`,
  `.git`, `target`, `bin`, `obj`, `dist`…; teto de 4 000 pastas), eventos
  coalescidos em 50 ms; `RelativePattern` com base fora do workspace funciona.
- `workspace.fs` completo (stat com permissões, read/write/readDirectory,
  createDirectory, delete, rename/copy com `overwrite`, providers de esquema).
- CodeLens das extensões (ex.: "Implement with Codex" em TODOs) no Monaco;
  clique executa o comando delas.

## Diffs propostos (Claude Code)

`vscode.diff(left, right, title)` → evento `diff` → a **mesma revisão** da
ponte IDE (`ClaudeDiffReview`, sobre a área do editor; lado direito editável).
Como no VS Code: a aba `TabInputTextDiff` vira a ativa e os dois lados entram
em `visibleTextEditors` (o Claude liga `claude-code.viewingProposedDiff` assim).

- **Aceitar** (Ctrl+Enter): `diffAction accept` com o texto final → o host
  atualiza o documento do lado direito (`onDidChangeTextDocument`) e executa o
  comando do menu `editor/title` da extensão cujo `when` vale (ex.:
  `claude-code.acceptProposedDiff`). Sem comando aplicável e
  `files.autoSave = off` (padrão), "salva" o lado direito
  (`onWillSave`/`onDidSave`) — o fluxo do chat do Claude aceita assim.
- **Rejeitar** (Esc): comando de rejeitar da extensão, senão fecha a aba
  (que o VS Code também trata como rejeição).
- A revisão some quando a decisão é entregue; a aba do diff no host fecha
  quando a extensão/CLI pedir (`close_tab` → `closeDiff`). Um clique antes de
  400 ms da abertura espera (a extensão só escuta depois de ver a aba).
- Fila única com os diffs da ponte IDE (estes primeiro).

## Terminal

`window.createTerminal` → aba real no TerminalPanel (PTY em `terminal.rs`,
com `shellPath`/`shellArgs`/`env`/`strictEnv`; o `environmentVariableCollection`
da extensão é aplicado — o `CLAUDE_CODE_SSE_PORT` dela tem precedência sobre o
da ponte IDE). `show` abre o painel e foca; `sendText` (retido até o PTY
existir); `dispose`/fechar a aba → `onDidCloseTerminal` com `exitStatus`;
saída do processo → aba "(encerrado)". `processId` = pid do PTY. **Shell
integration simulada**: ao criar o PTY o terminal ganha `shellIntegration`
(`executeCommand` digita a linha e dispara `onDidStartTerminalShellExecution`;
`onDidEnd…` nunca dispara). O "Abrir no terminal" do Claude sai na hora em vez
de esperar 3 s.

## URI handler e deep links

- `env.uriScheme = "fluent-coder"`. Esquema registrado pelo
  `tauri-plugin-deep-link` (`tauri.conf.json` → `plugins.deep-link`), que grava
  o MimeType/registro/Info.plist no bundle; fora do dev o app também chama
  `register` se o esquema não estiver associado (AppImage). Em dev, só com
  `FLUENT_REGISTER_DEEP_LINK=1`.
- Linux/Windows abrem um processo novo com a URL: ele repassa à instância
  aberta pelo socket local (`deep-link.json` 0600 com porta + token) e sai;
  sem instância, o próprio processo abre e entrega ao montar
  (`deep_link_take_pending`). macOS: `on_open_url` do plugin.
- `fluent-coder://<publisher.nome>/…` → `handleUri` ativa a extensão dona
  (onUri) e chama o `registerUriHandler` dela.
- **Login:** o Claude Code **não** usa `vscode://` para login (o `claude` faz o
  OAuth sozinho, com callback local/código); o URI handler dele trata
  `/open` (abrir sessão) e `/install-plugin`. O Codex monta o callback dos
  conectores com `env.uriScheme` → `fluent-coder://openai.chatgpt/connector/oauth_callback`
  volta para nós; o login do ChatGPT em si usa callback em localhost do
  app-server.

## Robustez

- **Mensagens app → webview chegam com a origem da própria página.** No VS
  Code o conteúdo recebe mensagens de um frame da mesma origem; aqui o pai é
  o app (outra origem). O preâmbulo reemite o que vem de `window.parent` com
  `origin = location.origin` — o Codex filtra por `event.origin` e, sem isso,
  travava no handshake ("Codex could not start its user interface"). Só o
  pai é reemitido (outro frame não se passa pelo app). Regressão:
  `webkit-harness.py codex --cross-origin` (pai em `localhost:1420`, como no
  app) tem de passar do handshake.
- **Nunca deixar órfãos.** No Unix o host sobe como líder de grupo
  (`process_group(0)`); ao encerrar ele sinaliza o grupo inteiro, levando os
  filhos das extensões (`claude`, `codex app-server`). O `deactivate()` tem
  teto de 2 s (uma extensão travada não segura o processo); erro de escrita no
  stdout (EPIPE: o app morreu) encerra o host em vez de cair em loop no
  `uncaughtException`; e um vigia encerra se o `ppid` mudar. Regressão:
  `npm run ext-host:orphan-check` (fecha todos os pipes com as extensões
  ativas e exige o grupo vazio em ≤ 6 s).
- A ponte IDE nativa **não publica o lock** enquanto a extensão Claude Code
  está ativa no host (ela publica o próprio "Fluent Coder"): o `/ide` lista uma
  entrada só. Volta a publicar quando o host cai. Ao iniciar, a ponte remove
  locks "Fluent Coder" de processos mortos.
- Queda do sidecar não pedida → reinício automático com backoff (1 s, 2 s,
  4 s… 30 s; desiste após 5 quedas em 2 min), extensões ativas são reativadas
  e as views re-resolvidas (`hostRestarted`).
- Paleta: **"Reiniciar Host de Extensões"** e **"Extensões: Mostrar Saída do
  Host"**; comandos contribuídos com os títulos do `package.json`.
- Saída "Extensões" (aba Saída): ciclo de vida, tempos de ativação, logs e
  erros do host; os output channels das extensões viram canais próprios
  ("Claude Code", "Codex"…), em lote a cada 250 ms (teto de 256 KB por janela).
- `contributes`: comandos (Paleta), `configuration` (defaults + padrões do
  core como `files.autoSave`), `keybindings` (best effort: no editor só os de
  `editorTextFocus`; no webview, todos), `menus.editor/title` (diff),
  `views`/`viewsContainers` (metadados). Itens de barra de status
  (`createStatusBarItem`, `setStatusBarMessage`, `withProgress`) aparecem na
  barra do app, com `$(ícone)` e comando.

## Empacotamento

- `node`: `FLUENT_NODE` → PATH → fnm (`$FNM_DIR`, `~/.local/share/fnm`) → nvm
  (`$NVM_DIR`, `~/.nvm`, `%NVM_HOME%`) → volta/asdf/mise → `/usr/local/bin`,
  `/opt/homebrew/bin`, `/usr/bin`, `/snap/bin`, `%ProgramFiles%\nodejs`. Versão
  mínima 18 (checada com `--version`); erro em pt-BR com o que fazer.
- `tools/ext-host` vai no bundle como recurso (`tauri.conf.json` →
  `bundle.resources`: `main.js`, `package.json`, `src/*.js`, `src/shim/*.js`);
  `find_script` procura `FLUENT_EXT_HOST_SCRIPT` → recursos → árvore do repo
  (dev). O Node **não** é empacotado (usa o do usuário).

## Licenciamento

Carregamos a extensão **instalada localmente pelo usuário**, direto de
`~/.vscode/extensions/` (somente leitura) — nada é copiado, empacotado ou
redistribuído. Não incluir VSIX de terceiros no bundle.

## API para outras partes do app

`src/extensions/index.ts`: `ExtensionDock` (props estáveis `rootPath`,
`agentsNode`), `ExtensionWebview` (renderizar um webview resolvido em outro
layout), `ExtensionHostRuntime`, `ExtensionStatusItems`, `useExtensionDiffs`,
`useHostedExtensions`, `listHostedExtensions`, `openExtensionView(id)`,
`prewarmExtension(id)`, `restartExtensionHost()`, `onExtensionHostEvent`,
`extensionPaletteCommands`.

## Aceite

- Unitários: `npm run test:unit` (inclui `tools/ext-host/test/*.test.js` e
  `src/extensions/*.test.ts`); Rust: `cargo test` (`ext_host::*`; o teste do
  cofre real é `cargo test --lib roundtrip_in_os_keyring -- --ignored`).
- Headless pelo protocolo real: `npm run ext-host:check` (ativa, resolve a
  view, HTML + assets 200, round trip).
- **Fluxos com a extensão real do Claude Code**:
  `node tools/ext-host/scripts/flows-check.js` (espera 19/19): editor
  espelhado visto pelas ferramentas MCP da extensão (`getOpenEditors`,
  `getCurrentSelection`, `getDiagnostics`, `checkDocumentDirty`), `openDiff` →
  aceitar com texto editado (FILE_SAVED) e rejeitar (DIFF_REJECTED) pelos
  comandos da extensão, `close_tab` → `closeDiff`, terminal com shell
  integration, `fluent-coder://anthropic.claude-code/open`.
- Render em WebKitGTK: `python3 tools/ext-host/scripts/webkit-harness.py
  claude|codex --png out.png [--theme-file tema.json] [--data-dir dir]`.
- Sempre com `CLAUDE_CONFIG_DIR`/`CODEX_HOME` temporários (a UI cai no login);
  sem prompts a modelos.
- Descoberta da API após atualizar uma extensão: `tools/ext-host/discovery/`
  (`run.js`, `coverage.js`) e atualizar `docs/research/vsix-api-surface.md`.
