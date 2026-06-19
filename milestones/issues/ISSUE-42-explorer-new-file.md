# ISSUE-42 · Explorador: Novo arquivo

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** — · **Status:** ✅ Concluída

## Contexto

O Explorador ainda não permite criar arquivos. A primeira ação do novo cabeçalho
deve criar um arquivo vazio dentro da pasta selecionada ou, quando nenhuma pasta
estiver selecionada, na raiz do workspace.

## Tarefas

- [x] Adicionar seleção explícita de pasta à árvore, distinta do arquivo ativo.
- [x] Adicionar botão com Codicon `newFile`, tooltip e `aria-label` **Novo arquivo**.
- [x] Exibir um campo inline no diretório de destino, já focado.
- [x] Confirmar com Enter, cancelar com Esc e cancelar ao perder foco somente
      quando nenhum nome válido tiver sido confirmado.
- [x] Criar comando Rust `create_file(path, workspace_root)` com semântica
      `create_new`, sem sobrescrever arquivo existente.
- [x] Validar nome vazio, caracteres inválidos, separadores/caminhos absolutos e
      tentativa de escapar da raiz do workspace.
- [x] Após sucesso, atualizar o diretório pai, selecionar o novo item e abri-lo
      no editor.
- [x] Exibir erro em português e manter o campo editável quando a criação falhar.
- [x] Adicionar testes unitários do fluxo e testes Rust do comando.

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

- [x] Clicar em Novo arquivo inicia a edição inline no destino correto.
- [x] Enter cria e abre o arquivo; Esc não altera o sistema de arquivos.
- [x] Um item existente nunca é sobrescrito.
- [x] Caminhos fora do workspace são rejeitados.
- [x] O erro informa o problema e o próximo passo.
- [x] A ação funciona integralmente por teclado.
- [x] Testes unitários e `cargo check` passam.
