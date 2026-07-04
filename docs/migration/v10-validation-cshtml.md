# Validação CSHTML — migração `monaco-languageclient` v10 (issue #78)

> Branch da migração: `feat/monaco-v10-migration` (worktree
> `CodeEditor-v10-integration`). Este documento cobre a aceitação da issue #78:
> projeção CSHTML, providers Monaco e lifecycle **após** a v10.
>
> Normativo: [`docs/context/cshtml-language-service.md`](../context/cshtml-language-service.md);
> referência de risco: [`docs/migration/monaco-v10-audit.md`](monaco-v10-audit.md) §2 (linha CSHTML) e §5 (critérios CSHTML).

## Parte A — Validação automática / estática (concluída)

### A.1 Testes unitários de projeção/roteamento

- `npm run test:unit` → **191 testes, 0 falhas**.
- `razorProjectionRouting.test.ts` + `cshtmlHtmlProjection.test.ts` rodados
  isoladamente → **58 testes, 0 falhas**.

### A.2 Verificações estáticas (PASS/FAIL/UNCERTAIN, com evidência)

| # | Verificação | Resultado | Evidência |
|---|---|---|---|
| 1 | `suppressGenericBridges: true` é honrado para o client de projeção → nenhum bridge genérico (semantic tokens/references/diagnostics) sobre selector `csharp` | **PASS** | `razorProjection.ts:212` define a flag; `client.ts:178-210` só instala os 3 bridges quando `!suppressGenericBridges`; `client.ts:152-156` só desliga features nativas quando `!suppressGenericBridges`. Único call site da flag = projeção (`grep suppressGenericBridges`). |
| 2 | Selector-sentinela `__razor_projection_never__` impede que features nativas v10 anexem provider a modelos reais `.cshtml`/`.cs`; o disable nativo do #76 **não** se aplica à projeção, e isso não importa porque não há bridges | **PASS** | `razorProjection.ts:209` selector sentinela; commit #76 (`b37c170`) explica: "client de projeção não instala bridges nem tem features nativas desligadas; seu selector-sentinela não casa nenhum modelo real". `client.ts:147-151` documenta o mesmo. |
| 3 | Markers `.cshtml` são owner `fluent-cshtml` e os ranges são remapeados para o `.cshtml` (não `.g.cs`) | **PASS** | Owner: `razorProjection.ts:70` (`DIAGNOSTICS_OWNER = "fluent-cshtml"`), publicado em `razorProjection.ts:375-379` via `setModelMarkers(model_cshtml, DIAGNOSTICS_OWNER, …)`. Remap: `pullDiagnostics` (`:366`) → `routeDiagnostics` (`razorProjectionRouting.ts:164-184`) → `remapRangeToMonaco` (`:112-126`) remapeia gerado→fonte e **dropa** o não-mapeável. |
| 4 | `.razor` (id `aspnetcorerazor`) NÃO é capturado pelo serviço `.cshtml`; as duas linguagens ficam separadas | **PASS** | `language.ts:30-31` (`cshtml → "cshtml"`, `razor → "aspnetcorerazor"`); `language.ts:94` só roteia `.cshtml` para id `cshtml` (atrás do flag). Registry: `index.ts:55` (`aspnetcorerazor` → `RAZOR_SERVER_ID`) vs `index.ts:60` (`cshtml` → `RAZOR_PROJECTION_SERVER_ID`), entradas distintas. Os providers de projeção usam `sel = "cshtml"` apenas. |
| 5 | Disposal: providers/timers da projeção registrados via `registerClientDisposables`; `disposeLanguageClientContributions` ainda os derruba no stop (restart/StrictMode/troca de workspace não vazam) | **PASS** | `razorProjection.ts:989` `registerClientDisposables(client, disposables)`; `client.ts:288-293` empilha no mesmo WeakMap de contribuições; `manager.ts:105` chama `disposeLanguageClientContributions` no `stop` e `manager.ts:86` no descarte de start obsoleto. Disposable final (`razorProjection.ts:969-987`) limpa timers/docs/markers/store. |
| 6 | Apenas UM provider por feature reivindica `cshtml` | **PASS** | Únicos providers com selector `cshtml` em todo o `src/`: hover (`razorProjection.ts:537`), definition (`:583`), completion (`:616`). Os providers de semantic tokens (`client.ts:559,593`) e references (`references.ts:142`) usam o `documentSelector` do client (sentinela na projeção), nunca `cshtml`. HTML IntelliSense (`cshtmlHtmlService.ts`) **não** registra provider — é helper chamado de dentro dos providers `cshtml`. |

> Observação importante: o `git diff --stat main..HEAD` mostra que a migração v10
> **não tocou nenhum arquivo de projeção** (`razorProjection.ts`,
> `razorProjectionRouting.ts`, `cshtmlHtmlProjection.ts`, `cshtmlHtmlService.ts`,
> `servers/index.ts`). Mudou apenas o entorno: `client.ts`, `nativeFeatures.ts`
> (novo), `vscodeServices.ts` (novo), `monaco-loader.ts`, `vite.config.ts`,
> `references.ts`, `diagnostics.ts`, `monacoSetup.ts`, `EditorPane.tsx`.

### A.3 Checklist "Migração sem providers duplicados" (`cshtml-language-service.md`)

- [x] `.cshtml` mapeado somente para `cshtml` — `language.ts:94` (atrás do flag); `EXT_TO_LANG.cshtml = "cshtml"` (`:30`).
- [x] `.razor` não usa o mesmo language id — `language.ts:31` (`aspnetcorerazor`).
- [x] `SERVER_REGISTRY["cshtml"]` aponta somente para `fluent-cshtml` — entrada única `index.ts:60` (`RAZOR_PROJECTION_SERVER_ID`); markers desse serviço usam owner `fluent-cshtml`. Sem colisão de registry (warn em `index.ts:99-104` não dispara para `cshtml`).
- [x] Selector do cliente Roslyn contém somente C# — `csharp.ts` usa `[{scheme:file,language:csharp}]`; o client de projeção usa selector sentinela, NÃO `csharp` (`razorProjection.ts:209`), então não compete em `.cs`.
- [x] Adapter legado `rzls` não é inicializado — sem nenhuma referência a `rzls` no código de projeção; o cohost (`razor.ts`/`aspnetcorerazor`) é outro serviço, não tocado.
- [x] Somente um provider por feature reivindica `cshtml` — ver A.2 #6.
- [ ] **(MANUAL)** Markers antigos de `csharp`/`razor` para modelos `.cshtml` são limpos uma vez durante a migração — depende de runtime (ver B.2). Estaticamente: `forgetDoc` (`razorProjection.ts:738`) e dispose limpam **somente** o owner `fluent-cshtml`, respeitando o contrato de ownership. Confirmar em runtime que não sobrou marker `csharp`/`aspnetcorerazor` no `.cshtml`.
- [ ] **(MANUAL)** Restart, StrictMode e troca de workspace não aumentam a contagem de providers/listeners — ver B.4. Estaticamente PASS (A.2 #5), mas exige confirmação no app.
- [x] Rollback é possível por um único feature flag/ponto de registry — `language.ts:94` (`isRazorProjectionEnabled()`), flag `RAZOR_PROJECTION_FLAG_KEY` (`App.tsx:914-918`); com a flag OFF, `.cshtml` volta a `aspnetcorerazor` (cohost) e a entrada `cshtml` do registry nunca é alcançada.

---

## Parte B — Checklist manual de runtime (executar no app real)

Pré-requisitos:

1. `tauri build` da branch `feat/monaco-v10-migration` (não `cargo build` — senão a
   WebView abre em localhost recusado). E2E via tauri-driver + WebdriverIO.
2. Um projeto ASP.NET Core MVC/Razor Pages real com `.csproj` + ao menos um
   `.cshtml` que use `@model` e `@Model.` (ex.: `SampleMvc`).
3. Flag de projeção ON (Paleta de Comandos → alternar projeção CSHTML; ou
   `localStorage["…razor-projection…"] = "1"` e reload).
4. DevTools aberto para inspecionar `monaco.editor.*` e os logs `lspLog`
   (prefixo das mensagens de `src/lsp/debug.ts`).

Como observar genericamente: no console do app,
`window.__monaco ?? monaco` expõe a instância única; use
`monaco.editor.getModels()`, `monaco.editor.getModelMarkers({...})` e os logs
`razor projection: …` / `provideDocumentSemanticTokens` / `models at start`.

### B.1 — Abrir um `.cshtml` e exercitar todas as features (remapeadas)

1. **Ação:** abrir a pasta do projeto ASP.NET; abrir um `.cshtml` com `@model X` e `@Model.`.
   - **Esperado:** o id da linguagem do modelo é `cshtml` (não `aspnetcorerazor`).
   - **Observar:** `monaco.editor.getModels().find(m => m.uri.path.endsWith('.cshtml')).getLanguageId()` → `"cshtml"`. Log `razor projection: preparing` e depois `razor projection: prepared` (com `available`/`missing`).
2. **Ação:** passar o mouse (hover) sobre um membro C# numa expressão `@(...)`/`@{ }`.
   - **Esperado:** tooltip com o tipo/assinatura C#; o range destacado fica **no `.cshtml`**, na posição certa.
   - **Observar:** o hover aparece; nenhuma exceção no console. (Provider: `razorProjection.ts:537`.)
3. **Ação:** digitar `@Model.` e aguardar o autocomplete.
   - **Esperado:** lista de membros do model (propriedades/métodos), com ícones corretos (Method não vira "abc"/Text).
   - **Observar:** log `provisional completion` não falha; itens vêm de `provisionalDotCompletion` (`razorProjection.ts:441`). Ícones corretos = `completionKind` (`:1060`).
4. **Ação:** Ctrl+Click (go-to-definition) num tipo/membro definido em um `.cs` do projeto.
   - **Esperado:** abre o arquivo `.cs` de destino na posição certa; se o destino estivesse na própria página, abriria no `.cshtml` (range remapeado), nunca no `.g.cs`.
   - **Observar:** `routeDefinition` (`razorProjectionRouting.ts:202`) reescreve alvo `.g.cs`→`.cshtml` e dropa outros gerados. A aba aberta é `.cs` ou `.cshtml`, **nunca** um `*.g.cs`.
5. **Ação:** introduzir um erro C# real numa expressão Razor (ex.: `@Model.PropriedadeInexistente`) e salvar.
   - **Esperado:** squiggle vermelho **na `.cshtml`**, na linha/coluna certas; aparece no painel Problemas como fonte "Fluent CSHTML"/owner `fluent-cshtml`.
   - **Observar:** `monaco.editor.getModelMarkers({ owner: "fluent-cshtml" })` retorna o marker com range dentro do `.cshtml`. Pode demorar segundos (warmup da compilação do shadow — backoff `DIAGNOSTIC_RETRY_MS`).
6. **Ação:** corrigir o erro e salvar.
   - **Esperado:** o squiggle/marker some sem precisar reiniciar o servidor.
   - **Observar:** `getModelMarkers({ owner: "fluent-cshtml" })` volta a `[]` para esse modelo.

### B.2 — Markers sempre no `.cshtml`, nunca no `.g.cs`

1. **Ação:** com diagnósticos ativos (B.1 passo 5), inspecionar todos os markers.
   - **Esperado:** todos os markers `fluent-cshtml` estão num modelo cujo uri termina em `.cshtml`; **nenhum** modelo `*.g.cs` é sequer um modelo Monaco aberto.
   - **Observar:**
     ```js
     monaco.editor.getModelMarkers({ owner: "fluent-cshtml" })
       .every(m => /\.cshtml$/i.test(m.resource.path))   // → true
     monaco.editor.getModels().some(m => /\.g\.cs$/i.test(m.uri.path)) // → false
     ```
   - **Esperado adicional:** os ranges (`m.startLineNumber`/`startColumn`) caem dentro dos limites do `.cshtml` (nenhuma linha além do `getLineCount()` do modelo).
2. **Ação:** verificar que nenhum outro owner pintou markers no `.cshtml`.
   - **Esperado:** `getModelMarkers` filtrado por owner `csharp` e por `aspnetcorerazor` retorna `[]` para o modelo `.cshtml`.
   - **Observar:**
     ```js
     const m = monaco.editor.getModels().find(x => /\.cshtml$/i.test(x.uri.path));
     monaco.editor.getModelMarkers({ owner: "csharp", resource: m.uri }).length          // → 0
     monaco.editor.getModelMarkers({ owner: "aspnetcorerazor", resource: m.uri }).length  // → 0
     ```

### B.3 — `.razor` continua com serviço próprio (não capturado pelo `.cshtml`)

1. **Ação:** abrir um `.razor` (Blazor) no mesmo workspace (ou outro projeto Blazor).
   - **Esperado:** id da linguagem do `.razor` é `aspnetcorerazor`; é servido pelo cohost (`RAZOR_SERVER_ID`), não pela projeção.
   - **Observar:** `getModels().find(m => m.uri.path.endsWith('.razor')).getLanguageId()` → `"aspnetcorerazor"`. O `LspManager.activeServerIds()` mostra `razor-projection` (do `.cshtml`) **e** o serverId do cohost separadamente — não há cruzamento. Nenhum log `razor projection: preparing` disparado por abrir o `.razor`.

### B.4 — Lifecycle: reset N vezes, StrictMode, troca de workspace (sem vazamento)

1. **Ação:** executar "Resetar Servidores de Código" na Paleta de Comandos **N vezes** (ex.: 5x), com o `.cshtml` aberto.
   - **Esperado:** após cada reset, o serviço sobe de novo e responde; a contagem de providers/listeners/markers **não cresce**.
   - **Observar (antes e depois de cada ciclo):**
     - Markers estáveis: `getModelMarkers({ owner: "fluent-cshtml" }).length` volta ao mesmo valor (não acumula duplicatas).
     - Providers estáveis: dispare hover/completion uma vez e confirme que **um** resultado aparece (sem flicker/duplicação). Opcional: contar quantos providers respondem instrumentando `lspLog` em `provideHover`.
     - Logs: cada reset gera um par `manager.stop` → `manager.start BEGIN/DONE`; `disposeLanguageClientContributions` roda no stop (`manager.ts:105`).
2. **Ação:** rodar com React StrictMode (duplo mount em dev).
   - **Esperado:** o serviço é idempotente — não dobra providers nem markers; `manager.start SKIP (already running)` aparece no segundo mount.
   - **Observar:** log `manager.start SKIP (already running) razor-projection`; contagens de B.4.1 idênticas a um mount único.
3. **Ação:** trocar de workspace (abrir outra pasta) com `.cshtml` aberto, depois voltar.
   - **Esperado:** `stopAll` derruba o serviço antigo (markers do `.cshtml` antigo limpos), o novo workspace sobe limpo; nenhum provider/listener/marker do workspace anterior sobrevive.
   - **Observar:** após a troca, `getModelMarkers({ owner: "fluent-cshtml" })` não contém recursos do workspace anterior; log `manager.stop` para `razor-projection` antes do novo `start`. Start obsoleto (se a troca correr durante um `razorPrepare` lento) é descartado com `manager.start STALE` (`manager.ts:85`).

### B.5 — Nenhum segundo provider compete por `cshtml`

1. **Ação:** com o `.cshtml` aberto, contar os providers por feature.
   - **Esperado:** exatamente 1 hover, 1 definition, 1 completion para `cshtml`; 0 semantic-tokens e 0 references com selector `cshtml`.
   - **Observar:** dispare cada feature e confirme uma única resposta. Para diagnóstico fino, instrumente `lspLog` no início de cada `provide*` em `razorProjection.ts` e confirme **uma** entrada por interação. Confirme também no console que `provideDocumentSemanticTokens` (log de `client.ts`) **nunca** é chamado com uri `.cshtml` (o provider de semantic tokens não casa `cshtml`).

### B.6 — Nenhum cohosting reintroduzido para `.cshtml`

1. **Ação:** observar o tráfego/handlers LSP enquanto edita o `.cshtml`.
   - **Esperado:** nenhum método privado de cohost (`razor/*`, `_vs_*` específico do cohost de Razor) é usado para servir o `.cshtml`; a semântica vem da projeção C# (`textDocument/hover|definition|completion|diagnostic` sobre o `.g.cs`).
   - **Observar:** os logs mostram apenas `textDocument/*` padrão (3.17) endereçando o uri `.g.cs`. O serviço ativo para `.cshtml` é `razor-projection`, não o cohost. Confirme que `SERVER_REGISTRY["cshtml"].serverId === "razor-projection"` e que abrir `.cshtml` **não** inicia o serviço `aspnetcorerazor`.

---

## Veredito (preliminar — pendente Parte B)

- **Contrato de projeção CSHTML estruturalmente preservado pela migração v10:**
  **SIM**, com a ressalva de que os itens de runtime (B.1–B.6) ainda precisam ser
  confirmados no app real. A migração não alterou nenhum arquivo de projeção; só
  mudou a fiação (`client.ts` + novos `nativeFeatures.ts`/`vscodeServices.ts`),
  e `suppressGenericBridges` continua sendo honrado exatamente como antes.
- **Maior risco de runtime a checar primeiro:** o **selector-sentinela**
  (`__razor_projection_never__`) continuar não-casando nenhum modelo real na nova
  stack `@codingame/monaco-vscode-api` — i.e., que a v10 não registre providers
  nativos globais por capability que ignorem o selector. Se isso quebrar, surge um
  segundo provider para `cshtml`/`csharp` e markers podem aparecer no `.g.cs`.
  Verificar primeiro B.5 (contagem de providers) e B.2 (markers só no `.cshtml`).
