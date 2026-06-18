# ISSUE-59 · Excluir arquivo/pasta (Lixeira) no Explorador

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 56, 57, 66 · **Status:** ⬜ Pendente

## Contexto

Esta issue entrega a ação de **excluir** arquivos e pastas pelo Explorador, enviando o item para a **Lixeira do SO** (operação recuperável) através do comando `delete_to_trash` (ISSUE-57). O gatilho é um item "Excluir" no menu de contexto (ISSUE-56) **e** o atalho **Del** quando a árvore tem foco.

Por ser destrutiva, a exclusão pede confirmação. Reusa-se o componente `ConfirmDialog` da [ISSUE-66](ISSUE-66-confirm-modal-component.md) (épico EPIC-unsaved-changes-guard): um modal com botões **"Mover para a Lixeira"** / **"Cancelar"**, citando o nome do item no texto. Não criar um modal próprio — reusar o existente.

Ao confirmar, chama-se `delete_to_trash(workspace_root, path)` ([api.ts](../../src/api.ts)). Depois da exclusão, fecham-se as abas abertas que apontem para o caminho removido (ou, no caso de pasta, qualquer aba sob ela) e a árvore é atualizada via `refreshVersion`.

## Tarefas

- [ ] Adicionar item "Excluir" (`accelerator: Del`) ao menu de contexto de arquivo e de pasta (ISSUE-56).
- [ ] Disparar a exclusão ao pressionar **Del** quando a árvore/nó selecionado tem foco.
- [ ] Abrir o `ConfirmDialog` da [ISSUE-66](ISSUE-66-confirm-modal-component.md) com botões "Mover para a Lixeira" / "Cancelar", citando o nome do item.
- [ ] Ao confirmar, chamar `delete_to_trash(workspace_root, path)`.
- [ ] Após excluir, fechar abas abertas que apontem para o caminho removido (pasta = fechar abas sob ela).
- [ ] Atualizar a árvore via `refreshVersion`.
- [ ] Em erro do backend, exibir mensagem e não alterar abas/árvore.

## Arquivos

- `src/components/FileExplorer.tsx` (estado/handler de exclusão + uso do `ConfirmDialog`, modificado)
- `src/components/TreeNode.tsx` (item de menu + handler Del, modificado)
- `src/api.ts` (wrapper `deleteToTrash`, já criado na ISSUE-57)

## Detalhes técnicos

- Confirmação: reusar `ConfirmDialog` ([ISSUE-66](ISSUE-66-confirm-modal-component.md)) passando título/mensagem e os rótulos dos botões; o texto deve citar o nome do item (ex.: "Tem certeza que deseja excluir `App.tsx`?").
- Fechamento de abas: ao remover um arquivo, localizar a aba cujo `path` casa e fechá-la; ao remover uma pasta, fechar todas as abas cujo `path` tem o caminho da pasta como prefixo. Reaproveitar o fluxo de fechamento de aba já existente no App/TabBar.
- A operação é recuperável (Lixeira do SO), então **não** é preciso o guard de alterações não salvas aqui; o `ConfirmDialog` é só a confirmação da remoção.
- Atalho **Del**: registrado quando o foco está no painel do Explorador, sem conflitar com o Monaco.
- Erro: `delete_to_trash` retorna `Err(String)`; exibir mensagem e manter o estado atual.

## Critérios de aceite

- [ ] Item "Excluir" aparece no menu de contexto de arquivos e pastas com acelerador `Del`.
- [ ] **Del** com um nó selecionado abre a confirmação.
- [ ] O `ConfirmDialog` exibe os botões "Mover para a Lixeira" / "Cancelar" e cita o nome do item.
- [ ] Confirmar move o item para a Lixeira do SO via `delete_to_trash`.
- [ ] Cancelar não altera nada.
- [ ] Abas abertas sobre o caminho removido (ou sob a pasta) são fechadas.
- [ ] A árvore é atualizada após a exclusão.
- [ ] `tsc --noEmit` sem erros.
