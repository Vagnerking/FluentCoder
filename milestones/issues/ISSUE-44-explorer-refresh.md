# ISSUE-44 · Explorador: Atualizar explorador

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Front · **Tamanho:** M · **Depende de:** 42, 43 · **Status:** ⬜ Pendente

## Contexto

Os filhos de cada `TreeNode` são carregados uma vez e permanecem em cache local.
Alterações feitas por terminal, Git ou outro aplicativo não aparecem até o
workspace ser reaberto. A ação **Atualizar explorador** deve invalidar esse
cache e reler a árvore.

## Tarefas

- [ ] Adicionar botão com Codicon `refresh`, tooltip e `aria-label`
      **Atualizar explorador**.
- [ ] Definir um mecanismo declarativo de revisão da árvore (`refreshVersion`
      ou estado de árvore centralizado).
- [ ] Recarregar as entradas da raiz.
- [ ] Invalidar e reler os filhos das pastas que estavam expandidas.
- [ ] Preservar, quando ainda existirem, a pasta selecionada, o arquivo ativo e
      o conjunto de pastas expandidas.
- [ ] Remover da árvore itens que deixaram de existir sem fechar
      automaticamente abas já abertas.
- [ ] Exibir estado de carregamento acessível e impedir disparos concorrentes.
- [ ] Tratar falha sem apagar a última árvore válida.
- [ ] Adicionar testes para inclusão, remoção, preservação de expansão e erro.

## Arquivos

- `src/components/FileExplorer.tsx`
- `src/components/TreeNode.tsx`
- `src/App.tsx`
- testes do Explorador

## Detalhes técnicos

- Não usar reload da janela nem manipulação imperativa do DOM.
- A atualização deve reutilizar `readDir` e manter a ordenação definida pelo backend.
- Enquanto atualiza, o botão deve ficar desabilitado e o status deve ser
  anunciado com `role="status"` ou região `aria-live`.

## Critérios de aceite

- [ ] Mudanças externas aparecem após uma única atualização.
- [ ] Pastas previamente expandidas continuam expandidas e exibem dados novos.
- [ ] Seleção e arquivo ativo são preservados quando os caminhos ainda existem.
- [ ] Falha mantém a árvore anterior e mostra mensagem com próximo passo.
- [ ] Cliques repetidos não criam corridas nem resultados antigos.
- [ ] Testes unitários e `tsc --noEmit` passam.
