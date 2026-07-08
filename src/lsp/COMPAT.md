# Compatibilidade `monaco-languageclient` — stack atual e histórico

> **Estado atual (a partir de 24/06/2026):** o projeto usa
> **`monaco-languageclient@10.7.0`** sobre a stack
> **`@codingame/monaco-vscode-api@25.1.2`**. Decisão registrada em
> [ADR 0003](../../docs/adr/0003-monaco-languageclient-v10.md); auditoria de
> contratos em [docs/migration/monaco-v10-audit.md](../../docs/migration/monaco-v10-audit.md);
> plano de rollback em [docs/migration/v10-rollback.md](../../docs/migration/v10-rollback.md).
>
> A seção "Histórico (linha 1.x)" no fim deste arquivo é a decisão **anterior**
> (ISSUE-19), mantida porque é o ponto de retorno do rollback.

## Conjunto de dependências (pinado — v10)

```jsonc
"monaco-languageclient": "10.7.0",
"monaco-editor": "npm:@codingame/monaco-vscode-editor-api@^25.1.2", // alias
"vscode-languageclient": "~9.0.1",
"vscode-jsonrpc": "~8.0.2",
"vscode-ws-jsonrpc": "^3.5.0",
"vscode-languageserver-protocol": "~3.17.5",
// + 16 service-overrides @codingame/monaco-vscode-*@^25.1.2 (ver package.json)
```

- **`.npmrc` → `legacy-peer-deps=true`** é obrigatório: `@monaco-editor/react@4.7`
  declara peer `monaco-editor ">=0.25 <1"`, e o alias `@codingame` (25.x) não
  satisfaz a faixa, mas expõe a mesma superfície `monaco.*` (provado no spike #70).
  Sem o flag, `npm install`/`npm ci` falham com `ERESOLVE`.
- **Node `>= 22` / npm `>= 11`** (validado em `v22.22.3` / `11.15.0`).

## Wiring (resumo da v10)

1. **Serviços VS Code** — `ensureVscodeServices()` (`src/lsp/vscodeServices.ts`)
   chama `initialize(serviceOverrides)` da `@codingame/monaco-vscode-api`
   **uma vez**, antes de qualquer editor ou client. Set mínimo headless:
   `languages`, `log`, `model`, `configuration` (a base layout/environment/
   extension/files/quickAccess o `initialize()` sobe sozinho). Idempotente:
   chamar `initialize()` duas vezes lança — por isso tudo passa por essa função.
   Substitui o `MonacoServices.install(monaco)` da 1.x.
2. **Instância única do Monaco** — `monaco-editor` é aliasado para
   `@codingame/monaco-vscode-editor-api`; `src/monaco-loader.ts` faz
   `ensureVscodeServices()` → `loader.config({ monaco })` (depois de resolver),
   então `@monaco-editor/react` e o LSP compartilham a MESMA instância. Sem isso,
   `monaco.editor.getModels()` fica vazio e nenhum `didOpen` é enviado.
3. **Transport** — `createTransport(port, token)` (`src/lsp/transport.ts`,
   `vscode-ws-jsonrpc`) **inalterado** desde a 1.x: devolve `{ reader, writer }`.
4. **Client** — `new MonacoLanguageClient({ id, clientOptions, messageTransports: { reader, writer } })`
   (`src/lsp/client.ts`). **Mudança-chave vs 1.x:** `messageTransports` no
   construtor em vez de `connectionProvider.get()`.
5. **Dedup de providers** — na v10 as features nativas do `vscode-languageclient`
   auto-registram providers a partir das capabilities. Como mantemos os bridges
   manuais (semantic tokens / diagnostics / references), `disableNativeClientFeature()`
   (`src/lsp/nativeFeatures.ts`) neutraliza `initialize`+`register` da feature
   nativa **antes** de `start()`, deixando o bridge como único provider. Ver
   ADR 0003 / issue #76.
6. **Workers** — `configureDefaultWorkerFactory()` (de
   `monaco-languageclient/workerFactory`) registra os workers que a stack usa
   (editor + textmate). Os workers vanilla json/css/html/ts foram removidos:
   IntelliSense vem dos LSP reais e o worker TS embutido fica desligado.
7. **Coloração léxica C#** — o build `@codingame` stuba `vs/basic-languages/*`
   para `empty.js`; por isso `src/lsp/monacoSetup.ts` registra um grammar Monarch
   C# explícito (`ensureCsharpLanguage`) em vez de importar a contribution morta.
   Roslyn segue sobrepondo os semantic tokens por cima (issue #77).

## Contratos preservados (validados — ver docs/migration/v10-validation-*.md)

- **Instância única do Monaco** (pré-requisito crítico).
- **C#/Roslyn:** defer de semantic tokens até `projectInitializationComplete`;
  pull de diagnostics; URIs `file:///c:/...`; `registerEditorOpener` cross-file.
- **CSHTML projeção:** `suppressGenericBridges`, owner `fluent-cshtml`, ranges
  sempre no `.cshtml`, `.razor` separado — lógica de projeção **intocada** pela
  migração.
- **Não-Roslyn (TS/JS, JSON, npm, system):** todos via `createLanguageClient`/
  `LspManager`; push diagnostics com feature nativa desabilitada; reset cobre tudo.

---

## Histórico — ISSUE-19: por que a 1.x foi escolhida originalmente

> Mantido como **ponto de retorno do rollback**. Foi a decisão vigente até a
> migração v10 (ADR 0003).

Versão pinada à época: **`monaco-languageclient@^1.1.0`** (a última da linha 1.x),
com `monaco-editor@^0.52` vanilla + `@monaco-editor/react@4.6` e
`MonacoServices.install(monaco)`.

### Por quê (à época)

A partir da **v2**, `monaco-languageclient` passou a depender de
`vscode: npm:@codingame/monaco-vscode-api`, que **substitui** o `monaco-editor`
vanilla. Em junho/2026 isso conflitava com `@monaco-editor/react@4.6` e exigiria
reescrever o carregamento do Monaco. A 1.x evitava isso usando o `monaco-editor`
vanilla como peer e expondo `MonacoServices.install` + `MonacoLanguageClient`.

| Versão | Dependência de Monaco | Decisão à época |
| --- | --- | --- |
| `>= 2.0.0` | `npm:@codingame/monaco-vscode-api` | ❌ conflitava com `@monaco-editor/react@4.6` |
| `1.x` (1.0.0–1.1.0) | nenhuma (peer `monaco-editor` vanilla) | ✅ escolhida (ISSUE-19) |
| `0.18.x` | `vscode-languageclient@7` / `vscode-jsonrpc@6` | protocolo mais antigo |

**O que mudou e destravou a v10:** as versões 25.x de `@codingame` passaram a
oferecer o alias `monaco-editor → @codingame/monaco-vscode-editor-api`, que mantém
a superfície `monaco.*` e convive com `@monaco-editor/react` (com
`legacy-peer-deps`). O spike #70 provou a viabilidade; ADR 0003 aprovou migrar.

### Wiring antigo (1.x)

1. `MonacoServices.install(monaco)` — uma vez, no bootstrap.
2. `toSocket(ws)` → `WebSocketMessageReader`/`WebSocketMessageWriter`.
3. `new MonacoLanguageClient({ name, clientOptions, connectionProvider })` com
   `connectionProvider.get()` retornando `{ reader, writer }`.
4. `client.start()`.

Patches de shim que existiam só na 1.x (todos removidos na v10):
`defuseUnsupportedProviderRegistrations`, `neutralizeBuiltinDiagnosticFeature`,
o alias Vite `vscode → monaco-languageclient/lib/vscode-compatibility.js`.
