# Milestones

Planejamento de features do **Code Editor** (Tauri + React + Monaco), organizado em
épicos e issues.

## Épicos

- [Fluent VSCode Layout](EPIC-fluent-vscode-layout.md) — layout completo estilo VSCode com
  Fluent Design do Windows 11 (activity bar, breadcrumbs, terminal funcional, status bar).
  **Status:** em andamento.
- [Open VSX Extensions](EPIC-openvsx-extensions.md) — biblioteca de extensões: buscar,
  instalar e aplicar (temas e gramáticas TextMate) a partir do Open VSX Registry.
  **Status:** planejado.
- [Quick Open — busca de arquivos (Ctrl+P)](EPIC-quick-open-file-search.md) — palette
  flutuante que busca arquivos do projeto por nome (fuzzy match), estilo VSCode.
  **Status:** concluído.
- [IntelliSense C# via LSP (Roslyn)](EPIC-lsp-intellisense-csharp.md) — IntelliSense completo
  para C# com Roslyn LSP: completions, diagnósticos, hover, go-to-def, rename, code actions e
  infraestrutura LSP genérica (bridge WS, transport, lifecycle) reutilizada pelos demais épicos.
  **Status:** em andamento (infra + cliente C# implementados; download do Roslyn e E2E não testados).

> **Integração dos 3 épicos LSP (C#, TS/JS, Razor):** unificados na árvore principal sobre uma
> única infra (`monaco-languageclient@1.1.0` + bridge WS em `src-tauri/src/lsp`). Os 3 adaptadores
> (`src/lsp/servers/{csharp,typescript,razor}.ts`) compartilham a mesma assinatura
> `createLanguageClient(config)` / `startLspServer(id, program, args, cwd)` e são despachados por um
> registro único (`src/lsp/servers/index.ts`). Diagnósticos de qualquer servidor chegam ao
> ProblemsPanel pelo pipeline de markers existente (EditorPane → App). `tsc --noEmit` e `cargo check`
> passando. Razor reusa a infra base (o JSON-RPC/WS artesanal do worktree Razor foi descartado).
- [Razor / .cshtml — IntelliSense no Monaco](EPIC-lsp-razor-cshtml.md) — suporte a arquivos
  Razor (.cshtml) com syntax highlight, diagnósticos e IntelliSense via rzls (best-effort).
  **Status:** parcial — highlight Razor + infra LSP + lifecycle/diagnósticos best-effort entregues
  (tsc/cargo check passando); IntelliSense semântico rebaixado p/ milestone futura (projeção de
  documentos, conclusão do spike ISSUE-32). rzls não baixado/executado; E2E não rodado.
- [TypeScript e JavaScript — IntelliSense via LSP real](EPIC-lsp-typescript-javascript.md) —
  IntelliSense completo para .ts/.tsx/.js/.jsx via typescript-language-server real, respeitando
  tsconfig.json, aliases, node_modules e @types.
  **Status:** ✅ concluído (infra LSP + cliente TS/JS implementados; tsc --noEmit e cargo check
  passando; E2E tauri-driver não executado).
- [Icon Pack — Material + Codicons](EPIC-icon-pack-monaco.md) — ícones de arquivo/pasta
  (Material Icon Theme) no explorer/abas/busca e ícones de UI/ações/diagnósticos (Codicons)
  na interface, com camada própria de resolução e estados visuais (cor + badge git).
  **Status:** concluído.
- [Ações do Explorador de Arquivos](EPIC-file-explorer-actions.md) — barra de ações com
  Novo arquivo, Nova pasta, Atualizar explorador e Recolher pastas.
  **Status:** planejado.

## Issues — Fluent VSCode Layout

| # | Issue | Status |
| --- | --- | --- |
| 01 | [App shell / grid de layout](issues/ISSUE-01-app-shell-layout.md) | ⬜ Pendente |
| 02 | [Activity bar](issues/ISSUE-02-activity-bar.md) | ⬜ Pendente |
| 03 | [Breadcrumbs](issues/ISSUE-03-breadcrumbs.md) | ⬜ Pendente |
| 04 | [Status bar](issues/ISSUE-04-status-bar.md) | ⬜ Pendente |
| 05 | [Terminal — backend PTY](issues/ISSUE-05-terminal-backend-pty.md) | ⬜ Pendente |
| 06 | [Terminal — frontend xterm](issues/ISSUE-06-terminal-frontend-xterm.md) | ⬜ Pendente |
| 07 | [Polimento Fluent](issues/ISSUE-07-fluent-polish.md) | ⬜ Pendente |
| 08 | [Integração e build](issues/ISSUE-08-integration-build.md) | ⬜ Pendente |

## Issues — Open VSX Extensions

| # | Issue | Status |
| --- | --- | --- |
| 09 | [Cliente da API Open VSX (Rust)](issues/ISSUE-09-openvsx-api-client.md) | ⬜ Pendente |
| 10 | [Download/storage de `.vsix`](issues/ISSUE-10-extension-install-storage.md) | ⬜ Pendente |
| 11 | [View Extensions na activity bar](issues/ISSUE-11-extensions-view-ui.md) | ⬜ Pendente |
| 12 | [Modelo do manifesto e estado](issues/ISSUE-12-extension-manifest-model.md) | ⬜ Pendente |
| 13 | [Aplicar temas e gramáticas no Monaco](issues/ISSUE-13-apply-themes-grammars.md) | ⬜ Pendente |
| 14 | [Atualizar, desabilitar e remover](issues/ISSUE-14-extension-lifecycle.md) | ⬜ Pendente |

## Issues — Quick Open (Ctrl+P)

| # | Issue | Status |
| --- | --- | --- |
| 15 | [Índice de arquivos do projeto (Rust)](issues/ISSUE-15-file-index-backend.md) | ✅ Concluída |
| 16 | [Fuzzy matcher + scoring (front)](issues/ISSUE-16-fuzzy-matcher.md) | ✅ Concluída |
| 17 | [Palette Quick Open + Ctrl+P (UI)](issues/ISSUE-17-quick-open-palette-ui.md) | ✅ Concluída |
| 18 | [Integração, polimento e E2E](issues/ISSUE-18-quick-open-integration.md) | ✅ Concluída |

## Issues — IntelliSense LSP C# (infra + Roslyn)

| # | Issue | Status |
| --- | --- | --- |
| 19 | [Spike: compatibilidade monaco-languageclient](issues/ISSUE-19-lsp-spike-monaco-languageclient.md) | ✅ Concluída |
| 20 | [Rust: spawn LSP + codec Content-Length](issues/ISSUE-20-lsp-process-stdio-codec.md) | ✅ Concluída |
| 21 | [Rust: bridge WebSocket local](issues/ISSUE-21-lsp-websocket-bridge.md) | ✅ Concluída |
| 22 | [Rust: LspState + comandos + registro](issues/ISSUE-22-lsp-state-commands.md) | ✅ Concluída |
| 23 | [Front: transport + monaco-languageclient factory](issues/ISSUE-23-lsp-frontend-transport-client.md) | ✅ Concluída |
| 24 | [Front: diagnósticos LSP → Problem[]](issues/ISSUE-24-lsp-diagnostics-to-problems.md) | ✅ Concluída |
| 25 | [Front: lifecycle do workspace (manager)](issues/ISSUE-25-lsp-workspace-lifecycle.md) | ✅ Concluída |
| 26 | [Rust: download e cache do Roslyn LSP](issues/ISSUE-26-csharp-roslyn-download.md) | ✅ Concluída (download win-x64 validado + smoke LSP) |
| 27 | [Full: C# client config + fatia vertical](issues/ISSUE-27-csharp-client-config.md) | ✅ Concluída (E2E pendente) |
| 28 | [Full: UX de status do servidor (status bar)](issues/ISSUE-28-lsp-server-status-ux.md) | ✅ Concluída |

## Issues — Razor / .cshtml

| # | Issue | Status |
| --- | --- | --- |
| 29 | [Front: registrar linguagem razor no Monaco](issues/ISSUE-29-razor-language-registration.md) | ✅ Concluída |
| 30 | [Rust: aquisição e launch do rzls](issues/ISSUE-30-razor-server-acquisition.md) | 🟡 Parcial (download stub/não testado) |
| 32 | [Full: spike de capabilities do rzls](issues/ISSUE-32-razor-capability-spike.md) | 🟡 Parcial (spike estático; rzls não executado) |
| 31 | [Full: Razor client config (best-effort)](issues/ISSUE-31-razor-client-config.md) | 🟡 Parcial (rebaixado: highlight+diagnósticos; sem projeção) |

## Issues — TypeScript e JavaScript

| # | Issue | Status |
| --- | --- | --- |
| 33 | [Front: desabilitar worker TS/JS embutido](issues/ISSUE-33-ts-disable-builtin-worker.md) | ✅ Concluída |
| 34 | [Rust: launch do typescript-language-server](issues/ISSUE-34-ts-language-server-launch.md) | ✅ Concluída |
| 35 | [Full: TS/JS client config (tsconfig, aliases, @types)](issues/ISSUE-35-ts-client-config.md) | ✅ Concluída |
| 36 | [Front: ids de linguagem TSX/JSX (react)](issues/ISSUE-36-tsx-jsx-language-ids.md) | ✅ Concluída |
| 37 | [Full: validação E2E TypeScript/JavaScript](issues/ISSUE-37-ts-end-to-end-validation.md) | ✅ Concluída (E2E tauri-driver pendente) |

## Issues — Icon Pack (Material + Codicons)

| # | Issue | Status |
| --- | --- | --- |
| 38 | [Camada de resolução Material (config + resolver + assets)](issues/ISSUE-38-material-resolver-layer.md) | ✅ Concluída |
| 39 | [Codicons: mapa central + componente](issues/ISSUE-39-codicon-central-map.md) | ✅ Concluída |
| 40 | [Aplicar ícones nos componentes + decorations](issues/ISSUE-40-wire-components-icons.md) | ✅ Concluída |
| 41 | [Performance (no-inline), docs e E2E](issues/ISSUE-41-icon-pack-perf-docs-e2e.md) | ✅ Concluída |

## Issues — Ações do Explorador de Arquivos

| # | Issue | Status |
| --- | --- | --- |
| 42 | [Novo arquivo](issues/ISSUE-42-explorer-new-file.md) | ⬜ Pendente |
| 43 | [Nova pasta](issues/ISSUE-43-explorer-new-folder.md) | ⬜ Pendente |
| 44 | [Atualizar explorador](issues/ISSUE-44-explorer-refresh.md) | ⬜ Pendente |
| 45 | [Recolher pastas](issues/ISSUE-45-explorer-collapse-folders.md) | ⬜ Pendente |
| 46 | [Integração, acessibilidade e E2E](issues/ISSUE-46-explorer-actions-integration.md) | ⬜ Pendente |

## Convenção

- Cada issue tem: contexto, tarefas (checkboxes), arquivos afetados, detalhes técnicos e
  critérios de aceite.
- Status: ⬜ Pendente · 🟡 Em andamento · ✅ Concluída.
- Ao concluir uma issue, marcar aqui e os checkboxes dentro do arquivo da issue.
