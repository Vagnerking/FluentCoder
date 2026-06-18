# ISSUE-42 · Explorador: Novo arquivo

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** — · **Status:** ⬜ Pendente

## Contexto

O Explorador ainda não permite criar arquivos. A primeira ação do novo cabeçalho
deve criar um arquivo vazio dentro da pasta selecionada ou, quando nenhuma pasta
estiver selecionada, na raiz do workspace.

## Tarefas

- [ ] Adicionar seleção explícita de pasta à árvore, distinta do arquivo ativo.
- [ ] Adicionar botão com Codicon `newFile`, tooltip e `aria-label` **Novo arquivo**.
- [ ] Exibir um campo inline no diretório de destino, já focado.
- [ ] Confirmar com Enter, cancelar com Esc e cancelar ao perder foco somente
      quando nenhum nome válido tiver sido confirmado.
- [ ] Criar comando Rust `create_file(path, workspace_root)` com semântica
      `create_new`, sem sobrescrever arquivo existente.
- [ ] Validar nome vazio, caracteres inválidos, separadores/caminhos absolutos e
      tentativa de escapar da raiz do workspace.
- [ ] Após sucesso, atualizar o diretório pai, selecionar o novo item e abri-lo
      no editor.
- [ ] Exibir erro em português e manter o campo editável quando a criação falhar.
- [ ] Adicionar testes unitários do fluxo e testes Rust do comando.

## Arquivos

- `src/components/FileExplorer.tsx`
- `src/components/TreeNode.tsx`
- `src/App.tsx`
- `src/api.ts`
- `src-tauri/src/fs_commands.rs`
- `src-tauri/src/lib.rs`
- testes do front e do backend

## Detalhes técnicos

- O frontend envia o caminho de destino, mas o backend é responsável por
  normalizar e validar que o pai está dentro do workspace.
- Usar `OpenOptions::new().write(true).create_new(true)` no Rust.
- O campo inline deve usar os tokens e estados interativos existentes, sem
  estilos de cor ou espaçamento soltos.

## Critérios de aceite

- [ ] Clicar em Novo arquivo inicia a edição inline no destino correto.
- [ ] Enter cria e abre o arquivo; Esc não altera o sistema de arquivos.
- [ ] Um item existente nunca é sobrescrito.
- [ ] Caminhos fora do workspace são rejeitados.
- [ ] O erro informa o problema e o próximo passo.
- [ ] A ação funciona integralmente por teclado.
- [ ] Testes unitários e `cargo check` passam.
