# Extensões VS Code hospedadas (PoC) — contratos

Prova de conceito de um **mini extension host**: o Fluent Coder roda as
extensões **reais** do Claude Code (`anthropic.claude-code`) e do Codex
(`openai.chatgpt`) instaladas pelo usuário no VS Code e mostra a **própria UI
de webview delas** dentro do app, com o tema Fluent. Não é reimplementação da
UI e não é um VS Code Server embutido.

Pesquisa da superfície da API: [docs/research/vsix-api-surface.md](../research/vsix-api-surface.md).

## Arquitetura

```
React (ExtensionDock → ExtensionWebview <iframe>)
   │  window.postMessage  (relay validado: origem + contentWindow + handle)
   ▼
src/extensions/client.ts ──invoke(ext_host_send)──▶ Rust src-tauri/src/ext_host.rs ──stdin──▶ node tools/ext-host/main.js
                         ◀─evento ext-host://message── (1 linha JSON do stdout)  ◀──stdout──┘
                                                                                          │ require('vscode') → shim
                                                                                          ▼
                                                     extensão real (~/.vscode/extensions/…/extension.js)
                                                     + servidor HTTP 127.0.0.1:<porta aleatória>/<token>/
```

- **Sidecar Node** (`tools/ext-host/`, CommonJS puro, sem dependências):
  `main.js` (protocolo stdio), `src/host.js` (estado compartilhado), `src/shim/*`
  (API `vscode`), `src/server.js` (HTTP), `src/preamble.js` (injeção no HTML).
  `require('vscode')` é interceptado em `Module._load`; cada extensão recebe o
  próprio objeto de API (resolvido pelo caminho do módulo que pediu).
- **stdout do sidecar é exclusivo do protocolo.** `process.stdout.write` é
  desviado para o stderr antes de carregar qualquer extensão (elas usam
  `console.log` — o Claude Code imprime "Created lock file…"). Nunca escrever no
  stdout fora de `send()` em `main.js`.
- **Backend Rust** só transporta: `ext_host_start` (localiza `node` no PATH ou
  `FLUENT_NODE`; script em `FLUENT_EXT_HOST_SCRIPT`, recursos ou árvore do
  repo — **só dev por enquanto**), `ext_host_send`, `ext_host_stop`,
  `ext_host_open_external` (só `http(s)`/`mailto`). Encerrar = fechar o stdin
  (o host chama `deactivate()`, que mata `claude`/`codex app-server`) e, após
  1,5 s, `kill`.
- **Dados do host** em `<app_data_dir>/ext-host/`: `settings.json` (overrides de
  configuração do host — **nunca** o settings do VS Code), `extensions/<id>/`
  (globalState, workspaceState, secrets 0600, globalStorage), `logs/` (output
  channels: `Claude_VSCode.log`, `Codex.log`), `machine-id`.

## Protocolo (JSON por linha)

App → host `{id?, method, params}`; respostas `{id, result|error}`; eventos
`{event, …}`. Métodos: `initialize` (workspaceFolders, dataDir, language,
debugWebviews), `listInstalled`, `loadExtension` (`{id}` ou `{path}`; ativa por
padrão), `activate`, `resolveView`, `webviewMessage`, `webviewState`,
`webviewVisible`, `webviewUrl`, `disposeWebview`, `setTheme`, `editorState`,
`setWorkspaceFolders`, `respond`, `executeCommand`, `shutdown`.
Eventos principais: `postMessage`, `webviewHtml`, `webviewPanelCreated`,
`request` (showMessage/quickPick/inputBox/openDialog/saveDialog → o app
responde com `respond`), `openFile`, `diff`, `openVirtualDocument`,
`openExternal`, `clipboardWrite`, `revealView`, `context`, `log`.

## Webview no iframe — regras

- O HTML atribuído a `webview.html` é servido em
  `http://127.0.0.1:<porta>/<token>/wv/<handle>/index.html`; `asWebviewUri`
  aponta para `/<token>/res/<caminho absoluto>`; `cspSource` = a origem do
  servidor. Recursos só saem de raízes permitidas (pasta da extensão,
  `localResourceRoots`, pastas do workspace) — fora disso, 403. Token errado,
  404. Servidor só em `127.0.0.1`; respostas com `Access-Control-Allow-Origin: *`
  (módulos ES `crossorigin` do Codex) e `Service-Worker-Allowed`.
- **CSP:** o CSP da extensão **não é alterado**. O preâmbulo (script de
  `acquireVsCodeApi` + estilos padrão + variáveis de tema) é inserido como
  **primeiro filho do `<head>`**, antes do `<meta http-equiv=CSP>` da extensão;
  um CSP via `<meta>` só vale para o que vem depois dele, então o preâmbulo roda
  sem nonce. O iframe usa
  `sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads allow-popups allow-modals"`
  (o conjunto do VS Code + popups/modais) e `allow="clipboard-read; clipboard-write"`.
  `allow-same-origin` é seguro porque a origem do iframe (127.0.0.1:porta) é
  diferente da do app — o iframe não alcança `window.__TAURI__`.
- **Relay:** o preâmbulo envia ao pai `{__fluentExt:1, handle, type}`
  (`message`/`setState`/`ready`/`link`). O app só aceita se `event.source` for o
  `contentWindow` do iframe, `event.origin` a origem do host e `handle` o
  esperado (`parseIframeMessage`). Mensagens da extensão vão **cruas** ao iframe
  (como no VS Code); controle do app (`theme`) leva `__fluentCtl:1` e é
  consumido pelo preâmbulo com `stopImmediatePropagation`. Mensagens que chegam
  antes do `ready` (DOMContentLoaded) ficam retidas (`PendingQueue`).
- `getState/setState`: o estado vai ao host (`webviewState`) e volta embutido
  no preâmbulo quando o iframe recarrega (retainContextWhenHidden aproximado:
  os iframes ficam montados enquanto a sidebar está aberta).
- **Tema:** `src/extensions/theme.ts` mapeia os tokens Fluent em ~150
  variáveis `--vscode-*` (sidebar no tom do acrílico do dock, porém opaco,
  accent Fluent nos botões/links/foco). Enviado ao host (`setTheme`, embutido no
  HTML servido) e ao iframe (`theme`). Ao mudar tokens do app, revisar o mapa.

## UI

- Abas no topo da sidebar secundária (o dock de agentes): **Agentes** (chat
  nativo, inalterado) | uma aba por extensão suportada instalada | painéis
  (`createWebviewPanel`) abertos pelas extensões, fecháveis. Aba lembrada em
  `ui.agentsDockTab`. Sem extensões/Node, as abas não aparecem.
- A extensão só é **ativada ao abrir a aba** (o host sobe junto com a sidebar,
  mas só lista as instaladas).
- `vscode.diff` e documentos virtuais abrem num modal somente leitura com o
  DiffEditor do Monaco; aceitar/rejeitar continua na UI da extensão.
- Em `npm run tauri dev` (DEV), cada webview mostra um rodapé
  `↑ N (tipo) · ↓ M (tipo)` com os contadores do relay, e o console do app
  registra `[ext-host] webview→ext …` / `ext→webview …`; o stderr do processo
  Tauri mostra `[ext-host:<pid>] …` (logs do host com `debugWebviews`).

## Licenciamento

Carregamos a extensão **instalada localmente pelo usuário**, direto de
`~/.vscode/extensions/` (somente leitura) — nada é copiado, empacotado ou
redistribuído pelo Fluent Coder. Os termos de uso de cada extensão/serviço
continuam valendo para o usuário. Não incluir VSIX de terceiros no bundle.

## Aceite

- Unitários: `npm run test:unit` (inclui `tools/ext-host/test/*.test.js` e
  `src/extensions/*.test.ts`).
- Headless pelo protocolo real: `npm run ext-host:check` (ou
  `node tools/ext-host/scripts/headless-check.js claude|codex`): ativa, resolve
  a view, baixa HTML + assets (200) e faz o round trip.
- Render real em WebKitGTK (motor do Tauri no Linux), sem abrir o app:
  `python3 tools/ext-host/scripts/webkit-harness.py claude|codex --png out.png`
  (relatório com mensagens nos dois sentidos + texto visível + captura).
- Para não tocar a configuração real nos testes: `CLAUDE_CONFIG_DIR` e
  `CODEX_HOME` apontando para pastas temporárias (a UI cai na tela de login).
- Descoberta da API após atualizar uma extensão: `tools/ext-host/discovery/`
  (`run.js`, `coverage.js`) e atualizar `docs/research/vsix-api-surface.md`.
