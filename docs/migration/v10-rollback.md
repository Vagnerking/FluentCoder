# Plano de rollback — migração `monaco-languageclient` v10

> Como reverter para `monaco-languageclient@1.1.0` se a migração v10
> (ADR 0003) causar regressão crítica. Cita arquivos, dependências e commits
> afetados. Relacionado: [COMPAT.md](../../src/lsp/COMPAT.md) (seção histórica é
> o alvo do rollback), [auditoria](monaco-v10-audit.md), checklists de validação
> manual ([C#](v10-validation-csharp.md), [CSHTML](v10-validation-cshtml.md),
> [não-Roslyn](v10-validation-non-roslyn.md)).

## Quando acionar

Reverter se uma validação manual reprovar um contrato **crítico** sem correção
viável a curto prazo. Gatilhos:

- **Crítico (rollback imediato):** instância dupla do Monaco —
  `monaco.editor.getModels()` vazio com arquivos abertos / nenhum `didOpen`
  enviado / IntelliSense morto em todas as linguagens.
- **Alto (rollback se não corrigível rápido):** semantic tokens C# duplicados ou
  regredindo para `variable`; markers de diagnostics duplicados; markers CSHTML
  no `.g.cs`; URIs voltando a `file:///c%3A/...` (Roslyn em `Miscellaneous Files`);
  vazamento de providers/listeners em "Resetar Servidores de Código".

Regressões **médias** (tema semântico, references/CodeLens, cor léxica) preferem
correção pontual a rollback — não são bloqueantes do editor.

## Estratégia A — não fazer merge (preferida, antes de integrar)

A migração vive na branch `feat/monaco-v10-migration` e **não foi mergeada na
`main`**. Se a validação reprovar:

1. Não abrir/!mergear o PR (ou fechá-lo).
2. A `main` permanece na 1.x — nenhum rollback de código é necessário.
3. Manter a branch para retomar após corrigir o gatilho.

Custo: zero. É por isso que a milestone usou worktree de integração + PR.

## Estratégia B — reverter após merge

Se já estiver na `main`, reverter os commits da migração (em ordem inversa).
Commits desta milestone (branch `feat/monaco-v10-migration`):

| Commit | Issue | O que reverter |
|---|---|---|
| `2eac4ca` | #77 | grammar Monarch C# (volta a depender da contribution vanilla) |
| `8f1ba90` | #77/#78/#79 | docs de validação (revert opcional) |
| `b37c170` | #76 | `disableNativeClientFeature` / reconciliação de features |
| `086b445` | #75 | bootstrap Monaco (instância única) |
| `9cca2a5` | #74 | `createLanguageClient` → `messageTransports` |
| `330c66c` | #73 | alias Vite / `optimizeDeps` |
| `a2cbc34` | #72 | dependências (`package.json`, `package-lock.json`, `.npmrc`) |

```sh
# reverte a faixa inteira preservando histórico
git revert --no-commit a2cbc34^..2eac4ca
git commit -m "revert: rollback da migração monaco-languageclient v10 (ADR 0003)"
npm install   # reinstala a 1.x a partir do package-lock revertido
```

Os docs (ADR 0003, auditoria, validações) **não precisam** ser revertidos — são
registro histórico; marque o ADR 0003 como "revertido" se reverter o código.

## Arquivos afetados (o que muda no rollback)

### Dependências
- `package.json` — remover os 16 `@codingame/monaco-vscode-*`; voltar
  `monaco-editor` para `^0.52.2` (sem alias), `monaco-languageclient` para
  `1.1.0`, `vscode-languageclient` para `~8.0.2`, `vscode-ws-jsonrpc` para `^3.0.0`.
- `package-lock.json` — regenerado por `npm install`.
- `.npmrc` — **remover** `legacy-peer-deps=true` (era exigência só da v10).

### Bootstrap / build
- `vite.config.ts` — **restaurar** o alias `vscode → monaco-languageclient/lib/vscode-compatibility.js`
  e o `optimizeDeps.include` do shim; remover `worker.format: "es"` e os
  `optimizeDeps.exclude` do `@codingame`.
- `src/monaco-loader.ts` — restaurar o `MonacoEnvironment.getWorker` com os
  workers vanilla (editor/json/css/html/ts) e `loader.config({ monaco })`
  síncrono; remover `ensureVscodeServices()`/`whenMonacoReady`.
- `src/components/EditorPane.tsx` — remover o gate `monacoReady`.

### LSP
- `src/lsp/client.ts` — voltar a `connectionProvider.get()`; restaurar
  `ensureMonacoServices()`/`MonacoServices.install`, `defuseUnsupportedProviderRegistrations`
  e `neutralizeBuiltinDiagnosticFeature`; voltar os `getFeature(...).dispose()`.
- `src/lsp/vscodeServices.ts`, `src/lsp/nativeFeatures.ts` — **apagar** (só existem na v10).
- `src/lsp/monacoSetup.ts` — restaurar o `import csharp.contribution.js` e remover
  o grammar Monarch C# explícito (na 1.x vanilla a contribution funciona).
- `src/lsp/diagnostics.ts`, `src/lsp/references.ts` — reverter aos imports/disposes 1.x.
- `src/vite-env.d.ts` — restaurar os ambient modules `vscode`/`commands.js`.

`src/lsp/transport.ts`, `manager.ts` e todos os `servers/*` (incl. projeção
CSHTML) **não mudam** — o transport WS e o lifecycle são estáveis entre 1.x e v10.

## Pós-rollback

- `npm install` (sem `.npmrc` legacy) deve resolver a 1.x; `npm run build` e
  `npm run test:unit` (191 testes) devem passar.
- Atualizar o cabeçalho do [COMPAT.md](../../src/lsp/COMPAT.md) de volta para
  "linha 1.x atual" e anotar no ADR 0003 que a migração foi revertida e por quê.
- Registrar o gatilho de regressão numa issue de follow-up para a próxima tentativa.
