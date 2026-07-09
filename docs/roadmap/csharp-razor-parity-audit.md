# Auditoria de paridade C# / Razor vs. C# Dev Kit

> Auditoria do estado **real do código** (não da documentação) em **09/07/2026**,
> branch `main`. Compara o suporte a `.cs`, `.cshtml` e `.razor` do FluentCoder
> com o **C# Dev Kit** (extensão oficial da Microsoft para VS Code:
> `ms-dotnettools.csharp` + `ms-dotnettools.csdevkit` + Razor).
>
> Substitui a foto de estado do [roadmap de paridade](csharp-ide-parity.md), que
> ficou **desatualizado** desde 03/07: o Solution Explorer foi **removido**
> (commit `5964e0c`, "redundante com o File Explorer") e o CodeLens de
> referências foi **adicionado** (commit `ca0d3e1`). As **fases de execução**
> daquele documento continuam válidas como plano; a **tabela "Estado atual" dele
> não deve mais ser lida como verdade**.

## Como ler esta auditoria

Na stack atual (`monaco-languageclient@10.7.0` + `@codingame/monaco-vscode-api`),
as **features nativas** do `vscode-languageclient` auto-registram providers Monaco
a partir das capabilities que o Roslyn anuncia no `initialize`. O código só
**desativa 3** delas ([client.ts:228-230](../../src/lsp/client.ts#L228-L230)):
`semanticTokens`, `diagnostic`, `references` — substituídas por bridges próprios.
Todo o resto de `.cs` (completion, hover, signature help, definition, rename,
code actions, formatting, document symbols, folding, CodeLens) **funciona pela
feature nativa**, condicionado ao que o Roslyn standalone anuncia — não há código
de produto nem teste E2E cobrindo cada uma individualmente. Onde marco
"nativo (não testado)", o comportamento é **inferido do wiring**, não provado.

Já `.cshtml` usa **projeção C# + Roslyn** com providers Monaco **manuais** (só os
4 registrados existem); e `.razor` depende do cohost, que está **bloqueado
headless** — na prática só tem highlight + lint.

---

## Placar geral

> **Atualização (09/07/2026 — milestone #5 concluída, branch `feat/csharp-parity-milestone-5`):**
> inlay hints (toggle), CodeLens "▶ Executar Teste", Ir para Implementação/Definição de Tipo,
> Formatar Seleção, Ir para Símbolo no Projeto (Ctrl+T) e abrir `.editorconfig` foram
> implementados (48 testes novos, build verde). Só **call/type hierarchy** (#6, exige ADR)
> permanece aberto no language service `.cs`.

| Categoria | Paridade com o Dev Kit |
|---|---|
| **Language service `.cs`** | ~95% — só falta hierarquia (call/type, #6-ADR) |
| **`.cshtml` (Razor MVC/Pages)** | ~55% — bom núcleo, faltam refs/rename/symbols/folding/tag helpers |
| **`.razor` (Blazor)** | ~10% — só highlight + lint; sem semântica |
| **Debug (.NET)** | ~60% — breakpoints + attach OK; falta watch/eval/cond. bp/debug-de-teste |
| **Testes (.NET)** | ~50% — descobre/roda/mostra; falta debug-de-teste, coverage, árvore |
| **Gestão de projeto/solução** | ~15% — sem Solution Explorer, NuGet, templates, launchSettings |

---

## 1. Language service C# (`.cs`)

| Feature | Estado | Nota / evidência |
|---|---|---|
| Completion / IntelliSense | ✅ nativo | trigger em arg lists ligado ([csharpConfiguration.ts:42](../../src/lsp/servers/csharpConfiguration.ts#L42)) |
| Hover / Quick Info | ✅ nativo | — |
| Signature Help | ✅ nativo | — |
| Go to Definition (cross-file) | ✅ | opener em [EditorPane.tsx:323](../../src/components/EditorPane.tsx#L323) |
| Find All References / Peek | ✅ bridge próprio | [references.ts:129](../../src/lsp/references.ts#L129), cross-file |
| Rename (F2, cross-file) | ✅ nativo (não testado) | depende de `renameProvider` do Roslyn |
| Code actions / quick fixes | ✅ nativo | instrumentado em [client.ts:178](../../src/lsp/client.ts#L178) |
| Format document | ✅ nativo | — |
| Format **on save** | ✅ só `.cs`, best-effort | [formatOnSave.ts:29](../../src/lsp/formatOnSave.ts#L29); exige editor anexado, timeout 2s |
| Document Symbols / breadcrumbs | ✅ nativo (não testado) | — |
| Folding | ✅ nativo (não testado) | — |
| Semantic tokens / cores de tipo | ✅ bridge (decorations) | [semanticColorizer.ts](../../src/lsp/semanticColorizer.ts); paleta Dark+ hardcoded |
| Diagnósticos (sintaxe + semânticos) | ✅ pull próprio | [diagnostics.ts:203](../../src/lsp/diagnostics.ts#L203) |
| CodeLens "N references" | ✅ render nativo + clique próprio | config liga ([csharpConfiguration.ts:47](../../src/lsp/servers/csharpConfiguration.ts#L47)); clique em [references.ts:172](../../src/lsp/references.ts#L172) |
| **Workspace Symbols (Ctrl+T)** | ✅ (#5) | picker `SymbolSearch.tsx` + keybinding Ctrl+T; ranking puro em [workspaceSymbols.ts](../../src/lsp/workspaceSymbols.ts) |
| **Inlay hints** (tipo/parâmetro) | ✅ (#5, toggle) | flag `csharp.inlayHints` + config dinâmica ([csharpInlayHints.ts](../../src/lsp/csharpInlayHints.ts)); provider nativo renderiza |
| **CodeLens de teste** ("▶ Executar Teste") | ✅ (#5, Run) | provider [testCodeLens.ts](../../src/lsp/testCodeLens.ts) → RunPanel via evento `fluent:run-test`. **Debug Test fica p/ #10** |
| **Call Hierarchy** | ❌ (#6, ADR) | Roslyn standalone não anuncia; sem workaround |
| **Type Hierarchy** | ❌ (#6, ADR) | idem |
| **Go to Implementation / Type Definition** | ✅ (#5) | comandos na paleta via `editorActionsRef` (providers nativos) |
| **Range formatting** | ✅ (#5) | comando "Formatar Seleção" (`editor.action.formatSelection`) |
| **On-type formatting** (`}`/`;` auto-indent) | ✅ | `formatOnType: true` já ligado ([EditorPane.tsx:664](../../src/components/EditorPane.tsx#L664)); provider nativo do Roslyn |
| **`.editorconfig`** | ✅ (#5) | lido pelo Roslyn + comando "Abrir .editorconfig" ([editorConfig.ts](../../src/lsp/editorConfig.ts)) |

**Gaps `.cs` que mais afastam do Dev Kit** (ordem de impacto):
1. **Inlay hints** — desligados; alto valor percebido, baixo custo (só ligar config + consumir `textDocument/inlayHint` nativo).
2. **CodeLens de teste** — "Run Test / Debug Test" acima de `[Fact]`/`[Test]` (o test runner já existe, ver §5).
3. **Call/Type hierarchy** e **Go to Implementation** — exigem capability que o Roslyn standalone não dá (precisa de ADR: trocar servidor ou capability custom).
4. **On-type formatting** — auto-formatar ao digitar `}`/`;`.

---

## 2. Razor MVC/Pages (`.cshtml`)

Projeção C# + Roslyn (flag `lsp.razorProjection`), com **4 providers manuais**
([razorProjection.ts](../../src/lsp/servers/razorProjection.ts)):

| Feature | Estado | Evidência |
|---|---|---|
| Hover | ✅ | [razorProjection.ts:709](../../src/lsp/servers/razorProjection.ts#L709) |
| Go to Definition (+ metadata→fonte) | ✅ | [razorProjection.ts:755](../../src/lsp/servers/razorProjection.ts#L755) |
| Completion C# (incl. `@Model.` dot) | ✅ | [razorProjection.ts:800](../../src/lsp/servers/razorProjection.ts#L800) |
| Completion HTML | ✅ region-gated | `vscode-html-languageservice` in-process ([cshtmlHtmlService.ts:146](../../src/lsp/servers/cshtmlHtmlService.ts#L146)) |
| Code actions / quick fixes | ✅ strict remap | [razorProjection.ts:928](../../src/lsp/servers/razorProjection.ts#L928) |
| Diagnósticos (C# projetado) | ✅ clamped remap | [razorProjection.ts:547](../../src/lsp/servers/razorProjection.ts#L547) |
| Auto-close de tag HTML | ✅ | [razorProjection.ts:1057](../../src/lsp/servers/razorProjection.ts#L1057) |
| **Tag Helpers (`asp-*`, `<component>`)** | ❌ | diretivas só são "apagadas" da projeção; sem completion/validação de `asp-*` |
| **Find References** | ❌ | sem `registerReferenceProvider` |
| **Rename** | ❌ | sem `registerRenameProvider` |
| **Signature Help** | ❌ | — |
| **Document Symbols** | ❌ | — |
| **Folding** | ❌ | — |
| **Semantic tokens** (cor de tipo no C# do markup) | ❌ | só highlight Shiki/TextMate |
| **Formatting / on-save** | ❌ | restrito a `csharp` |
| **Inlay hints** | ❌ | — |

**Gaps `.cshtml` que mais afastam do Dev Kit**:
1. **Tag Helpers** — o Dev Kit dá completion e validação de `asp-for`, `asp-action`, `asp-controller`, `<partial>`, view components. Hoje ausente — é o que mais "parece incompleto" num projeto MVC real.
2. **References / Rename** — F12 refs e F2 rename atravessando `.cshtml`↔`.cs` (o remap strict já existe para code actions; dá pra reusar).
3. **Document Symbols + Folding** — outline/breadcrumb e dobrar blocos `@{ }`/`<div>`.
4. **Semantic tokens** — cor de tipo (classe/enum) dentro do C# do markup, como já existe no `.cs`.

---

## 3. Blazor (`.razor`)

- **Highlight** (Shiki/TextMate): ✅ [shikiRazor.ts:25](../../src/lsp/shikiRazor.ts#L25)
- **Lint HTML client-side**: ✅ [razorHtmlLint.ts:234](../../src/lsp/razorHtmlLint.ts#L234)
- **Toda a semântica** (hover, definition, completion, diagnósticos C#,
  `@code`, componentes, `@bind`): ❌ na prática. `.razor` roteia para o cohost
  `aspnetcorerazor`, **bloqueado headless** — a projeção in-house só cobre
  `.cshtml`.

O Dev Kit tem Blazor completo. Fechar esse gap é o **maior item isolado** e
exige decisão de arquitetura própria (estender a projeção para `.razor` ou
desbloquear o cohost) — registrar como ADR.

---

## 4. Debug (.NET) — DAP

Engine **netcoredbg** 3.2.0-1092 (Samsung, MIT — sem a restrição de licença do
`vsdbg`). Backend [`src-tauri/src/dap/`](../../src-tauri/src/dap/), frontend
[`src/dap/debugSession.ts`](../../src/dap/debugSession.ts).

- ✅ Breakpoints no gutter ([EditorPane.tsx:479](../../src/components/EditorPane.tsx#L479))
- ✅ Launch (build + `dotnet <dll>`) e **Attach a processo** ([debugSession.ts:147](../../src/dap/debugSession.ts#L147), picker em [RunPanel.tsx:327](../../src/components/RunPanel.tsx#L327))
- ✅ Continue / step over/in/out / pause / stop; call stack + variáveis do frame do topo
- ❌ **Watch / hover-eval / avaliação de expressão**
- ❌ **Breakpoints condicionais / logpoints / hit count**
- ❌ **Árvore de variáveis expansível** (só frame do topo)
- ❌ **Debug de teste** (não liga o test runner ao DAP)
- ❌ **Múltiplas sessões** (uma por vez)
- ❌ **launchSettings.json** (env/args/URLs de perfil ignorados; launch hardcoded)

---

## 5. Testes (.NET)

[`src-tauri/src/testrunner.rs`](../../src-tauri/src/testrunner.rs) + `TestsSection`
([RunPanel.tsx:468](../../src/components/RunPanel.tsx#L468)).

- ✅ Descoberta (`dotnet test --list-tests`), execução (TRX + parser próprio),
  rodar todos / um teste, ✓/✗/duração inline
- ❌ **Debug de teste** (VSTEST_HOST_DEBUG + attach)
- ❌ **Coverage** (`--collect` + decorações de linha)
- ❌ **Árvore projeto→classe→teste** (hoje lista plana), re-run failed, watch
- ❌ **CodeLens "Run\|Debug Test"** inline no editor (ver §1)

---

## 6. Gestão de projeto / solução (maior lacuna vs. Dev Kit)

| Feature | Estado | Nota |
|---|---|---|
| Build → painel Problemas | ✅ | `dotnet build` no save ([build.rs:33](../../src-tauri/src/lsp/build.rs#L33), [buildDiagnostics.ts:24](../../src/lsp/buildDiagnostics.ts#L24)) |
| Run configs (genérico) | ✅ npm/cargo | [runner.rs](../../src-tauri/src/runner.rs); **não** detecta `dotnet run` |
| **Solution Explorer** | ❌ removido | commit `5964e0c`; sobrou CSS órfão `.sln-*` em [styles.css:4945](../../src/styles.css#L4945) |
| **NuGet manager** (add/remove/update/browse) | ❌ | nenhuma UI |
| **`dotnet new` / templates / scaffolding** | ❌ | criar projeto/classe a partir de template |
| **Ações build/rebuild/clean/restore** (UI) | ❌ | só build-on-save + build implícito do launch |
| **`dotnet restore` explícito** | ❌ | só implícito |
| **EF Core** (migrations, DbContext) | ❌ | — |
| **Docker** (containers/compose) | ❌ | só highlight/ícone de Dockerfile |
| **launchSettings.json** | ❌ | ver §4 |

O Dev Kit organiza tudo em torno do **Solution Explorer** (add/remove projeto,
referências, NuGet, startup project). O FluentCoder deliberadamente removeu isso
em favor do File Explorer — decisão de produto, mas é o que mais "parece
incompleto" para quem vem do Visual Studio / Dev Kit.

---

## Recomendação de priorização (custo × impacto)

**Rápidos e de alto valor (Roslyn/infra já fazem o trabalho):**
1. **Inlay hints `.cs`** — ligar config + consumir a feature nativa. §1
2. **CodeLens "Run\|Debug Test"** — o test runner e o DAP já existem. §1/§5
3. **On-type formatting `.cs`** — auto-indent ao digitar `}`/`;`. §1
4. **Debug de teste** — `VSTEST_HOST_DEBUG=1` + attach do netcoredbg já pronto. §5
5. **References/Rename `.cshtml`** — o remap strict já existe (reusar de code actions). §2

**Médio esforço, alto impacto de "completude":**
6. **Tag Helpers `.cshtml`** — completion/validação `asp-*`. §2
7. **Document Symbols + Folding `.cshtml`**. §2
8. **launchSettings.json** — perfis de launch para run + debug. §4/§6
9. **Watch / eval / breakpoints condicionais** no debugger. §4
10. **Coverage de testes**. §5

**Grandes (exigem ADR / decisão de arquitetura):**
11. **Call/Type hierarchy + Go to Implementation `.cs`** — trocar servidor ou capability custom. §1
12. **Blazor `.razor` semântico** — estender projeção ou desbloquear cohost. §3
13. **Solution Explorer + NuGet manager + `dotnet new`** — reintroduzir gestão de projeto. §6
14. **EF Core tools**. §6
