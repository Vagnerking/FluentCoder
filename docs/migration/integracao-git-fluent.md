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

## Etapa 2 — `integracao/git-fluent` (Etapa 1 + `preview/integracao`)

`preview/integracao` = `main` + 56 commits (Fluent Chat, host de extensões VS
Code, ponte IDE do Claude, janela frameless no Linux, primitivos de UI e fase
visual 2). Base do merge: `main` (c965a78). 21 conflitos textuais.

### Conflitos de código

| Arquivo | Ramo (Rafael) | Preview | Resolução |
|---|---|---|---|
| `src/App.tsx` — chat | `AgentSidebar` + store de agentes por raiz ativa (código da `main`, não do Rafael) e `handleGitAssist` (mensagem de commit pelo agente) | Fluent Chat (`useFluentChat`, abas Chat/Agentes) | **Fluent Chat vence.** O `useFluentChat` passa a receber `agentWorkspaceRoot`/`agentWorkspaceRootRef` do Rafael (o chat segue a raiz LOCAL em foco num Fluent Workspace). `handleGitAssist` portado: turno único `ask` com o alvo/modelo atual do Fluent Chat (`chat.target`, `chat.model`, `agentRunOptions`), id de conversa descartável (não entra no histórico), só raízes locais. ⚠ revisar: antes usava “o primeiro agente do workspace”; agora usa o alvo selecionado no composer do chat. |
| `src/App.tsx` — `isVirtualTab` | grafo + revisões/diffs Git | grafo + painéis webview | União (as duas definições viraram uma). |
| `src/App.tsx` — sidebar | `SIDEBAR_MIN_HORIZONTAL_ACTIVITY = 396` (activity bar topo/base) | `SIDEBAR_MIN_TOP = 280` | Mantido o do Rafael (a activity bar dele tem mais ícones: Pacotes, Grafo). |
| `src/App.tsx` — demais | sessão do workspace, `activeContextTarget`, backlinks multi-raiz, props do grafo | `viewColumn` dos webviews | União. |
| `src/api.ts` `termCreate` | parâmetro `connId` (terminal SSH por raiz de workspace) | parâmetro `spawn` (terminais de extensão) e retorno do pid | Assinatura `termCreate(id, cwd, cols, rows, command, spawn, connId)`; `connId` explícito tem precedência sobre a sessão remota da janela. |
| `TerminalView.tsx` / `TerminalPanel.tsx` | `connId` | `spawn`/`attach`/`onReady`/`onExit` | União das props. |
| `EditorGroupView.tsx` | props do grafo por raiz; `MediaPreview` com `connId` | `viewColumn`; modo `webview` | União. |
| `src/types.ts` `OpenMode` | `"diff"` | `"webview"` | União. |
| `codicon-map.ts` | ícones Git Fluent/pacotes/lock | ícones do chat, primitivos e workbench | União. |
| `DetachedEditor.tsx` | `writeSshTextFile` | `Tooltip` | União dos imports. |
| `TreeNode.tsx` | expandir/recolher animado por `max-height` medido (`childrenHeight`) | guia de indentação (`--tree-guide`) | Estrutura animada do Rafael + variável `--tree-guide` no mesmo `style`. |
| `FileExplorer.tsx` | cabeçalho de workspace (título, “adicionar pasta/pasta SSH”, ações só em pasta única) | `IconButton` + `explorer-actions-reveal` | Lógica do Rafael com os botões migrados para `IconButton`. |
| `SearchPanel.tsx` | `hasSearchTarget` (busca multi-raiz) | `SearchBox` com toggles em `IconButton` | Markup do preview com `disabled={!hasSearchTarget}`. |
| `StatusBar.tsx` | menu LSP em portal + menu rico de blame da linha | menu LSP no primitivo `Menu` | Menu LSP do preview + menu de blame do Rafael (portal, mantido como está). |
| `RunPanel.tsx` | seções por raiz | `Input`/`IconButton` | Seções por raiz do Rafael com `IconButton` (adicionar/executar) e `Input` do preview. |
| `GraphView.tsx` | toggles “Aglomerar”/“Setas”, copiar resumo p/ agente, menu de contexto de organização | `Checkbox`/`IconButton`/`SearchBox` | Funções do Rafael com os primitivos (toggles → `Checkbox`, botões → `IconButton`, zoom → `IconButton`). |
| `GitPanel.tsx` | reescrito (Git Fluent) | só migrou botões da versão antiga para primitivos | **Versão do Rafael**, com os botões só-ícone (`Tooltip`+`<button><Codicon/></button>`) convertidos para `IconButton` também em `src/components/git/*` (24 botões); o `aria-label` específico (ex.: “Checkout <branch>”) virou o `label`. |
| `PackagesPanel.tsx` | `<input class="search-input">` | `.search-input` deixou de ter CSS | Migrado para `SearchBox`. |
| `src-tauri/src/lib.rs` | `workspace_open::workspace_files_from_args` | deep link `fluent-coder://` | União. |
| `src-tauri/tauri.conf.json` | `fileAssociations` `.fluent-workspace` | recursos do ext-host | União. |
| `src-tauri/src/agents/claude.rs` | rustfmt | `permission_title`, `options` no `spawn_session` | Preview. |
| `docs/context/agentes-ia.md` | parágrafo `get_graph_overview` | seção da ponte IDE | União. |
| `src-tauri/gen/schemas/linux-schema.json` | gerado | gerado | Preview (arquivo gerado pelo build). |

### CSS (regra: o design system do preview vence)

Gerado por script (determinístico) a partir de: `styles.css` do preview,
`styles.css` da `main` e a divisão `src/styles/*.css` do Rafael. Cada regra
do Rafael foi classificada comparando o **conjunto de declarações** com a `main`:

- **Igual à `main`** (973): fica a versão do preview (tokens/fase 2). Quando o
  preview apagou a regra (CSS morto: sidebar de agentes antiga, menus que
  viraram `Menu`, campos que viraram `Input`…), ela sai (292). Exceção
  (restauradas): `.git-message:hover`, `.git-message:focus` e o anel
  `:focus-visible` do `.git-message` — o commit box do Rafael segue com
  `<textarea>` próprio (Ctrl+Enter, botão de assistente sobreposto).
- **Seletor novo do Rafael** (818): entra, com `font-size`/`border-radius` em px
  trocados pelos tokens (`10px→--font-caption-xs`, `11px→--font-caption-sm`,
  `12px→--font-caption`, `13px→--font-base`, `14px→--font-body`,
  `18px→--font-subtitle`; raios `2→--radius-xs`, `4/5→--radius-sm`,
  `6/7→--radius-control`, `8→--radius-card`, `999→--radius-pill`).
  Frações (9.5px, 11.25px…) foram para o token mais próximo. ⚠ revisar
  visualmente densidade do Git Fluent.
- **Regra da `main` alterada pelo Rafael** (25): versão do preview + só o
  delta de declarações do Rafael (ex.: `.tree-children` passa a animar por
  `max-height`, que o `TreeNode` mede; `.git-commit-row` em grid;
  `.explorer-tree` com `scrollbar-gutter`; `.graph-node-option` em grid).
  Token novo no `:root`: `--duration-tree: 110ms`.
- **Regras só do preview** (307): entram logo após a regra do preview que as
  precede. As famílias exclusivas do preview `claude-diff*`/`ext-diff*`,
  `ext-dock*`/`ext-webview*`/`ext-runtime-toast` e `status-claude`/`status-ext`
  foram para `editor-diff.css`, `panels-shared.css` e `status-base.css`.

O commit de merge traz o `src/styles.css` monolítico já ordenado pelas seções
da divisão do Rafael (marcadores `/* ==== styles/<arquivo> ==== */`), e o
commit seguinte apenas recorta essas seções em `src/styles/*.css` — sem mudar a
ordem da cascata.

### Commit de re-divisão do CSS

- `src/styles.css` volta a ser o entry de comentário do Rafael; o conteúdo vai
  para os mesmos 58 arquivos de `src/styles/` (50 folhas + 8 agregadores com
  `@import`, idênticos aos do Rafael), importados em `src/main.tsx` na mesma
  ordem. Verificado por script: a concatenação na ordem de import (com os
  `@import` resolvidos) tem exatamente as mesmas 1833 regras, na mesma ordem,
  que o `styles.css` monolítico do commit de merge.
- Testes que liam `src/styles.css` (`src/components/ui/tokens.test.ts`,
  `src/styles.test.ts`) passam a ler a folha global montada a partir dos
  imports de `src/main.tsx` (`readGlobalStylesheet`), então os contratos de
  tokens (sem px de fonte/raio fora do `:root`, `:root` com a escala etc.)
  valem para todos os arquivos divididos. `editorOptions.test.ts` lê
  `src/styles/editor-monaco-hover.css`. Novo teste: o entry `src/styles.css`
  continua sem regras.
### Correções pós-merge (achadas no render headless do `dist/`)

- **Build de produção não montava o app.** O `manualChunks` do `vite.config.ts`
  (ramo do Rafael) mandava todo o resto de `node_modules` para um chunk
  `vendor` genérico, criando ciclos `vendor ↔ vendor-react/monaco/markdown`
  (os avisos “Circular chunk” do build). No WebKitGTK o `dist/` quebrava na
  inicialização (`TypeError: Fst is not a function` em `vendor-monaco-vscode`)
  e a janela ficava vazia — no `tauri dev` (sem chunks) não aparece. Correção:
  o catch-all devolve `undefined` (o Rollup decide); os chunks nomeados
  continuam. Sem avisos de ciclo e o app monta. ⚠ revisar: vale conferir o
  `npm run tauri build` no Windows.
- **`.git-link-btn` com largura fixa de 22px** (Git Fluent) espremia os botões
  de TEXTO que usam a mesma classe fora do Git (“Cancelar” do RunPanel, ações
  do NugetManager, “Checar versões”/“Audit segurança” do PackagesPanel). Agora
  `min-width: 22px; padding: 0 3px` — os botões só-ícone continuam com 22px.
- Na `integracao/git-fluent`, os botões de texto do PackagesPanel também migraram para o `Button` (subtle, sm) dos primitivos.
