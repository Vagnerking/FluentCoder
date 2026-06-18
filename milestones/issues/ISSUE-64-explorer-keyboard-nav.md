# ISSUE-64 · Navegação por teclado (Enter/setas)

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 56, 58, 59 · **Status:** ⬜ Pendente

## Contexto

Hoje a árvore de arquivos é operável apenas pelo mouse: o [TreeNode.tsx](../../src/components/TreeNode.tsx) **não** tem foco/seleção por teclado nem roles ARIA, e os atalhos de manutenção (Del/F2) ainda não estão amarrados a um foco de árvore. Esta issue traz a navegação por teclado no estilo VS Code: foco/seleção visível, **Enter** para abrir/expandir, e setas para mover e expandir/recolher.

A navegação precisa coexistir com o editor Monaco: os atalhos globais **Del** (excluir, issue 59) e **F2** (renomear, issue 58) só podem disparar quando o **foco está na árvore** do Explorador, nunca quando o foco está no editor. Por isso esta issue depende dessas duas e centraliza a regra de "a árvore tem foco" para que ambas a respeitem.

O [FileExplorer.tsx](../../src/components/FileExplorer.tsx) já mantém `selectedDirectory`, `expandedPaths` e `refreshVersion`; vamos acrescentar o conceito de "item focado" (linha ativa para teclado) e a lista achatada de nós visíveis para mover o foco com ↑/↓.

## Tarefas

- [ ] Adicionar roles ARIA: container com `role="tree"`, cada linha com `role="treeitem"`, `aria-expanded` em pastas, `aria-selected` no item ativo e `aria-level` conforme a profundidade.
- [ ] Tornar a árvore focável (`tabIndex=0` no container; roving tabindex ou foco no container com item ativo via `aria-activedescendant`).
- [ ] Manter um estado de "item focado" em [FileExplorer.tsx](../../src/components/FileExplorer.tsx) e a lista achatada de nós **visíveis** (respeitando `expandedPaths`) para navegação linear.
- [ ] **↑ / ↓:** mover o foco/seleção para o nó visível anterior/seguinte.
- [ ] **→:** se pasta recolhida, expande; se já expandida, move para o primeiro filho. Se arquivo, no-op.
- [ ] **← :** se pasta expandida, recolhe; senão, move o foco para a pasta-pai.
- [ ] **Enter:** abre o arquivo selecionado; em pasta, expande/recolhe.
- [ ] Estilo de foco/seleção visível em [TreeNode.tsx](../../src/components/TreeNode.tsx) / [styles.css](../../src/styles.css), distinto de hover (Fluent 2: anel de foco).
- [ ] Centralizar a checagem "a árvore tem foco" e usá-la para gatear os atalhos **Del** (issue 59) e **F2** (issue 58), evitando conflito com o Monaco.

## Arquivos

- `src/components/TreeNode.tsx` (modificado — roles ARIA, foco/seleção, key handlers de linha)
- `src/components/FileExplorer.tsx` (modificado — estado de item focado, lista achatada, gate de foco)
- `src/styles.css` (modificado — estilo de foco/seleção do treeitem)

## Detalhes técnicos

- **Lista achatada:** computar a partir da árvore + `expandedPaths` a sequência de nós atualmente visíveis; ↑/↓ apenas indexam nessa lista. Recalcular quando `expandedPaths`/conteúdo muda.
- **Padrão ARIA:** seguir o pattern de Tree View do WAI-ARIA. Preferir `aria-activedescendant` no container `role="tree"` apontando para o `id` do treeitem ativo (evita gerir `tabIndex` por linha). Garantir scroll-into-view do item ativo.
- **Gate de foco:** os atalhos globais de Del/F2 devem checar se o elemento focado pertence à árvore (ex.: flag de foco da árvore ou `document.activeElement` dentro do container do Explorador). O Monaco captura suas próprias teclas; ao registrar listeners globais, ignorar eventos originados de dentro do editor.
- **Enter em pasta:** alterna `expandedPaths`; em arquivo, dispara o mesmo handler de abertura usado pelo clique.
- Não introduzir multi-seleção (fora de escopo do épico) — apenas um item focado/selecionado por vez.
- Rótulos/tooltips em pt-BR; respeitar contraste e anel de foco do Fluent 2.

## Critérios de aceite

- [ ] A árvore recebe foco por Tab e exibe foco/seleção visíveis e distintos de hover.
- [ ] ↑/↓ movem entre os nós visíveis; →/← expandem/recolhem ou navegam pai/filho.
- [ ] Enter abre o arquivo selecionado e expande/recolhe pastas.
- [ ] Del e F2 disparam suas ações **apenas** quando a árvore tem foco, nunca a partir do editor.
- [ ] Container tem `role="tree"`, itens têm `role="treeitem"` com `aria-expanded`/`aria-selected`/`aria-level` corretos.
- [ ] O item ativo é trazido à viewport ao navegar.
- [ ] `tsc --noEmit` sem erros.
