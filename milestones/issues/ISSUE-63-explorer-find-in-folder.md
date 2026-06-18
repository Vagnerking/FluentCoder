# ISSUE-63 · Localizar na pasta

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 56 · **Status:** ⬜ Pendente

## Contexto

O VS Code expõe no menu de contexto de **pasta** o item **Localizar na pasta**, que abre a busca já escopada àquela pasta. Esta issue traz esse comportamento: ao acionar, o [SearchPanel.tsx](../../src/components/SearchPanel.tsx) é aberto/focado com o escopo da busca apontando para a pasta clicada, em vez da raiz do workspace.

A infra de busca já existe: [search.rs](../../src-tauri/src/search.rs) expõe `search_in_dir(root, query)` (recursivo, case-insensitive, cap de 500 resultados) e o [SearchPanel.tsx](../../src/components/SearchPanel.tsx) hoje passa sempre a **raiz do workspace** como `root`. Como o comando já recebe `root` como parâmetro, basta permitir que esse `root` seja a pasta clicada e refletir o escopo atual na UI.

O item entra no menu de contexto reusável [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx) (issue 56), apenas para nós do tipo pasta. A pasta-alvo vem do nó disparado em [TreeNode.tsx](../../src/components/TreeNode.tsx).

## Tarefas

- [ ] Adicionar item "Localizar na pasta" ao menu de contexto **somente de pasta** via [TreeContextMenu.tsx](../../src/components/TreeContextMenu.tsx).
- [ ] Expor no [SearchPanel.tsx](../../src/components/SearchPanel.tsx) um estado de "escopo atual" (`searchRoot`) que por padrão é o `rootPath` do workspace, mas pode ser sobrescrito por uma pasta específica.
- [ ] Permitir definir o escopo imperativamente ao acionar a ação (ex.: `openSearchInFolder(path)` via callback/contexto do App), que abre/foca o painel de busca e ajusta o `searchRoot`.
- [ ] Passar o `searchRoot` atual como `root` na chamada `search_in_dir(root, query)` em [api.ts](../../src/api.ts).
- [ ] Exibir o escopo atual na UI do SearchPanel quando ele **não** for a raiz: um chip com o nome da pasta e um botão "limpar" (X) que volta o escopo para a raiz do workspace.
- [ ] Reexecutar a busca ao trocar o escopo (se já houver query digitada).

## Arquivos

- `src/components/TreeContextMenu.tsx` (modificado — item "Localizar na pasta")
- `src/components/SearchPanel.tsx` (modificado — estado de escopo, chip, lógica de root)
- `src/components/FileExplorer.tsx` (modificado — dispara `openSearchInFolder`)
- `src/api.ts` (modificado — `searchInDir` aceita root da pasta)
- `src/styles.css` (modificado — estilo do chip de escopo)

## Detalhes técnicos

- **Backend já compatível:** `search_in_dir(root, query)` recebe `root` como parâmetro; nenhuma mudança no Rust é estritamente necessária. Validar (defensivo) que o `root` enviado está dentro do workspace para não buscar fora dele.
- **Escopo na UI:** quando `searchRoot === rootPath` (raiz), nenhum chip aparece (comportamento atual). Quando escopado a uma subpasta, exibir chip `📁 <nomeDaPasta>` (Codicon de pasta do mapa central) com botão de limpar; ao limpar, `searchRoot = rootPath` e a busca é refeita.
- **Abrir/focar o painel:** reusar o mesmo mecanismo de troca de view lateral usado pela Activity Bar para mostrar a busca; após abrir, focar o input de query.
- Mostrar o caminho completo da pasta no `title`/tooltip do chip para desambiguar pastas de mesmo nome.
- Rótulos em pt-BR; Fluent 2 nos estados do chip (rest/hover/pressed/focus) e do botão limpar.

## Critérios de aceite

- [ ] O menu de contexto de pasta mostra "Localizar na pasta"; o de arquivo não.
- [ ] Acionar a ação abre/foca o painel de busca com o input pronto para digitar.
- [ ] A busca passa a usar a pasta clicada como `root` (`search_in_dir`).
- [ ] O painel mostra um chip com o nome da pasta de escopo quando não é a raiz.
- [ ] Limpar o chip volta o escopo à raiz do workspace e refaz a busca.
- [ ] Trocar o escopo com query já preenchida reexecuta a busca.
- [ ] `tsc --noEmit` e `cargo check` sem erros.
