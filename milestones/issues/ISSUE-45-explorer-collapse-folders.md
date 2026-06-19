# ISSUE-45 · Explorador: Recolher pastas

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Front · **Tamanho:** S · **Depende de:** 44 · **Status:** ✅ Concluída

## Contexto

Em árvores profundas, fechar cada pasta manualmente é lento. A ação
**Recolher pastas** deve fechar todos os nós expandidos de uma vez, sem afetar
arquivos abertos ou o conteúdo do workspace.

## Tarefas

- [x] Adicionar botão com Codicon `collapseAll`, tooltip e `aria-label`
      **Recolher pastas**.
- [x] Limpar o conjunto de caminhos expandidos ou incrementar uma versão de
      recolhimento consumida por todos os `TreeNode`.
- [x] Manter a pasta selecionada, o arquivo ativo e todas as abas.
- [x] Desabilitar a ação quando não houver workspace ou nenhuma pasta expandida.
- [x] Devolver o foco ao botão após a ação e anunciar o resultado para leitor de tela.
- [x] Adicionar testes com múltiplos níveis expandidos.

## Arquivos

- `src/components/FileExplorer.tsx`
- `src/components/TreeNode.tsx`
- testes do Explorador

## Detalhes técnicos

- Recolher não deve apagar dados, refazer leitura de diretórios nem fechar abas.
- Preferir estado declarativo compartilhado a refs imperativas recursivas.

## Critérios de aceite

- [x] Uma única ação recolhe todas as pastas, inclusive níveis aninhados.
- [x] Arquivo ativo, abas e seleção não são alterados.
- [x] O botão fica desabilitado quando não há nada a recolher.
- [x] Mouse, teclado e leitor de tela recebem comportamento consistente.
- [x] Testes unitários e `tsc --noEmit` passam.
