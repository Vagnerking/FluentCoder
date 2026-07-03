# Roadmap — Paridade C# IDE (estilo C# Dev Kit)

> Plano de execução para fechar os gaps entre o editor hoje e uma experiência
> C#/.NET completa. Criado em 03/07/2026 na branch
> `feat/razor-projection-performance` (que já entregou a base: pipeline Razor
> performático + Roslyn standalone são). **Este documento é o mapa — atualize o
> status aqui ao concluir cada fase para não se perder.**

## Estado atual (auditado em 03/07/2026)

| Item | Estado | Onde |
|---|---|---|
| Syntax highlight | ✅ (semantic tokens 🟡: cross-refs viram `variable`) | Shiki/TextMate, `shikiScopeMap.ts` |
| IntelliSense / completion / hover / signature | ✅ | Roslyn standalone via `src/lsp/servers/csharp.ts` |
| Error diagnostics | ✅ pull + owner `dotnet-build` | `diagnosticsStore`, `src-tauri/src/lsp/build.rs` |
| Nullable diagnostics | ✅ (se o projeto habilita) | compilador |
| Go to definition | ✅ `.cs` e `.cshtml` (projeção) | `razorProjection.ts` |
| References / Rename | ✅ `.cs` (bridges) · ❌ `.cshtml` | monaco-languageclient |
| Code actions / quick fixes | 🟡 `.cs` via bridge · ❌ `.cshtml` | — |
| `.editorconfig` | 🟡 lido pelo Roslyn; sem UI | — |
| Format on save | ❌ | — |
| Build / Restore | 🟡 build com diagnósticos + RunPanel (Fase 1 run configs) | `build.rs`, `RunPanel.tsx` |
| Debugger / attach | ❌ (Fase 2 pendente — memória `executar-depurar-fases`) | — |
| Test runner / debug test / coverage | ❌ | — |
| Call/Type hierarchy | ❌ (Roslyn standalone não anuncia) | — |
| Solution/Project explorer | ❌ (só file explorer) | — |
| NuGet manager | ❌ | — |
| Razor `.cshtml` | ✅ (esta branch: sidecar-first, sem builds no open/save) | `src-tauri/src/razor/`, ADR 0002 |
| Blazor `.razor` | ❌ por decisão (cohost bloqueado headless) | ADR 0002 |
| Git | ✅ | `GitPanel.tsx` |

## Restrições que valem para TODAS as fases

- **Contratos**: [editor.md](../context/editor.md),
  [cshtml-language-service.md](../context/cshtml-language-service.md) (ranges
  sempre no `.cshtml`, ownership de markers, `TextEdit` NUNCA via remap clamped
  — só o mapeador estrito `to_source_range`).
- **Reset**: todo processo/servidor novo entra na rotina "Resetar Servidores de
  Código" ([command-palette.md](../context/command-palette.md)).
- **UI**: seguir [Fluent 2](../design/fluent-design.md).
- **Windows**: todo spawn precisa de `CREATE_NO_WINDOW` (memória
  `windows-create-no-window-spawns`).
- **Validação**: E2E (`tauri build` + tauri-driver) obrigatório ao fim de cada
  fase; unit tests para toda lógica pura.

---

## Fase A — Format on save + code actions `.cshtml` (baixo custo, Roslyn já faz o trabalho)

### A1. Format on save (`.cs` primeiro; `.cshtml` fora do escopo inicial)
- **Gatilho**: no fluxo de save do `App.tsx` (função que chama `write_file` e
  despacha `fluent:file-saved`, ~linha 2236), ANTES de gravar: se o model é
  `csharp` e a flag de format-on-save está ligada, pedir
  `textDocument/formatting` ao cliente C# (capability já anunciada), aplicar os
  `TextEdit`s no model, e então gravar o texto formatado.
- **Config**: chave `editor.formatOnSave` (localStorage, padrão OFF; mesma
  convenção boolean de `lsp.razorProjection`). Item na paleta para alternar.
- **Cuidados**: timeout curto (ex.: 2s) — save NUNCA pode travar; em timeout,
  salvar sem formatar. Não formatar arquivos gerados/read-only.
- **Aceite**: salvar um `.cs` mal indentado o reformata; com o servidor parado,
  salva sem formatar e sem erro.

### A2. Code actions + quick fixes para `.cshtml`
- Registrar `monaco.languages.registerCodeActionProvider(sel cshtml)` no
  `razorProjection.ts` (mesmo padrão manual de hover/definition).
- Fluxo: range do `.cshtml` → `razor_remap_to_generated` (posições) →
  `textDocument/codeAction` no `.g.cs` (incluir `context.diagnostics`
  remapeados) → para cada action retornada, remapear os `WorkspaceEdit`s
  gerado→fonte com o **mapeador estrito em lote** (novo comando
  `razor_remap_ranges_to_source_strict`, sem clamp) e DESCARTAR actions cujo
  edit caia em região sintética (contrato).
- `codeAction/resolve` para lazy edits.
- **Aceite**: quick fix "remove unused using" e "add using" funcionam num
  `.cshtml`; nenhuma action corrompe markup.

## Fase B — Debugger DAP (o maior gap)

- **Engine**: `netcoredbg` (Samsung, MIT) — o `vsdbg` da Microsoft é
  proprietário e licenciado só para VS/VS Code; não podemos usar. Download
  automático por plataforma no primeiro uso (mesmo padrão do download do
  Roslyn em `csharp.rs`), com SHA pinado.
- **Transporte**: DAP sobre stdio, bridge Rust igual ao LSP
  (`src-tauri/src/dap/` novo módulo espelhando `src-tauri/src/lsp/`).
- **UI mínima (Fluent 2)**: breakpoints na gutter (Monaco decorations),
  toolbar (continue/step/stop), painel de variáveis/watch/call stack no
  RunPanel (Fase 2 do plano existente — memória `executar-depurar-fases`).
- **Launch**: reusar as run configs da Fase 1 (`RunPanel.tsx`); launch =
  `dotnet build` (com diagnósticos já existentes) + `netcoredbg --launch`;
  attach = listar processos `dotnet` (`Win32_Process`) e attach por PID.
- **Aceite**: breakpoint em `Program.cs` do SampleMvc para no hit; variáveis
  visíveis; attach a um processo dotnet rodando funciona; parar o debug não
  mata o editor.

## Fase C — Test runner

- **Descoberta**: `dotnet test --list-tests` por projeto de teste (csproj com
  `IsTestProject`/referência a `Microsoft.NET.Test.Sdk`) — parse do stdout.
- **Execução**: `dotnet test --filter FullyQualifiedName=...` com logger
  `trx` ou console parseável; resultados num painel de testes (árvore
  projeto→classe→teste, estados pass/fail/skip, tempo).
- **Debug de teste** (depende da Fase B): `VSTEST_HOST_DEBUG=1` + attach do
  netcoredbg ao testhost.
- **Coverage** (ideal, não bloqueante): `--collect:"XPlat Code Coverage"` +
  parse do cobertura.xml para decorações de linha.
- **Aceite**: rodar/rerodar um teste xUnit individual e ver pass/fail inline.

## Fase D — Solution explorer

- Painel novo (sidebar) que parseia a `.sln` (parser Rust puro — já temos
  `render_solution`; fazer o inverso) e lista projetos→referências→arquivos.
- Ações mínimas: abrir arquivo, build/rebuild/clean por projeto (reusa
  `build.rs`), set startup project (integra com RunPanel).
- **Aceite**: abrir a solution do SampleMvc mostra o projeto e os arquivos.

## Fora de escopo desta branch (registrar como issues)

- NuGet manager UI, EF Core tools, Docker, call/type hierarchy (exige trocar
  o servidor ou capability custom — ADR próprio), Blazor `.razor` semântico,
  semantic tokens para cor de tipos no `.cshtml` (pendência registrada),
  security/perf analyzers dedicados.

## Log de execução

- [x] 03/07 — Base Razor performática (7 commits) + fix corrida de boot
      (`waitForCshtmlModels`) — E2E revalidação em andamento.
- [ ] A1 format on save
- [ ] A2 code actions `.cshtml`
- [ ] B debugger DAP
- [ ] C test runner
- [ ] D solution explorer
