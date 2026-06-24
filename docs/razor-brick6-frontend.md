# Brick 6 — Frontend (Monaco + Roslyn) para o broker de projeção

> **STATUS: IMPLEMENTADO atrás da flag `lsp.razorProjection` (default OFF).**
> Código validado com o Codex (3 rodadas → SOUND), `tsc`/`vite`/vitest/`cargo`
> verdes, e as partes frágeis cobertas por testes unitários sobre a **forma de
> resposta MEDIDA** (não suposta) via `tools/razor-lsp-probe/spike-b1d.mjs`.
> **Falta apenas o ACEITE AO VIVO** (passo do usuário — ver fim do doc): o app
> não consegue dirigir hover/ctrl+click headless, então a verificação visual é a
> última etapa, feita ligando a flag e abrindo o fixture.
>
> Arquivos: [razorProjection.ts](../src/lsp/servers/razorProjection.ts),
> [razorProjectionRouting.ts](../src/lsp/servers/razorProjectionRouting.ts) (+ `.test.ts`),
> [razorProjectionFlag.ts](../src/lsp/razorProjectionFlag.ts),
> [client.ts](../src/lsp/client.ts) (`suppressGenericBridges`),
> [roslynShared.ts](../src/lsp/servers/roslynShared.ts) (`solutionPath`/`onProjectInitialized`),
> [manager.ts](../src/lsp/manager.ts) (serialização start/stop + generation guard),
> [language.ts](../src/language.ts), [servers/index.ts](../src/lsp/servers/index.ts),
> [monacoSetup.ts](../src/lsp/monacoSetup.ts), [razorHtmlLint.ts](../src/lint/razorHtmlLint.ts),
> [App.tsx](../src/App.tsx) (evento `fluent:file-saved`).
>
> **Fato MEDIDO que rege o roteamento** (`spike-b1d`): diagnostics e hover voltam
> em coordenadas do `.g.cs` (CS1061 em `.g.cs` linha 160, não `.cshtml` 15) →
> **remapear todo range generated→source e descartar os não-mapeáveis**;
> definition de `@Model.City` aponta ao `WeatherModel.cs` real (passa direto).
> Reprepare é **on-save** (o broker lê do disco via `dotnet build`), nunca por
> tecla. Owner de markers: `fluent-cshtml`.

## Contrato já pronto (Rust, validado)
- `api.ts`: `razorPrepare({workspaceDir,userProjectDir,userCsprojPath,config,cshtmlRels})
  → {shadowDir, solutionPath, available[], missing[]}`; `razorRemapToGenerated(cshtmlPath,line,character) → {line,character}|null`; `razorRemapToSource(...)`; `razorForget(cshtmlPath)`.
- Posições são **0-based LSP**. `solutionPath` é uma `.sln` (user + shadow) pronta p/ `solution/open`.
- Provado e2e: o `.g.cs` projetado dá hover/def/diagnostics reais no Roslyn padrão; `#line` mapeia ao `.cshtml`.

## Passos (plano original — TODOS IMPLEMENTADOS)

> ℹ️ As subseções 6.1–6.4 são o **plano de design** que guiou a implementação e
> **já estão concluídas** (ver STATUS no topo). Estão preservadas em forma
> imperativa como registro do desenho original e dos avisos do Codex; **não** são
> uma checklist pendente. O comportamento atual é o descrito aqui, com as
> ressalvas em "Limitações conhecidas do V1". Para o estado vigente do serviço,
> ver [cshtml-language-service.md](context/cshtml-language-service.md) e
> [ADR 0002](adr/0002-cshtml-projection-roslyn.md).

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

## Aceite AO VIVO — passo do usuário (o que falta)
O código está pronto e validado estaticamente; só a verificação visual depende de
interação no app (impossível headless). Para fechar:

1. **Ligar a flag:** no DevTools do app, `localStorage.setItem("lsp.razorProjection","1")` e recarregar a janela. (Desligar = remover a chave ou setar `"0"` → volta ao cohost.)
2. Abrir a pasta `tools/razor-lsp-probe/fixtures/SampleMvc` (projeto MVC real; `dotnet restore` antes se necessário) e abrir `Views/Home/Index.cshtml`.
3. Confirmar no `.cshtml` (aguardar o primeiro `razorPrepare`/`dotnet build`, alguns segundos):
   - erro C# (`@Model.NonExistentProperty`, linha 16) com squiggle + painel Problemas **na linha do `.cshtml`** (owner `fluent-cshtml`);
   - hover em `@Model.City` → `string WeatherModel.City`;
   - ctrl+click em `Model.City` → navega ao `WeatherModel.cs`;
   - completion após `@Model.`;
   - editar+**salvar** atualiza os diagnostics (reprepare on-save);
   - "Resetar Servidores de Código" / trocar workspace não duplica providers nem vaza processos.

Já verde sem o app: `npx tsc --noEmit`, `npm run test:unit` (inclui 13 testes de roteamento sobre a forma medida), `npm run build`, `cargo test --lib razor::`. Falta o E2E (tauri-driver) sobre o fluxo ligado.

### Limitações conhecidas do V1 (documentadas)
- **Um projeto por sessão:** serve os `.cshtml` do projeto do primeiro `.cshtml` aberto; `.cshtml` de outro `.csproj` no mesmo workspace ficam sem semântica (multi-projeto = trabalho futuro).
- **Semântica "as of last save":** o broker regenera do disco (`dotnet build`), então diagnostics/hover/def refletem o último save, não o buffer sujo.
- **HTML/TagHelpers:** fora do brick 6 (Fase C — delegação HTML).

## Notas
- Latência: V1 gera projeção on-save (`dotnet build`); fast path futuro = sidecar .NET com o source generator (sem build).
- HTML/TagHelper regions: fora do brick 6 → Fase C (delegação HTML).
- Aposentar `cshtml/` homegrown (Fase E) só depois do brick 6 verde nos testes de não regressão; remoção atrás da mesma flag.
