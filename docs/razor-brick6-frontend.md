# Brick 6 — Frontend (Monaco + Roslyn) para o broker de projeção

> Guia de implementação **a executar com o app rodando** (validação ao vivo). O
> backend Rust + bridge Tauri estão prontos e provados (ADR 0002); isto é o
> "last mile" que surge a semântica no editor. Não implementar "no escuro": cada
> passo deve ser visto funcionando no app + validado com o Codex antes de commit.

## Contrato já pronto (Rust, validado)
- `api.ts`: `razorPrepare({workspaceDir,userProjectDir,userCsprojPath,config,cshtmlRels})
  → {shadowDir, solutionPath, available[], missing[]}`; `razorRemapToGenerated(cshtmlPath,line,character) → {line,character}|null`; `razorRemapToSource(...)`; `razorForget(cshtmlPath)`.
- Posições são **0-based LSP**. `solutionPath` é uma `.sln` (user + shadow) pronta p/ `solution/open`.
- Provado e2e: o `.g.cs` projetado dá hover/def/diagnostics reais no Roslyn padrão; `#line` mapeia ao `.cshtml`.

## Passos (ordem; validar cada um no app)

### 6.1 — Language id `.cshtml` → `cshtml` (ADR 0002) — ATÔMICO com 6.2
Hoje `.cshtml`→`aspnetcorerazor`→cohost ([language.ts:28](../src/language.ts#L28), [index.ts:53](../src/lsp/servers/index.ts#L53)). Trocar `.cshtml`→`cshtml` **só** junto com registrar o novo server (senão `.cshtml` cai no `fluent-cshtml` homegrown morto). Registrar o language id `cshtml` no Monaco ([monacoSetup.ts](../src/lsp/monacoSetup.ts)) com a gramática (Monarch atual ou Shiki da Fase A). Atrás de **feature flag** (ponto único de rollback) — manter `aspnetcorerazor`→cohost como fallback até verde. **Completar a migração (⚠️ Codex):** atualizar TAMBÉM `monacoSetup.ts` (registro da linguagem/grammar), `src/lint/razorHtmlLint.ts` (`installRazorHtmlLint` hoje só mira `aspnetcorerazor` — se deve continuar lintando `.cshtml`, incluir `cshtml`), labels de status, e **manter `.razor`→`aspnetcorerazor`** (Blazor segue no cohost). `.cshtml` e `.razor` divergem aqui.

### 6.2 — Server starter `src/lsp/servers/razorProjection.ts`
Ao abrir um `.cshtml` (registry `cshtml` → este starter):
1. Resolver `userCsprojPath`/`userProjectDir` (o `.csproj` que contém a View; reusar a varredura de `listProjectFiles`/workspace) e `cshtmlRels` (as `.cshtml` abertas, relativas ao projeto).
2. `await razorPrepare({...})` → `{shadowDir, solutionPath, available, missing}`. Se `missing` inclui o doc → status degradado ("Razor: projeção indisponível").
3. Subir um cliente Roslyn dedicado sobre a shadow solution — **NÃO** com o `createLanguageClient` padrão de selector `csharp` (⚠️ Codex): ele auto-instala bridges genéricos (semantic tokens, references, diagnostics) que **competiriam com o cliente `csharp` real** em TODO `.cs` aberto. Em vez disso:
   - usar um **modo de projeção**: `createLanguageClient` com selector **vazio/não-casante** (sem bridges genéricos) — só queremos o transporte/`sendRequest`; OU adicionar uma flag em `LspClientConfig` que suprime os bridges genéricos. Os requests da projeção são dirigidos manualmente (6.3).
   - `solution/open` deve abrir **explicitamente** o `solutionPath` retornado. `wireRoslynStartup(rootPath: shadowDir)` HOJE acha `RazorShadow.sln` (o backend escreve direto em `shadowDir`), mas isso depende do layout/ordem de scan — **estender `wireRoslynStartup`/`openRoslynWorkspace` p/ aceitar `solutionPath` explícito** e enviar esse (mais robusto).
   - Launch = Roslyn **standalone** (reusar `ensureCsharpServer`/`standalone_launch_command`; é C# puro sobre o shadow).
4. `didOpen` os `.g.cs` projetados (`shadowDir/projected/...`) **direto no cliente** (`languageId:"csharp"`, uri, version, text) — Roslyn responde hover/def/completion sem precisar de model Monaco. (Model Monaco só seria necessário p/ o bridge de diagnostics genérico, que NÃO usamos aqui — ver 6.3.)

### 6.3 — Providers Monaco p/ `cshtml` (forward + remap)
Registrar (guardar disposables na sessão; selector `language:"cshtml"`):
- **hover**: `registerHoverProvider("cshtml", { provideHover(model,pos) → razorRemapToGenerated(path, pos.lineNumber-1, pos.column-1) → client.sendRequest("textDocument/hover", {textDocument:{uri: gcsUri}, position:G}) → remap a range do resultado via razorRemapToSource → Monaco Hover })`.
- **definition**: idem; alvos dentro do `.g.cs`/user project; remapear apenas alvos no `.g.cs` (alvos em `.cs` reais passam direto).
- **completion**: idem (sem range remap normalmente; ou remapear textEdit).
- **diagnostics** (⚠️ Codex — NÃO confiar no bridge de pull genérico): ele grava markers sob a URI consultada → pull no `.g.cs` cairia no `.g.cs`. Implementar um **pull customizado**: `client.sendRequest("textDocument/diagnostic", {textDocument:{uri: gcsUri}})`, então **inspecionar** cada diagnostic: se a location já vier como `.cshtml` (Roslyn mapeia via `#line` — provado: `Index.cshtml(16,15)`) usar direto; senão remapear o range via `razorRemapToSource`; e **publicar explicitamente** os markers no model do `.cshtml` via `monaco.editor.setModelMarkers(cshtmlModel, OWNER, ...)`. Descartar ranges não-mapeáveis (sintéticos).
- **Owner dos markers** (⚠️ Codex — conflito): usar **`fluent-cshtml`** (a [cshtml-language-service.md](context/cshtml-language-service.md) reserva esse owner p/ `.cshtml`), **não** `razor-projection`, a menos que o contrato seja atualizado.
- Converter 0-based(LSP)↔1-based(Monaco) nas bordas.

### 6.4 — Sync + lifecycle
- On `.cshtml` change/save: re-`razorPrepare` (debounce; V1 = on-save por causa do `dotnet build`), atualizar o `.g.cs` no cliente (didChange/reopen). On close: `razorForget` + dispose.
- Participar do "Resetar Servidores de Código" (command-palette.md): parar o cliente da projeção, limpar markers do owner (`fluent-cshtml`), `razorForget`.
- **Reset/lifecycle só funcionam se iniciado via `LspManager`** (⚠️ Codex): registry `cshtml` → este starter dá cobertura de reset. **Todos** os recursos "escondidos" do starter — providers Monaco custom, models/didOpen do `.g.cs` no cliente, timers de pull de diagnostics, debounce — devem ser guardados num conjunto de `IDisposable` da sessão e descartados no disposal do starter (igual ao contrato de `disposeLanguageClientContributions`). Nada pode vazar em restart/StrictMode/troca de workspace.
- Registry: `cshtml` → este starter; remover/flag o `cshtml`→fluent-cshtml e o `aspnetcorerazor`→cohost p/ `.cshtml`.

## Validação (ao vivo, no app) — gate de cada passo
Abrir o fixture `tools/razor-lsp-probe/fixtures/SampleMvc` no app e confirmar no `.cshtml`:
1. erro C# (`@Model.NonExistentProperty`) com squiggle + painel Problemas no `.cshtml`;
2. hover em `@Model.City` → `string WeatherModel.City`;
3. ctrl+click em `Model.City` → navega ao `WeatherModel.cs`;
4. completion após `@Model.`;
5. trocar workspace / resetar servidores não duplica providers nem vaza processos.
Rodar também `npm run build`, `npm run test:unit`, `cargo test --lib razor::` e o E2E (tauri-driver). Validar com o Codex (comportamento real, não só código).

## Notas
- Latência: V1 gera projeção on-save (`dotnet build`); fast path futuro = sidecar .NET com o source generator (sem build).
- HTML/TagHelper regions: fora do brick 6 → Fase C (delegação HTML).
- Aposentar `cshtml/` homegrown (Fase E) só depois do brick 6 verde nos testes de não regressão; remoção atrás da mesma flag.
