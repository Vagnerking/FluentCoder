# ISSUE-43 · Explorador: Nova pasta

**Épico:** [Ações do Explorador de Arquivos](../EPIC-file-explorer-actions.md) · **Camada:** Full · **Tamanho:** M · **Depende de:** 42 · **Status:** ✅ Concluída

## Contexto

Com o fluxo de seleção e entrada inline criado na ISSUE-42, o Explorador deve
permitir criar uma pasta no mesmo destino e com o mesmo comportamento de foco,
validação e erro.

## Tarefas

- [x] Adicionar botão com Codicon `newFolder`, tooltip e `aria-label` **Nova pasta**.
- [x] Reutilizar o componente/estado de entrada inline da criação de arquivo.
- [x] Criar comando Rust `create_folder(path, workspace_root)`.
- [x] Aplicar as mesmas validações de nome, colisão e limite do workspace.
- [x] Após sucesso, atualizar o diretório pai, selecionar e expandir a nova pasta.
- [x] Não alterar o conteúdo de uma pasta existente em caso de colisão.
- [x] Adicionar testes unitários do fluxo e testes Rust do comando.

## Arquivos

- `src/components/FileExplorer.tsx`
- `src/components/TreeNode.tsx`
- componente compartilhado de entrada inline, se extraído
- `src/api.ts`
- `src-tauri/src/fs_commands.rs`
- `src-tauri/src/lib.rs`
- testes do front e do backend

## Detalhes técnicos

- Usar `create_dir`, não `create_dir_all`, para não aceitar acidentalmente um
  caminho com múltiplos segmentos fornecido pelo campo de nome.
- A validação definitiva permanece no backend; a validação no front serve para
  feedback imediato.

## Critérios de aceite

- [x] Clicar em Nova pasta inicia a edição inline no destino correto.
- [x] Enter cria, seleciona e expande a pasta; Esc cancela.
- [x] Pastas existentes não são modificadas.
- [x] Caminhos fora do workspace são rejeitados.
- [x] O fluxo visual e de teclado é consistente com Novo arquivo.
- [x] Testes unitários e `cargo check` passam.
