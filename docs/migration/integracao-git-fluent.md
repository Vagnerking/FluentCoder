# Integração do Git Fluent Workspace — log de decisões de conflito

Este documento registra cada decisão não trivial tomada ao integrar o ramo
`origin/feat/git-fluent-workspace-polish` (Rafael, 7 commits, 08/07/2026) na
`main` atual e, depois, com `preview/integracao`. **Rafael: revise as seções
marcadas com "⚠ revisar".**

## Etapa 1 — `feat/git-fluent-workspace` (ramo do Rafael atualizado sobre a `main`)

### Base de merge real: `7cd3b93`, não `371c99f`

O merge-base formal do ramo com a `main` é `371c99f` (24/06), mas o ramo foi
montado sobre um snapshot posterior da `main`, trazido sem histórico comum.
Medição: o ramo difere de `7cd3b93` (merge do PR #87, 04/07/2026) **somente**
nos arquivos do próprio trabalho do Rafael — todos os arquivos "paralelos"
(`src-tauri/src/agents/*`, `dap/*`, `razor/*`, `lsp/*`, `text_io.rs`,
`testrunner.rs`, `src/lsp/*`, `src/dap/*`, `docs/context/agentes-ia.md`, os
docs de migração v10, fixtures, e2e etc.) são byte a byte iguais a algum commit
da `main` até `7cd3b93`, exceto por rustfmt e pelo helper `child_process.rs`.

Por isso o merge foi feito como 3-way com base `7cd3b93`
(`git merge-tree --merge-base=7cd3b93`), registrado como merge comum
(pais: ponta do ramo do Rafael + `main`). Com a base certa, os ~37 conflitos
aparentes (add/add em arquivos que a `main` evoluiu depois) caíram para 6
conflitos reais. Efeito prático: tudo que a `main` evoluiu depois de `7cd3b93`
(milestones C# #5–#11, Razor, DAP, hover, escala de interface, encoding,
janela macOS…) vence automaticamente, e só as mudanças genuínas do Rafael são
reaplicadas por cima.

### Mudanças "infra" do Rafael preservadas (merge limpo)

| Arquivos | O que o ramo tinha | Decisão |
|---|---|---|
| `src-tauri/src/child_process.rs` (novo) + `lsp/*`, `razor/*`, `dap/*`, `git.rs`, `testrunner.rs`, `package_intel.rs` | Helper único `hide_console_window`/`hide_tokio_console_window` substituindo os blocos `#[cfg(windows)] creation_flags(CREATE_NO_WINDOW)` espalhados | Mantido. Comportamento idêntico ao da `main` (mesma flag), só centralizado. Spawns novos que a `main` adicionou depois de `7cd3b93` continuam com o bloco inline (funcionalmente equivalentes). |
| vários `.rs` | rustfmt | Mantido onde mesclou limpo; sem efeito de comportamento. |
| `src-tauri/src/mcp.rs`, `docs/context/agentes-ia.md` | Nova tool MCP `get_graph_overview` + parágrafo no contrato | Mantido (adição, não contradiz o contrato da `main`). |

### Conflitos reais (6)

| Arquivo | Ramo (Rafael) | `main` | Resolução |
|---|---|---|---|
| `src-tauri/src/window.rs` | `open_new_window` ganhou `local_attach` (abrir pasta/workspace local em nova janela) e criava `effects` Mica antes do builder | Builder por plataforma (Mica só no Windows; macOS com barra nativa) | Mantido o `match (remote_attach, local_attach)` do Rafael; descartado o `let effects` solto (a `main` já aplica Mica dentro do bloco `cfg(windows)`). |
| `src/lsp/servers/razorProjection.ts` | Carregava `cshtmlHtmlService` sob demanda (`import()` dinâmico) para aliviar o bundle | Importa estaticamente mais símbolos do serviço (`cshtmlFolding`, `cshtmlDocumentSymbols`) + colorizador semântico | **Versão da `main` integralmente** (contrato CSHTML; o import estático novo anularia o lazy-load). ⚠ revisar: se quiser o code-split, refazer sobre a `main` cobrindo os novos símbolos. |
| `src/components/RunPanel.tsx` | Painel multi-raiz (`workspaceRoots`, `RunRootSection`, raízes SSH conectadas executáveis; `onRun(command, cwd, connId)`) | `pendingTest` (CodeLens de teste → executar/depurar), `ProjectActionsSection` (build/clean/restore), `useRef` | Estrutura multi-raiz do Rafael + `pendingTest` repassado à raiz local que contém o `.csproj` (`pendingTestForRoot`) + `ProjectActionsSection` por raiz local. Seções .NET continuam ocultas em raízes SSH. |
| `src/components/EditorPane.tsx` | Imports do `packageIntelStore` (inlay de versões/auditoria de pacotes); objeto `options` inline com `readOnly`/`readOnlyMessage` (revisões Git somente leitura), `codeLens*`, `lineDecorationsWidth` | Opções extraídas para `editorOptions.ts` (`EDITOR_OPTIONS`, travado por teste: `hover.above`, sticky scroll off, word-based off, semantic highlighting off) | Imports dos dois lados; `options={{ ...EDITOR_OPTIONS, readOnly, readOnlyMessage, codeLens, codeLensFontSize, codeLensFontFamily, lineDecorationsWidth }}`. As opções protegidas da `main` ficam intactas. |
| `src/App.tsx` (3 trechos) | `PackagesPanel`; view `packages`; `RunPanel` com `workspaceRoots`; view `backlinks` substituída por `graph` (Grafo + Backlinks juntos); encoding oculto também para `activeFile.workspaceRemote` | `NugetManager`, eventos `RUN_TEST_EVENT`/`DEBUG_TEST_EVENT`, `pendingTest`; comentário novo de encoding (save-with-encoding) | União: imports dos dois; `RunPanel` recebe `workspaceRoots` **e** `pendingTest`; mantida a view `packages` e o par `graph`/backlinks do Rafael; condição de encoding = condição do Rafael (inclui raízes SSH de workspace) com o comentário atualizado da `main`. |
| `src/styles.css` | Virou um entry de 10 linhas; o CSS foi dividido em `src/styles/*.css` (importados em `src/main.tsx`) | +109 linhas desde `7cd3b93` | Mantida a divisão do Rafael. As adições da `main` foram portadas para os arquivos correspondentes: fundo opaco/titlebar do macOS → `styles/shell.css`; folga do hover de símbolo → `styles/editor-monaco-hover.css`; `.symbol-kind-tag` → `styles/overlays.css`; breakpoint condicional/logpoint, árvore de variáveis/watch, árvore de testes, cobertura, modal NuGet, `.run-action-output` → `styles/panels-debug.css`. |

### Seletores do CSS da `main` que não existem na divisão

`.confirm-button.danger/.primary`, `.git-branch-row`, `.git-group-toggle(:hover)`,
`.monaco-editor .git-lens-inline-active`: o Rafael renomeou/removeu essas
classes junto com os componentes (nenhum `.tsx` as referencia mais). Nada a
portar.

### Testes ajustados

- `src/components/editorOptions.test.ts` lia `src/styles.css` para travar o
  `transform: translateY(-Npx)` do hover; agora lê
  `src/styles/editor-monaco-hover.css` (onde a regra mora na divisão).

### Observações (não bloqueiam)

- `vite.config.ts` (Rafael) define `manualChunks`; o build emite avisos
  "Circular chunk: vendor -> vendor-react -> vendor" (já existiam no ramo).
  ⚠ revisar: ciclos entre chunks manuais podem causar erro de ordem de
  inicialização em runtime; o render headless da Etapa 2 é a verificação.
- Probe Roslyn M5 (`tools/razor-lsp-probe/probe-csharp-m5.mjs`): **não
  executado** — o Roslyn não está em cache nesta máquina
  (`~/.local/share/com.fluentcoder.app/lsp/roslyn/` inexistente). O ramo não
  altera nada do pipeline C#/LSP do frontend (a `main` vence nesses arquivos).
