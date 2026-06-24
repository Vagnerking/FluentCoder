# Auditoria de contratos Monaco/LSP antes da migração para `monaco-languageclient` v10

> Issue #68. Documento de referência para todas as fases da migração
> `monaco-languageclient` **1.1.0 → 10.7.0** (que arrasta a stack
> `@codingame/monaco-vscode-api`). Tarefa de auditoria — **somente leitura**,
> nenhum código foi alterado.
>
> Leia junto: [`editor.md`](../context/editor.md),
> [`cshtml-language-service.md`](../context/cshtml-language-service.md),
> [`command-palette.md`](../context/command-palette.md),
> [`src/lsp/COMPAT.md`](../../src/lsp/COMPAT.md) (decisão original de pinar a 1.x).

## Versões atuais (pinadas)

| Pacote | Versão atual | Observação |
|---|---|---|
| `monaco-editor` | `^0.52.2` | distribuição **vanilla** (não-`@codingame`) |
| `@monaco-editor/react` | `^4.6.0` | carrega Monaco via `loader.config({ monaco })` |
| `monaco-languageclient` | `1.1.0` | última da linha 1.x sem `@codingame` |
| `vscode-languageclient` | `~8.0.2` | LSP client base |
| `vscode-jsonrpc` | `~8.0.2` | JSON-RPC |
| `vscode-ws-jsonrpc` | `^3.0.0` | transport WS (`WebSocketMessageReader/Writer`) |
| `vscode-languageserver-protocol` | `^3.17.5` | tipos LSP |
| `@codingame/monaco-vscode-api` | **ausente** | passa a ser exigido a partir da v2/v10 |

O ponto central da migração (já registrado em `COMPAT.md`): a v2+ troca o
`monaco-editor` vanilla por `npm:@codingame/monaco-vscode-api`, que **substitui**
a instância do Monaco por uma com shims dos serviços reais do VS Code. Isso
conflita com `@monaco-editor/react@4.6` (que carrega o Monaco vanilla) e exige
reescrever o carregamento do Monaco inteiro.

---

## 1. Mapa de bootstrap atual

Cada ponto de fiação (`arquivo:linha`) e o que faz.

### `src/monaco-loader.ts` — unificação da instância Monaco
- `monaco-loader.ts:18` — importa `* as monaco from "monaco-editor"` (a instância
  npm vanilla compartilhada por editor **e** LSP).
- `monaco-loader.ts:30` — `installWindowsFileUriSerialization(monaco)` **antes** de
  qualquer modelo: garante URIs `file:///c:/...` (contrato Roslyn de `editor.md`).
- `monaco-loader.ts:35-56` — `self.MonacoEnvironment.getWorker`: fornece os web
  workers bundlados via Vite (`editor`, `json`, `css`, `html`, `ts`); `razor`/
  `aspnetcorerazor` caem no `htmlWorker`.
- `monaco-loader.ts:59` — `loader.config({ monaco })`: força `@monaco-editor/react`
  a usar a **mesma** instância npm. Sem isso há duas instâncias e o language client
  observa `monaco.editor.getModels()` vazio → nenhum `didOpen` → sem IntelliSense.

### `vite.config.ts` — alias e pré-bundle do shim `vscode`
- `vite.config.ts:14-19` — resolve `vscodeShim` para
  `node_modules/monaco-languageclient/lib/vscode-compatibility.js`.
- `vite.config.ts:31-37` — `resolve.alias.vscode = vscodeShim`: `vscode-languageclient`
  faz `require("vscode")`; o alias aponta para o shim de compat da 1.x.
- `vite.config.ts:40-42` — `optimizeDeps.include` de `vscode-languageclient` e
  `monaco-languageclient` para o esbuild resolver o alias `vscode`.
- `vite.config.ts:44-51` — `assetsInlineLimit` (ícones Material; não relacionado a LSP).

### `src/lsp/client.ts` — núcleo: serviços, client e bridges
- `client.ts:15` — `import * as vscodeShim from "vscode"` (o **singleton** vivo do
  shim, resolvido pelo alias do Vite — patchá-lo aqui afeta o language client).
- `client.ts:90-95` — `ensureMonacoServices()`: chama `MonacoServices.install(monaco)`
  **uma vez** + `defuseUnsupportedProviderRegistrations()`.
- `client.ts:92` — `MonacoServices.install(monaco)`: ponte v1.x que liga o Monaco
  vanilla ao runtime do language client (substituída pela stack `@codingame` na v10).
- `client.ts:116-136` — `defuseUnsupportedProviderRegistrations()` (patch de shim).
- `client.ts:161-177` — `neutralizeBuiltinDiagnosticFeature()` (patch de shim).
- `client.ts:186-313` — `createLanguageClient(config)`: resolve bridge `{port,token}`
  (`lspBridgeInfo`) → abre transport WS → cria `new MonacoLanguageClient(...)` com
  `connectionProvider.get()` retornando `{reader,writer}` → `client.start()`.
- `client.ts:200-237` — opções do client: `documentSelector`, `workspaceFolder`
  (deriva `rootUri`/`workspaceFolders` do `initialize`), `errorHandler`
  (`CloseAction.DoNotRestart`).
- `client.ts:239` — `neutralizeBuiltinDiagnosticFeature(client, serverId)` antes do start.
- `client.ts:261-293` — instala (quando `!suppressGenericBridges`) os três bridges:
  semantic tokens (`installSemanticTokensBridge`), references (`installReferencesBridge`),
  diagnostics (`installDiagnosticsBridge`).
- `client.ts:320-326` — `disposeLanguageClientContributions()`: descarta os providers
  Monaco registrados pelo client (são globais; um restante competiria com um restart).
- `client.ts:500-805` — `installSemanticTokensBridge()`: registra
  `registerDocumentSemanticTokensProvider` direto no Monaco (ver §3); dispõe o
  feature de semantic tokens do shim (`client.getFeature("textDocument/semanticTokens").dispose()`).

### `src/lsp/transport.ts` — transport WS JSON-RPC
- `transport.ts:29-55` — `toSocket(ws)`: adapta `WebSocket` ao `IWebSocket` de
  `vscode-ws-jsonrpc@3`.
- `transport.ts:68-90` — `createTransport(port, token)`: conecta a
  `ws://127.0.0.1:{port}/?token=...` e devolve `WebSocketMessageReader/Writer`.

### `src/lsp/manager.ts` — lifecycle dos clients
- `manager.ts:19-136` — `LspManager`: um client por `serverId`, chains por servidor,
  gerações para descartar starts obsoletos. `start`/`stop`/`stopAll`. Em `stop`
  chama `disposeLanguageClientContributions(client)` antes de `client.stop()`.

### `src/lsp/servers/index.ts` — registry de linguagens
- `index.ts:48-61` — `BASE_REGISTRY`: `csharp`, `typescript|javascript|*react`,
  `aspnetcorerazor` (cohost), `cshtml` (projeção, flag).
- `index.ts:66-85` — `NPM_REGISTRY` / `SYSTEM_REGISTRY` gerados de `NPM_SERVERS`/`SYSTEM_SERVERS`.
- `index.ts:90-109` — `SERVER_REGISTRY` mesclado (system > npm > base, com warn em colisão).

### `src/lsp/servers/*` — adapters por servidor
- `csharp.ts:46-83` — `startCsharpServer`: selector `[{scheme:file,language:csharp}]`,
  `diagnosticMode:"pull"`, `diagnosticIdentifiers:["syntax","DocumentCompilerSemantic"]`,
  `deferSemanticTokens:true`; depois `wireRoslynStartup`.
- `typescript.ts:51-89` — `startTypescriptServer`: selector dos 4 dialetos TS/JS,
  desabilita worker TS embutido (via `monacoSetup`), diagnostics **push**.
- `razor.ts:36-70` — `startRazorServer` (cohost): selector `aspnetcorerazor`,
  pull diagnostics + defer semantic (histórico; aposentado para `.cshtml`).
- `razorProjection.ts:159-991` — `startRazorProjectionServer` (ADR 0002):
  `suppressGenericBridges:true`, selector "nunca" (`__razor_projection_never__`),
  registra **manualmente** providers `cshtml` (hover/definition/completion +
  auto-close HTML), pull de diagnostics remapeados, owner `fluent-cshtml`.
- `roslynShared.ts:62-206` — `wireRoslynStartup`: ordem `workspace/configuration`
  handler + nudge → `projectInitializationComplete` (reopen `didClose`/`didOpen`,
  `enableLanguageClientSemanticTokens`, `stabilize`, `repullDiagnostics`) →
  `solution/open`/`project/open`.
- `npm.ts:33-71` / `system.ts:30-55` — starters genéricos (push diagnostics).
- `cshtml.ts` — **stub legado** que apenas lança erro "engine não implementada";
  não é mais alcançado (substituído pela projeção). Não está no `BASE_REGISTRY`.

### `src/lsp/monacoSetup.ts` — setup léxico/linguagens (roda em `beforeMount`)
- `monacoSetup.ts:25-36` — `setupMonacoForLsp`: desabilita worker TS embutido,
  registra ids React, registra `aspnetcorerazor` + `cshtml` (Monarch), lint
  HTML Razor, garante `csharp`, Shiki lazy.
- `monacoSetup.ts:106-130` — `disableBuiltinTsWorker`: desliga diagnostics/sugestões
  do worker TS embutido (para o LSP ser a única fonte).

### `src/components/EditorPane.tsx` — UI do editor + tema semântico
- `EditorPane.tsx:236-243` — `handleBeforeMount` chama `setupMonacoForLsp(monaco)`.
- `EditorPane.tsx:249-275` — `monaco.editor.registerEditorOpener(...)`: abre arquivo
  de outro modelo no go-to-definition / Ctrl+Click cross-file.
- `EditorPane.tsx:277-345` — `monaco.editor.defineTheme("fluent-acrylic-dark", ...)`:
  `rules` mapeando categorias semânticas Roslyn (`controlKeyword`, `class`, `struct`,
  `enum`, `interface`, `method`, `modifier`, …) → cores (contrato de `editor.md`).
- `EditorPane.tsx:521-524` — `"semanticHighlighting.enabled": true` nas opções do editor.

---

## 2. Bridges/providers customizados em risco de duplicação

A stack `@codingame/monaco-vscode-api` traz os **serviços reais do VS Code**
(languages, markers, textmate, theme), e o `vscode-languageclient` por baixo
**auto-registra** os providers padrão (semantic tokens, references, diagnostics,
hover, completion, …) a partir das capabilities do `initialize`. Hoje esses
caminhos são neutralizados/substituídos manualmente. Se a v10 reativá-los e os
bridges manuais continuarem, haverá **dois** providers para a mesma
feature/linguagem → cores piscando/sobrescritas, markers duplicados no painel
Problemas, peek de referências dobrado.

| Provider Monaco | Language selector | Onde registra | Risco na v10 |
|---|---|---|---|
| `registerDocumentSemanticTokensProvider` | selector do client (`csharp`; `aspnetcorerazor` no cohost) | `client.ts:639-732` (`installSemanticTokensBridge`); dispõe `getFeature("textDocument/semanticTokens")` em `client.ts:517-518` | **Alto.** A v10 deixa o `SemanticTokensFeature` registrar seu próprio provider. Dois providers → Roslyn classifica duas vezes; a corrida provisório→definitivo (`stabilize`, descarte de respostas antigas) volta a quebrar (`DateTime`/enum vira `variable`). Contrato direto de `editor.md`. |
| `registerReferenceProvider` + override do comando `editor.action.showReferences` | selector do client (`csharp`) | `references.ts:137-167` (`installReferencesBridge`) | **Médio/Alto.** A v10 pode registrar reference provider próprio → peek dobrado; e o override de `editor.action.showReferences` (CodeLens "N referências") pode colidir com o handler nativo da nova stack. |
| `setModelMarkers(model, serverId, ...)` push **e** pull de diagnostics | selector do client (`csharp` pull; TS/JS/npm/system push) | `diagnostics.ts:173-498` (`installDiagnosticsBridge`); dispõe `getFeature("textDocument/diagnostic")` em `diagnostics.ts:215` e neutraliza em `client.ts:161-177` | **Alto.** A v10 traz `DiagnosticFeature` funcional (lê `vscode.window.tabGroups`, que agora existe de verdade). Se ele rodar **e** o bridge também, há markers/Problemas duplicados; a dedup por owner deixa de proteger porque a feature usa owner próprio. |
| Providers `cshtml` (hover, definition, completion, auto-close) + pull de diagnostics remapeados | `cshtml` (id Monaco), owner markers `fluent-cshtml` | `razorProjection.ts:536-680, 348-417` (sob `suppressGenericBridges:true`) | **Médio.** O client de projeção usa selector "nunca", então a stack não deveria anexar providers a modelos reais. Mas se a v10 mudar como `documentSelector` casa (ou se a stack registrar providers globais por capability), o selector-sentinela pode deixar de blindar → providers concorrentes em `.cshtml`. Contrato "somente um provider por feature reivindica `cshtml`" (`cshtml-language-service.md`). |
| `registerEditorOpener` (go-to-definition cross-file) | global | `EditorPane.tsx:251` | **Médio.** A stack `@codingame` tem seu próprio serviço de abertura de editor/workbench; o opener custom pode ser ignorado ou competir. |
| Tema semântico (`defineTheme` + `semanticHighlighting.enabled`) | global | `EditorPane.tsx:277, 521-524` | **Médio.** A v10 usa o serviço de tema/TextMate do VS Code; o `defineTheme` standalone e o flag literal `true` (em vez de `configuredByTheme`) podem não surtir efeito, fazendo as cores semânticas sumirem mesmo com tokens corretos. |

**Por que não pode haver duplo registro:** providers de linguagem no Monaco são
**globais por linguagem**; dois providers da mesma feature para o mesmo selector
são ambos consultados e o último a responder vence. Para semantic tokens isso
reintroduz exatamente a regressão que `editor.md` proíbe (resposta antiga
sobrescreve a correta, tipo vira `variable`); para diagnostics, duplica markers
e fura a dedup por owner; para references, dobra o peek.

---

## 3. Patches v1.x específicos (existem por causa do shim de compat)

| Patch | Onde | Por que existe na 1.x | Ainda necessário na v10? |
|---|---|---|---|
| `MonacoServices.install(monaco)` | `client.ts:92` | Liga o Monaco vanilla ao runtime do language client (a 1.x não usa `@codingame`). | **Não.** A API foi removida na v2+. A inicialização passa a ser `initialize({...})` da `@codingame/monaco-vscode-api` (services de languages/markers/textmate/theme/etc.) antes de criar qualquer client/editor. |
| `defuseUnsupportedProviderRegistrations()` | `client.ts:116-136` | O shim 1.x implementa `registerLinkedEditingRangeProvider`/`TypeHierarchy`/`EvaluatableExpression`/`InlineValues` como `throw "unsupported"`; o TS server anuncia `linkedEditingRangeProvider` estaticamente e derruba o `start()`. | **Não (provavelmente).** Na v10 esses providers existem de verdade no `monaco-vscode-api`, então não há throw. **Verificar**: se algum deles ainda não tiver serviço, voltar a guardar. |
| `neutralizeBuiltinDiagnosticFeature()` | `client.ts:161-177` | O `DiagnosticFeature` da 1.x constrói um `Tabs` que lê `vscode.window.tabGroups`, implementado como `throw "unsupported"` no shim → `start()` rejeita "unsupported" (TS e JSON anunciam pull estático). | **Não — mas vira decisão.** Na v10 `tabGroups` existe e a feature funciona. A escolha passa a ser: **manter o bridge manual e desligar a feature** (preserva owner/dedup atuais) **ou** adotar a feature nativa e **remover** o bridge de diagnostics. Não pode rodar os dois (duplicação — §2). |
| Alias Vite `vscode` → `monaco-languageclient/lib/vscode-compatibility.js` | `vite.config.ts:14-37` | Resolve o `require("vscode")` do `vscode-languageclient` para o shim de browser da 1.x. | **Não.** Na v10 `vscode` é resolvido por `@codingame/monaco-vscode-api` (o pacote registra `vscode` como entry). O alias atual deve ser **removido/trocado**; manter o alise antigo quebraria o singleton da nova stack. `optimizeDeps.include` e o `import * as vscodeShim` (`client.ts:15`) também mudam. |
| Dispose manual de features (`getFeature("textDocument/semanticTokens").dispose()`, `getFeature("textDocument/diagnostic").dispose()`) | `client.ts:517-518`, `diagnostics.ts:215` | Evita que o provider do shim concorra com o bridge manual. | **Talvez.** Só permanece necessário se a decisão for manter os bridges manuais sobre a v10. Se adotarmos os features nativos, esses disposes saem (e os bridges também). |
| `installWindowsFileUriSerialization(monaco)` | `monaco-loader.ts:30` | Garante URIs `file:///c:/...` (não `file:///c%3A/...`) — contrato Roslyn. | **Sim, mas adaptar.** O requisito de URI não muda; mas a forma de aplicar sobre a instância `@codingame` precisa ser revalidada (a serialização de `Uri` pode passar por outro caminho). |
| `loader.config({ monaco })` (`@monaco-editor/react`) | `monaco-loader.ts:59` | Força React a usar a instância npm. | **Possivelmente eliminado.** A v10 normalmente substitui `@monaco-editor/react` pela montagem via `@codingame` (`COMPAT.md` já alertava). Decisão de arquitetura a tomar na migração. |

---

## 4. Matriz de riscos

| Área | Contrato que pode quebrar | Severidade | Como detectar |
|---|---|---|---|
| Instância única do Monaco | Editor e LSP precisam compartilhar **uma** instância (`editor.md`: "não criar segunda instância"). A stack `@codingame` substitui o `monaco-editor`; coexistir com `@monaco-editor/react`+vanilla cria duas instâncias → `getModels()` vazio → zero IntelliSense. | **Crítica** | `monaco.editor.getModels()` lista os modelos abertos; log "models at start" (`client.ts:298-310`) deve mostrá-los. Se vazio com arquivos abertos → duas instâncias. |
| Semantic tokens C# | Duplo provider (nativo + bridge) reintroduz corrida provisório→definitivo; tipos viram `variable`. | **Alta** | Abrir `.sln`, esperar `projectInitializationComplete`; `DateTime`=`struct`, enum do projeto=`enum`, `if`/`return`=`controlKeyword`; esperar 1+ refresh e confirmar que **não** voltam a `variable` (critérios `editor.md`). Logar `provideDocumentSemanticTokens` e contar quantos providers respondem. |
| Diagnostics (pull C# / push TS-JSON) | `DiagnosticFeature` nativo + bridge manual = markers e linhas de Problemas duplicados; dedup por owner deixa de cobrir. | **Alta** | Abrir arquivo com erro; contar markers (`monaco.editor.getModelMarkers`) e linhas no painel Problemas — devem ser únicos por diagnóstico. |
| Ordem de inicialização Roslyn | `solution/open` → `projectInitializationComplete` → rebind `didClose`/`didOpen` → habilitar semantic. Se a v10 reabrir documentos ou disparar requests semânticos cedo, contexto vira `Miscellaneous Files`. | **Alta** | `textDocument/_vs_getProjectContexts` deve retornar o projeto certo e `_vs_is_miscellaneous:false`; URI no formato `file:///c:/...`. |
| URIs Windows | A nova stack pode re-serializar `Uri` como `file:///c%3A/...`. | **Alta** | Inspecionar a URI enviada no `didOpen` (log de modelos `client.ts:298-310`); deve ser `file:///c:/...`. |
| CSHTML projection (providers + owner) | Duplo provider em `cshtml`; markers no `.g.cs` em vez do `.cshtml`; reintrodução de cohosting para `.cshtml`. | **Alta** | Hover/completion/definition num `.cshtml`; markers no modelo `.cshtml` (owner `fluent-cshtml`), nunca no `.g.cs`; `.razor` continua `aspnetcorerazor`; contagem de providers para `cshtml` = 1 por feature. |
| Lifecycle / "Resetar Servidores de Código" | Providers/listeners vazam em restart/StrictMode/troca de workspace (a stack pode reter serviços globais). | **Alta** | Rodar "Resetar Servidores de Código" N vezes; contagem de providers/listeners/markers não cresce; `disposeLanguageClientContributions` continua sendo chamado (`manager.ts:103-110`). |
| References / CodeLens | Peek de referências dobrado; override de `editor.action.showReferences` colide com handler nativo. | **Média** | Shift+F12 e clicar "N referências" do Roslyn; abre **um** peek com os destinos certos. |
| Tema semântico / cores | `defineTheme` standalone + `semanticHighlighting.enabled:true` literal podem não valer na stack de tema do VS Code → cores semânticas somem. | **Média** | Conferir cores das categorias mesmo com tokens corretos no log; se token=`class` mas cor default → tema não aplicou. |
| Go-to-definition cross-file | `registerEditorOpener` ignorado pelo serviço de editor do `@codingame`. | **Média** | Ctrl+Click em tipo de outro arquivo → abre a aba do destino na posição certa. |
| Transport WS | `vscode-ws-jsonrpc`/`vscode-jsonrpc` bump pode alterar a API de reader/writer/`toSocket`. | **Média** | Conexão WS abre, `client.start()` resolve, requests respondem (log `client.start() RESOLVED`). |
| Crash por provider "unsupported" | Se algum feature ainda não tiver serviço na v10, o `start()` volta a lançar "unsupported". | **Média** | `client.start()` resolve sem throw para todos os servers (log `THREW`/`RESOLVED` em `client.ts:243-256`). |
| Servers não-Roslyn (TS/JS, JSON/NPM, system) | Mudança de capabilities/diagnostics; worker TS embutido reativado competindo com o LSP. | **Média** | Completions/hover/diagnostics únicos em TS/JS/JSON; worker TS embutido continua desligado (`monacoSetup.ts:106-130`). |
| Bundle / Vite | Remoção do alias `vscode` e `optimizeDeps`; `@codingame` exige config de workers/assets própria. | **Média** | `vite build`/`tauri build` conclui; app sobe sem erro de módulo `vscode`. |

---

## 5. Critérios de sucesso e testes obrigatórios por linguagem

> Reaproveitam os critérios de aceite de **#77** (C#), **#78** (CSHTML) e **#79**
> (não-Roslyn). C# e CSHTML também acionam os critérios de `editor.md`/
> `cshtml-language-service.md` por tocarem registry/Monaco/lifecycle LSP.

### C# / Roslyn (issue #77)

**Manual (obrigatório):**
1. Abrir pasta com `.sln` + múltiplos `.csproj`; abrir um `.cs` de um projeto da solution.
2. Confirmar `solution/open` (ou `project/open` sem `.sln`) e `projectInitializationComplete`.
3. Confirmar rebind `didClose`/`didOpen` após a init.
4. `textDocument/_vs_getProjectContexts` → projeto correto, `_vs_is_miscellaneous:false`.
5. Classificação final: `DateTime`=`struct`, enum do projeto=`enum`, classe base=`class`,
   `if`/`return`=`controlKeyword`.
6. Esperar 1+ refresh do Roslyn e confirmar que os tipos **não** voltam para `variable`.
7. Ctrl+Click em tipo definido em outro arquivo abre o destino correto.
8. Diagnostics pull aparecem (squiggle + Problemas) e somem ao corrigir.

**Automatizado (obrigatório):**
- Testes unitários existentes do pipeline (`csharpConfiguration.test.ts` etc.).
- Smoke/E2E (tauri-driver) abrindo um workspace `.sln` e checando que **um único**
  semantic-tokens provider responde por `csharp` (sem duplo registro).

### TypeScript / JavaScript (issue #79)

**Manual (obrigatório):**
- Abrir `.ts`/`.tsx`/`.js`/`.jsx`: completions, hover e diagnostics do
  `typescript-language-server` (não do worker embutido).
- Confirmar que markers de diagnostics **não** duplicam (worker embutido desligado).
- Falha controlada quando o server não está instalado (mensagem, sem crash).

**Automatizado (obrigatório):**
- Smoke de startup/shutdown do `typescript` server; sem crash "unsupported".
- Asserção de que o worker TS embutido continua com diagnostics desligados.

### JSON / NPM servers e system (issue #79)

**Manual (obrigatório):**
- JSON: completions/hover/validação do JSON language server.
- Pelo menos um server npm adicional (ex.: Pyright/YAML) sobe e responde, ou
  falha com mensagem controlada se ausente.
- Confirmar push diagnostics sem markers duplicados.

**Automatizado (obrigatório):**
- Iteração sobre `SERVER_REGISTRY`: cada server **sobe** ou **falha com mensagem
  controlada** (nenhum crash por provider unsupported).
- Markers/providers removidos ao fechar workspace ou em "Resetar Servidores de Código".

### CSHTML (projeção C# + Roslyn) (issue #78)

**Manual (obrigatório):**
- Abrir `.cshtml` de um projeto; hover, completion (incl. `@Model.`), definition e
  diagnostics **remapeados** do `.g.cs` para o `.cshtml`.
- Markers no modelo `.cshtml` (owner `fluent-cshtml`), **nunca** no `.g.cs`; ranges
  sempre no `.cshtml`.
- `.razor` continua separado (id `aspnetcorerazor`, cohost); não capturado pelo serviço `.cshtml`.
- Disposal em restart/StrictMode/troca de workspace sem vazar providers/listeners/markers.
- Sem cohosting reintroduzido para `.cshtml`.

**Automatizado (obrigatório):**
- Testes unitários de projection/routing (`razorProjectionRouting.test.ts`,
  `cshtmlHtmlProjection.test.ts`) continuam verdes.
- Checklist de "migração sem providers duplicados" de `cshtml-language-service.md`
  (um provider por feature reivindica `cshtml`; rollback por único feature flag/registry).

---

## 6. Lista explícita do que pode quebrar (1.1.0 → 10.7.0)

1. **Instância dupla do Monaco** — `@codingame/monaco-vscode-api` substitui o
   `monaco-editor` vanilla; conviver com `@monaco-editor/react` cria duas
   instâncias → `getModels()` vazio → **sem IntelliSense** (risco crítico).
2. **`MonacoServices.install` removido** (`client.ts:92`) — a v2+ não tem essa API;
   a inicialização vira `initialize({...services})` do `monaco-vscode-api`.
3. **Alias Vite `vscode` quebra** (`vite.config.ts:14-37`) — o `require("vscode")`
   passa a ser servido pela nova stack; manter o alias antigo corrompe o singleton.
4. **Duplicação de semantic tokens** — feature nativa + bridge manual reintroduzem
   a corrida provisório→definitivo (tipos viram `variable`).
5. **Duplicação de diagnostics** — `DiagnosticFeature` nativo (com `tabGroups` real)
   + bridge manual → markers/Problemas duplicados, dedup por owner furada.
6. **Duplicação de references / colisão de `editor.action.showReferences`** — peek dobrado.
7. **Patches de shim viram dead code ou quebram** — `defuse...` e
   `neutralizeBuiltinDiagnosticFeature` deixam de fazer sentido; mantidos sobre a v10
   podem desligar features que agora deveriam funcionar.
8. **Tema semântico não aplica** — `defineTheme` standalone + `semanticHighlighting.enabled:true`
   literal podem ser ignorados pela stack de tema/TextMate do VS Code → cores semânticas somem.
9. **`registerEditorOpener` ignorado** — go-to-definition cross-file pode parar de
   abrir a aba certa (a stack tem serviço de editor próprio).
10. **Re-serialização de URI** — risco de voltar a `file:///c%3A/...`, quebrando o
    contrato Roslyn → `Miscellaneous Files`.
11. **CSHTML projection** — selector-sentinela pode deixar de blindar; risco de
    duplo provider em `cshtml`, markers no `.g.cs`, ou reintrodução de cohosting.
12. **Lifecycle/reset** — serviços globais da nova stack podem vazar em
    restart/StrictMode/troca de workspace; `disposeLanguageClientContributions`
    pode não cobrir o que a stack registra.
13. **Bump de `vscode-languageclient`/`vscode-jsonrpc`/`vscode-ws-jsonrpc`** — a v10
    exige versões alinhadas à `@codingame`; APIs de transport/feature podem mudar.
14. **Crash "unsupported"** — se algum feature não tiver serviço registrado na nova
    stack, `client.start()` volta a rejeitar.
15. **Bundle/build** — workers, assets e `optimizeDeps` exigem reconfiguração;
    risco de `vite build`/`tauri build` falhar por módulo `vscode` não resolvido.
16. **`@monaco-editor/react`** — provavelmente substituído pela montagem `@codingame`,
    exigindo reescrita parcial de `EditorPane.tsx`.

---

## Risco mais importante

**Instância dupla do Monaco.** A v10 troca o `monaco-editor` vanilla pela
distribuição `@codingame/monaco-vscode-api`. Se isso não for unificado com o
carregamento atual (`@monaco-editor/react` + `loader.config({ monaco })` em
`monaco-loader.ts`), editor e LSP passam a observar instâncias diferentes: o
language client vê `monaco.editor.getModels()` vazio, nunca envia `didOpen`, e
**nenhuma** linguagem ganha IntelliSense/diagnostics — uma quebra total e
silenciosa do editor. É o pré-requisito que destrava (ou bloqueia) todos os
demais contratos. `COMPAT.md` já apontava isso como o motivo de pinar a 1.x.
