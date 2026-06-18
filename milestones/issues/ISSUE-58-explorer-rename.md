# ISSUE-58 · Renomear arquivo/pasta no Explorador

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 56, 57 · **Status:** ⬜ Pendente

## Contexto

Com a infra de menu de contexto (ISSUE-56) e o comando `rename_path` (ISSUE-57) prontos, esta issue entrega a ação de **renomear** arquivos e pastas no Explorador. O gatilho é um item "Renomear" no menu de contexto **e** o atalho **F2** quando a árvore tem foco.

A edição reusa o `InlineCreation` exportado por [FileExplorer.tsx](../../src/components/FileExplorer.tsx) — o mesmo input inline usado para criar arquivos/pastas, que confirma com **Enter** e cancela com **Esc**. Aqui ele aparece pré-preenchido com o nome atual do item; ao entrar em edição, seleciona apenas o nome **sem a extensão** (comportamento do VSCode), facilitando trocar só a base.

Ao confirmar, chama-se `rename_path(workspace_root, path, new_name)` ([api.ts](../../src/api.ts)). Em sucesso, a árvore é atualizada via `refreshVersion` e, se o arquivo renomeado estiver aberto numa aba, o `path` da aba é atualizado para o novo caminho. Em colisão (erro do backend), exibe-se a mensagem e o input permanece aberto para correção.

## Tarefas

- [ ] Adicionar item "Renomear" (`accelerator: F2`) ao menu de contexto de arquivo e de pasta (ISSUE-56).
- [ ] Disparar a renomeação ao pressionar **F2** quando a árvore/nó selecionado tem foco.
- [ ] Reusar o `InlineCreation` de [FileExplorer.tsx](../../src/components/FileExplorer.tsx) em modo "renomear", pré-preenchido com o nome atual.
- [ ] Selecionar apenas o nome **sem extensão** ao entrar em edição (estilo VSCode); para pastas, selecionar o nome inteiro.
- [ ] Confirmar com **Enter** chamando `rename_path`; **Esc** cancela e remove o input.
- [ ] Em sucesso, atualizar a árvore via `refreshVersion`.
- [ ] Se o arquivo renomeado estiver aberto numa aba, atualizar o `path` (e label) da aba para o novo caminho.
- [ ] Em erro de colisão, exibir mensagem e **manter** o input aberto.

## Arquivos

- `src/components/FileExplorer.tsx` (estado de renomeação + reuso do `InlineCreation`, modificado)
- `src/components/TreeNode.tsx` (item de menu + handler F2, modificado)
- `src/api.ts` (wrapper `renamePath`, já criado na ISSUE-57)
- `src/styles.css` (ajustes pontuais do input inline, se necessário, modificado)

## Detalhes técnicos

- Estado de renomeação em [FileExplorer.tsx](../../src/components/FileExplorer.tsx): guardar qual `path` está em edição (análogo ao estado de criação inline já existente). O `InlineCreation` recebe valor inicial e callback de confirmação/cancelamento.
- Seleção sem extensão: ao montar o input, posicionar a seleção de 0 até o índice do último `.` (quando houver e não for arquivo oculto começando por `.`). Pastas selecionam o nome inteiro.
- Confirmação: validar nome não vazio e diferente do atual antes de chamar `rename_path`; nome igual = cancelar sem chamar o backend.
- Sincronização de abas: localizar a aba aberta cujo `path` casa com o caminho antigo e reescrever para o novo (o conteúdo/buffer não muda, apenas o identificador e o título). Para pastas renomeadas, reescrever o prefixo de qualquer aba aberta sob a pasta.
- Erro: o `rename_path` retorna `Err(String)` em colisão; exibir a mensagem (toast/inline) e não fechar o input.
- Atalho **F2**: registrado quando o foco está no painel do Explorador, sem conflitar com o Monaco.

## Critérios de aceite

- [ ] Item "Renomear" aparece no menu de contexto de arquivos e pastas com acelerador `F2`.
- [ ] **F2** com um nó selecionado na árvore inicia a edição inline.
- [ ] O input vem pré-preenchido; para arquivos, a seleção cobre o nome sem a extensão.
- [ ] **Enter** renomeia via `rename_path` e a árvore reflete o novo nome.
- [ ] **Esc** cancela sem alterar nada.
- [ ] Renomear um arquivo aberto atualiza o `path`/título da aba correspondente.
- [ ] Colisão de nome mostra mensagem e mantém o input aberto.
- [ ] `tsc --noEmit` sem erros.
