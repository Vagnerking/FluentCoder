# ISSUE-45 · Explorador: Recolher pastas

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 44 · **Status:** ⬜ Pendente

## Contexto

Em árvores profundas, fechar cada pasta manualmente é lento. A ação
**Recolher pastas** deve fechar todos os nós expandidos de uma vez, sem afetar
arquivos abertos ou o conteúdo do workspace.

## Tarefas

- [ ] Adicionar botão com Codicon `collapseAll`, tooltip e `aria-label`
      **Recolher pastas**.
- [ ] Limpar o conjunto de caminhos expandidos ou incrementar uma versão de
      recolhimento consumida por todos os `TreeNode`.
- [ ] Manter a pasta selecionada, o arquivo ativo e todas as abas.
- [ ] Desabilitar a ação quando não houver workspace ou nenhuma pasta expandida.
- [ ] Devolver o foco ao botão após a ação e anunciar o resultado para leitor de tela.
- [ ] Adicionar testes com múltiplos níveis expandidos.

## Arquivos

- `src/components/FileExplorer.tsx`
- `src/components/TreeNode.tsx`
- testes do Explorador

## Detalhes técnicos

- Recolher não deve apagar dados, refazer leitura de diretórios nem fechar abas.
- Preferir estado declarativo compartilhado a refs imperativas recursivas.

## Critérios de aceite

- [ ] Uma única ação recolhe todas as pastas, inclusive níveis aninhados.
- [ ] Arquivo ativo, abas e seleção não são alterados.
- [ ] O botão fica desabilitado quando não há nada a recolher.
- [ ] Mouse, teclado e leitor de tela recebem comportamento consistente.
- [ ] Testes unitários e `tsc --noEmit` passam.
