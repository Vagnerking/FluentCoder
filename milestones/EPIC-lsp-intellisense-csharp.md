# Épico: IntelliSense C# via LSP (Roslyn)

> **Status:** Pendente
> **Owner:** Vagner
> **Stack:** Tauri 2 · Rust · React 18 · TypeScript · Monaco · monaco-languageclient · Roslyn LSP

## Visão

Implementar suporte completo para desenvolvimento em **C#** dentro do Monaco Editor, com
experiência próxima a uma IDE: autocomplete com tipos reais do projeto, diagnósticos ao vivo,
hover com informações de tipos/métodos, go-to-definition, find references, rename, code actions
e formatação — tudo alimentado pelo **Roslyn Language Server** (Microsoft.CodeAnalysis.LanguageServer),
baixado e gerenciado automaticamente pelo backend Rust.

Este épico também entrega a **infraestrutura LSP genérica** (bridge WebSocket local, spawn de
subprocessos LSP, wiring do `monaco-languageclient` no front) que os épicos de Razor e
TypeScript/JavaScript reusam sem precisar reimplementar nada.

## Estado atual (baseline)

- Monaco carrega arquivos `.cs` com syntax highlighting básico (`cs → csharp` já em
  [language.ts](../src/language.ts)), mas **sem IntelliSense semântico** de nenhuma espécie.
- O backend Rust já sabe spawnar e gerenciar processos filhos de longa duração: o padrão de
  `Mutex<HashMap<String, PtySession>>` + thread de leitura + `app_handle.emit` está em
  [terminal.rs](../src-tauri/src/terminal.rs). O novo módulo `lsp` espelha esse padrão.
- Diagnósticos já têm um pipeline completo no front: `monaco.editor.onDidChangeMarkers()` →
  `mapSeverity` → `onProblemsChange` em [EditorPane.tsx](../src/components/EditorPane.tsx)
  → `Problem[]` em [types.ts](../src/types.ts) → [ProblemsPanel.tsx](../src/components/ProblemsPanel.tsx).
  O LSP vai alimentar esse pipeline via markers do Monaco.
- Comandos Tauri registrados em [lib.rs](../src-tauri/src/lib.rs) via `generate_handler!`;
  IPC front em [api.ts](../src/api.ts) com `invoke<T>("cmd", {args})`.
- `rootPath` (raiz do workspace) disponível em [App.tsx](../src/App.tsx) — necessário para o
  servidor LSP receber `rootUri`.
- Cargo.toml atual: `tauri 2`, `serde`, `serde_json`, `portable-pty 0.9`. **Sem tokio.**

## Escopo deste épico

| Item | Decisão |
| --- | --- |
| Servidor C# | **Roslyn LSP** (Microsoft.CodeAnalysis.LanguageServer) baixado/cacheado pelo Rust |
| Auto-download | Rust baixa o binário na primeira execução, cacheia em `app_data_dir()/lsp/roslyn/<versão>/` |
| Bridge frontend↔LSP | **WebSocket local** em `127.0.0.1:0` (porta efêmera) com token por sessão |
| Cliente LSP no front | `monaco-languageclient` + `vscode-ws-jsonrpc` — **não** LSP artesanal |
| Compatibilidade Monaco | Spike obrigatório (ISSUE-19) antes de tudo — versões novas do monaco-languageclient exigem `@codingame` |
| Worker TS/JS embutido | Fora deste épico (tratado no épico TypeScript/JavaScript) |
| tokio no backend | Usado **apenas** no módulo `lsp`; `terminal.rs` não é tocado |
| Razor / .cshtml | Fora deste épico (épico dedicado, reusa a infra aqui criada) |
| Recursos LSP | Completions, hover, diagnósticos, go-to-def, find refs, rename, code actions, formatação |
| Atalhos | Ctrl+Space, F12, Shift+F12, Ctrl+., F2, Ctrl+K Ctrl+F, Alt+Enter |

## Issues

| # | Título | Camada | Depende de | Estimativa |
| --- | --- | --- | --- | --- |
| [19](issues/ISSUE-19-lsp-spike-monaco-languageclient.md) | Spike: compatibilidade monaco-languageclient | Front | — | M |
| [20](issues/ISSUE-20-lsp-process-stdio-codec.md) | Rust: spawn LSP + codec Content-Length | Rust | 19 | M |
| [21](issues/ISSUE-21-lsp-websocket-bridge.md) | Rust: bridge WebSocket local | Rust | 20 | L |
| [22](issues/ISSUE-22-lsp-state-commands.md) | Rust: LspState + comandos + registro | Rust | 20, 21 | M |
| [23](issues/ISSUE-23-lsp-frontend-transport-client.md) | Front: transport + monaco-languageclient factory | Front | 19, 21, 22 | L |
| [24](issues/ISSUE-24-lsp-diagnostics-to-problems.md) | Front: diagnósticos LSP → Problem[] | Front | 23 | M |
| [25](issues/ISSUE-25-lsp-workspace-lifecycle.md) | Front: lifecycle do workspace (manager) | Front | 23 | M |
| [26](issues/ISSUE-26-csharp-roslyn-download.md) | Rust: download e cache do Roslyn LSP | Rust | 22 | L |
| [27](issues/ISSUE-27-csharp-client-config.md) | Full: C# client config + fatia vertical | Full | 23, 25, 26 | M |
| [28](issues/ISSUE-28-lsp-server-status-ux.md) | Full: UX de status do servidor (status bar) | Full | 27 | S |

`S` = pequeno, `M` = médio, `L` = grande.

## Ordem de implementação sugerida

1. **19** (spike) — trava todas as demais.
2. **20** e **21** em paralelo (Rust: codec stdio + bridge WS), depois **22** (state + registro).
3. **23**, **24** e **25** em paralelo (wiring front: transport, diagnósticos, lifecycle).
4. **26** (download Roslyn) — pode ser em paralelo com 23-25.
5. **27** (C# end-to-end) — prova o pipeline inteiro.
6. **28** (UX status) — fechamento.

## Critérios de aceite do épico

- [ ] Arquivos `.cs` abrem no Monaco e recebem IntelliSense com tipos reais do projeto.
- [ ] Autocomplete sugere namespaces, classes, interfaces, métodos, propriedades e variáveis.
- [ ] Erros e warnings C# aparecem no editor com underline e no ProblemsPanel.
- [ ] Hover exibe informações de tipo, assinatura e documentação.
- [ ] `F12` (Go to Definition) funciona, incluindo definições em outros arquivos.
- [ ] `Shift+F12` (Find References) funciona.
- [ ] `F2` (Rename Symbol) funciona.
- [ ] `Ctrl+.` (Code Actions) oferece Add using, Quick Fix etc.
- [ ] `Ctrl+K Ctrl+F` formata o documento respeitando `.editorconfig`.
- [ ] O Roslyn é baixado automaticamente na primeira execução e cacheado.
- [ ] Erro claro na UI se `.NET SDK` não estiver instalado.
- [ ] Estado "baixando / iniciando / pronto / falhou" visível na StatusBar.
- [ ] Funciona com pelo menos um projeto `.csproj` real.
- [ ] `tsc --noEmit` e `cargo check` sem erros.
- [ ] Teste E2E (tauri-driver) cobrindo: abrir `.cs` → aguardar pronto → digitar → completion aparece.

## Riscos / notas

- **Compatibilidade monaco-languageclient (risco maior):** versões recentes (v8+) exigem
  `@codingame/monaco-vscode-api`, que conflita com `@monaco-editor/react@4.6` + `monaco-editor@0.52`.
  Mitigação: ISSUE-19 determina a versão correta antes de qualquer outra issue.
- **tokio em backend síncrono:** escopo restrito ao módulo `lsp/`; não tocar `terminal.rs`.
- **Roslyn precisa de .NET SDK:** detectar `dotnet` no PATH; erro de UX claro se ausente (ISSUE-28).
- **Porta local:** `127.0.0.1` + porta efêmera + token por sessão (ISSUE-21); nunca `0.0.0.0`.
- **Download grande e offline:** primeiro launch baixa o Roslyn (~50–100 MB). Mitigação: cache por
  versão, UX de progresso, falha graciosa se offline.
- **Transport isolado:** toda a lógica de WS fica em `src/lsp/transport.ts`; se a porta local for
  indesejável no futuro, só esse módulo troca para invoke/event — o resto do wiring não muda.
- **E2E obrigatório (regra do projeto):** ao concluir o épico, rodar `tauri build` + tauri-driver;
  não usar Playwright/MCP.
