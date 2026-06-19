# ISSUE-57 · Comandos Rust de mutação do sistema de arquivos

**Épico:** [Menu de Contexto do Explorador](../EPIC-explorer-context-menu.md) · **Camada:** Rust · **Tamanho:** M · **Depende de:** — · **Status:** ⬜ Pendente

## Contexto

O menu de contexto do Explorador (issues 58–60) precisa de operações de mutação no sistema de arquivos que ainda não existem no backend. Hoje [fs_commands.rs](../../src-tauri/src/fs_commands.rs) só oferece criação (`create_file` / `create_folder`) sobre os helpers `validate_child_path(workspace_root, parent, name)` e `entry_for(path, is_dir)`. Esta issue adiciona os 4 comandos restantes: renomear, excluir (para a Lixeira do SO), copiar e mover.

Toda operação deve **revalidar** que tanto a origem quanto o destino permanecem dentro do `workspace_root`, reusando `validate_child_path` para o nome final e checando o caminho de origem. Isso impede travessia de diretório (`../`) e operações fora da pasta aberta. Colisões de nome **nunca** sobrescrevem: rename rejeita; copy/move resolvem gerando um nome alternativo.

A exclusão usa a **Lixeira do SO** (não apaga definitivamente), via crate [`trash`](https://crates.io/crates/trash) — adicionar `trash = "5"` ao [Cargo.toml](../../src-tauri/Cargo.toml). Os 4 comandos são registrados no `invoke_handler` em [lib.rs](../../src-tauri/src/lib.rs) e expostos como wrappers em [api.ts](../../src/api.ts).

## Tarefas

- [ ] `rename_path(workspace_root, path, new_name)` — renomeia 1 nível (mesma pasta-pai). Valida `new_name` com `validate_child_path`; rejeita se já existir (colisão). Retorna o novo `entry_for`.
- [ ] `delete_to_trash(workspace_root, path)` — valida que `path` está dentro do workspace; move para a Lixeira do SO via crate `trash`.
- [ ] `copy_path(workspace_root, src, dest_parent)` — copia arquivo ou pasta (recursivo) para `dest_parent`, resolvendo colisão sem sobrescrever (ex.: sufixo). Retorna o `entry_for` do destino.
- [ ] `move_path(workspace_root, src, dest_parent)` — move arquivo ou pasta (recursivo) para `dest_parent`, resolvendo colisão sem sobrescrever. Retorna o `entry_for` do destino.
- [ ] Reusar `validate_child_path` / `entry_for`; revalidar origem **e** destino dentro do `workspace_root` em todas as operações.
- [ ] Adicionar `trash = "5"` em [Cargo.toml](../../src-tauri/Cargo.toml).
- [ ] Registrar os 4 comandos no `invoke_handler` em [lib.rs](../../src-tauri/src/lib.rs).
- [ ] Testes unitários em [fs_commands.rs](../../src-tauri/src/fs_commands.rs) (estilo dos existentes, usando temp dir): rename ok, rename colisão, copy arquivo/pasta, move arquivo/pasta, resolução de colisão, e rejeição fora do workspace.
- [ ] Wrappers em [api.ts](../../src/api.ts): `renamePath`, `deleteToTrash`, `copyPath`, `movePath` via `invoke<T>("comando", { argsCamelCase })`.

## Arquivos

- `src-tauri/src/fs_commands.rs` (4 comandos + testes, modificado)
- `src-tauri/src/lib.rs` (registro dos comandos, modificado)
- `src-tauri/Cargo.toml` (dependência `trash = "5"`, modificado)
- `src/api.ts` (wrappers, modificado)

## Detalhes técnicos

- Validação: `validate_child_path(workspace_root, parent, name)` já garante que o caminho resultante fica sob o workspace; usá-lo para o nome final de cada operação. Para a origem, canonicalizar e checar `starts_with(workspace_root)`.
- Cópia/movimentação recursiva: para pastas, copiar a árvore inteira (`std::fs` + walk manual ou `copy_dir` próprio); `move_path` pode tentar `fs::rename` primeiro e cair para copiar+remover quando origem e destino estiverem em volumes diferentes.
- Resolução de colisão (copy/move): se o nome de destino já existir, gerar alternativa que **não** sobrescreve (ex.: `nome - Cópia`, `nome - Cópia (2)`, …). Rename **não** resolve colisão — retorna erro.
- `delete_to_trash`: `trash::delete(path)`; mapear erro do crate para `Result<_, String>` no padrão dos comandos atuais.
- Erros retornados como `Result<T, String>` no mesmo formato dos comandos existentes, para o front exibir mensagem.
- Cada comando anotado com `#[tauri::command]` e adicionado à macro `tauri::generate_handler!` em [lib.rs](../../src-tauri/src/lib.rs).

## Critérios de aceite

- [ ] `rename_path` renomeia no mesmo diretório e rejeita colisão com mensagem clara.
- [ ] `delete_to_trash` envia o item para a Lixeira do SO (recuperável), não apaga em definitivo.
- [ ] `copy_path` copia arquivo e pasta (recursivo) resolvendo colisão sem sobrescrever.
- [ ] `move_path` move arquivo e pasta (recursivo) resolvendo colisão sem sobrescrever.
- [ ] Operações com caminho fora do workspace são rejeitadas.
- [ ] Os 4 comandos estão registrados em [lib.rs](../../src-tauri/src/lib.rs) e expostos em [api.ts](../../src/api.ts).
- [ ] Testes unitários passam (`cargo test`).
