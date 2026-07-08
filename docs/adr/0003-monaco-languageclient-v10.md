# ADR 0003 — Migrar para `monaco-languageclient` v10 (stack `@codingame/monaco-vscode-api`)

- **Status:** aceito
- **Data:** 24/06/2026
- **Issues:** #68 (auditoria), #69 (spike install), #70 (spike bootstrap), #71 (esta decisão)
- **Evidência:** [docs/migration/monaco-v10-audit.md](../migration/monaco-v10-audit.md), spike `spike/issue-70-codingame-bootstrap` (`src/lsp/spike70-bootstrap.ts`, `tsc` exit 0)
- **Supersede parcialmente:** [`src/lsp/COMPAT.md`](../../src/lsp/COMPAT.md) (ISSUE-19, que pinava a 1.x)

## Contexto

O projeto usa `monaco-languageclient@1.1.0` — a última da linha 1.x — sobre o
`monaco-editor` **vanilla** (`@monaco-editor/react@4.6`). A 1.x foi escolhida
(ISSUE-19 / `COMPAT.md`) porque a v2+ troca o `monaco-editor` vanilla por
`@codingame/monaco-vscode-api`, o que, na época, conflitava com
`@monaco-editor/react` e exigiria reescrever todo o carregamento do Monaco.

O custo de manter a 1.x é uma camada de **patches de shim** frágeis em
`src/lsp/client.ts` (`defuseUnsupportedProviderRegistrations`,
`neutralizeBuiltinDiagnosticFeature`, dispose manual de features nativas) e um
alias `vscode` no Vite apontando para um arquivo interno da 1.x
(`lib/vscode-compatibility.js`). Cada feature LSP nova que um servidor anuncia
estaticamente arrisca derrubar `client.start()` com `"unsupported"`, exigindo
mais um patch. A 1.x está **sem manutenção** (a linha ativa é a 10.x).

## Spikes (Wave 1)

- **#69 — install:** `npm install` com `monaco-languageclient@10.7.0` +
  `@codingame/monaco-vscode-api@25.1.2` (16 service-overrides + transitivos, 42
  pacotes `@codingame/*`), `monaco-editor` aliasado para
  `@codingame/monaco-vscode-editor-api@25.1.2`, `vscode-languageclient@~9.0.1`,
  `vscode-ws-jsonrpc@^3.5.0`. **Resolveu sem bloqueio** em worktree isolada;
  lockfile reproduzível (+571/−115). Node `v22.22.3` / npm `11.15.0` atendem.
- **#70 — bootstrap:** protótipo standalone (`src/lsp/spike70-bootstrap.ts`)
  **type-check exit 0** contra os pacotes v10 instalados. Provou:
  1. `MonacoServices.install(monaco)` → `initialize(serviceOverrides)` com o set
     mínimo headless (`languages`, `log`, `model`, `configuration`);
  2. `connectionProvider.get()` → **`messageTransports: { reader, writer }`**;
  3. o **bridge WS/Tauri atual é reaproveitável AS-IS** (`createTransport` de
     `src/lsp/transport.ts` sem alteração);
  4. `@monaco-editor/react` **pode permanecer** — `monaco-editor` aliasado para
     `@codingame/monaco-vscode-editor-api` mantém a superfície `monaco.*`.

## Decisão

**Migrar para `monaco-languageclient@10.7.0` (stack `@codingame/monaco-vscode-api`).**

A viabilidade técnica está provada e o ganho estratégico (sair de uma linha sem
manutenção, eliminar os patches de shim, ter os serviços reais do VS Code)
justifica o custo. A migração segue **em worktree de integração**, com **commit
por issue** (#72→#76) e **rollback por um único ponto de bootstrap**, mantendo o
contrato de instância única do Monaco e todos os contratos de `editor.md` /
`cshtml-language-service.md`.

### Riscos aceitos

A migração toca todos os contratos sensíveis (detalhe em
[monaco-v10-audit.md](../migration/monaco-v10-audit.md) §2–§4). Os de maior
severidade e a mitigação:

| Risco | Severidade | Mitigação |
|---|---|---|
| Instância dupla do Monaco (editor vs LSP) → `getModels()` vazio, zero IntelliSense | Crítica | Uma única `initialize()` da stack `@codingame` antes de qualquer editor; `monaco-editor` aliasado; validar `getModels()` não-vazio (#75/#77) |
| Duplicação de semantic tokens C# (feature nativa + bridge manual) → tipos viram `variable` | Alta | Reconciliação #76: escolher **um** dono por feature (manter bridge e desligar nativo, ou adotar nativo e remover bridge). Validar `DateTime=struct`, sem regressão (#77) |
| Duplicação de diagnostics → markers/Problemas duplicados | Alta | Reconciliação #76 + dedup por owner; validar contagem única (#77/#79) |
| CSHTML: duplo provider, markers no `.g.cs`, cohosting reintroduzido | Alta | `suppressGenericBridges` preservado; validar owner `fluent-cshtml` e ranges sempre no `.cshtml` (#78) |
| URIs Windows re-serializadas (`file:///c%3A/...`) → `Miscellaneous Files` | Alta | Revalidar `installWindowsFileUriSerialization` sobre a instância `@codingame` (#75/#77) |
| Lifecycle/reset: serviços globais vazam | Alta | `disposeLanguageClientContributions` mantido; "Resetar Servidores" N× sem crescer contagem (#76/#78) |
| Tema semântico não aplica | Média | Validar cores após migração; ajustar `defineTheme`/`semanticHighlighting` para a stack de tema do VS Code (#76/#77) |

### Rollback

Ponto único: o bootstrap de serviços + as versões de dependência. Reverter o
commit de #72 (deps) e o de #75 (bootstrap) restaura a 1.x. A base da 1.x fica
documentada em `COMPAT.md` (histórico) e no plano de rollback de #80. Detalhes em
[monaco-v10-audit.md](../migration/monaco-v10-audit.md) §3 e na issue #80.

## Próximos passos (milestone de implementação)

- **#72** alinhar dependências (base já validada no spike #69).
- **#73** trocar o alias Vite pelo bootstrap modular `@codingame`.
- **#74** portar `createLanguageClient` para `messageTransports` (padrão do spike #70).
- **#75** migrar o bootstrap do Monaco mantendo instância única.
- **#76** reconciliar serviços v10 com os bridges customizados (o item de maior risco).
- **#77/#78/#79** validar C#/Roslyn, CSHTML e servers não-Roslyn.
- **#80** atualizar docs e formalizar o plano de rollback.

As issues #72–#80 permanecem válidas como escritas; este ADR confirma que a
milestone de implementação **segue** (não foi adiada).
