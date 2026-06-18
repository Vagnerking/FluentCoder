# ISSUE-15 · Índice de arquivos do projeto (Rust)

**Épico:** [Quick Open — busca de arquivos (Ctrl+P)](../EPIC-quick-open-file-search.md) · **Camada:** Rust · **Tamanho:** M · **Depende de:** —

## Contexto

O Quick Open precisa de uma lista plana de **todos os arquivos** sob a raiz do workspace,
sem descer em pastas pesadas. Hoje só temos `search_in_dir`, que lê o **conteúdo** de cada
arquivo — caro demais para um índice de nomes. Criamos um comando dedicado que só caminha a
árvore e devolve caminhos.

## Tarefas

- [ ] Criar comando `list_project_files(root: String) -> Result<Vec<ProjectFile>, String>`.
- [ ] `ProjectFile` (serde) com: `path` (absoluto), `name` (nome do arquivo),
      `rel` (caminho relativo a `root`, com `/` normalizado para exibição).
- [ ] Caminhar recursivamente a partir de `root`, pulando a lista de diretórios pesados.
- [ ] **Reusar** a lista de skip de [search.rs](../src-tauri/src/search.rs#L20-L28):
      extrair `SKIP_DIRS` para um módulo comum (ex.: `walk.rs` ou `const` público) e usar
      nos dois comandos, sem duplicar.
- [ ] Pular diretórios sem permissão silenciosamente (como `walk` já faz hoje).
- [ ] Cap de segurança (ex.: `MAX_FILES = 20_000`) para não estourar em projetos gigantes;
      logar/sinalizar truncamento se atingido.
- [ ] Registrar o comando no `invoke_handler` de [lib.rs](../src-tauri/src/lib.rs).

## Arquivos

- `src-tauri/src/file_index.rs` (novo) — ou adicionar em `search.rs` e renomear o módulo
- `src-tauri/src/search.rs` (extrair `SKIP_DIRS`)
- `src-tauri/src/lib.rs` (registrar comando + `mod`)

## Detalhes técnicos

- Apenas arquivos regulares entram no índice (`file_type.is_file()`); dirs só são caminhados.
- `rel` calculado com `path.strip_prefix(root)`; normalizar separador para `/` para casar
  com a exibição estilo VSCode independente de OS.
- Não ler conteúdo nem checar binário — é só nome/caminho, então é rápido.
- Ordenação não é responsabilidade do backend; o front ordena pelo score do fuzzy.

## Critérios de aceite

- [ ] `list_project_files(root)` devolve todos os arquivos sob `root` menos os de `SKIP_DIRS`.
- [ ] `SKIP_DIRS` existe num único lugar e é usado por `search_in_dir` e pelo novo comando.
- [ ] Caminhos relativos saem normalizados (`/`), nomes corretos.
- [ ] `cargo check` sem erros; comando aparece registrado no `invoke_handler`.
