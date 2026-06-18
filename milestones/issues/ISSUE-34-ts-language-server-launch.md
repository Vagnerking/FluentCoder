# ISSUE-34 · Rust: launch do typescript-language-server (Node)

**Épico:** [TypeScript e JavaScript — IntelliSense via LSP real](../EPIC-lsp-typescript-javascript.md) · **Camada:** Rust · **Tamanho:** M · **Depende de:** 22

## Contexto

O `typescript-language-server` é um processo Node.js que expõe o TypeScript Language Service
via LSP sobre `--stdio`. Esta issue implementa a lógica de localização e launch desse servidor
no backend Rust, seguindo o mesmo padrão da ISSUE-26 (Roslyn).

## Tarefas

- [x] Criar `src-tauri/src/lsp/typescript.rs`:
      - Função `pub fn detect_node() -> Result<PathBuf>`: localiza `node` no PATH; erro descritivo
        se ausente ("Para usar IntelliSense TypeScript/JavaScript, instale o Node.js em ...").
      - Função `pub fn detect_ts_language_server(project_root: &Path) -> Result<PathBuf>`:
        - Verifica se `typescript-language-server` existe em `{project_root}/node_modules/.bin/`.
        - Fallback: verifica instalação global (`npm root -g`).
        - Erro descritivo se não encontrado: "Instale com `npm install -g typescript-language-server typescript`".
      - Função `pub fn detect_tsserver(project_root: &Path) -> Result<PathBuf>`:
        - Prefere `typescript` do `node_modules` local do projeto (para respeitar a versão do projeto).
        - Fallback: `typescript` global.
      - Função `pub fn ts_launch_command(project_root: &Path) -> Result<(String, Vec<String>)>`:
        - Chama `detect_node`, `detect_ts_language_server`, `detect_tsserver`.
        - Retorna `(node_path, ["typescript-language-server_path", "--stdio"])`.
        - Passa `--tsserver-path` apontando para o `tsserver.js` local se encontrado.
- [x] Implementar comando Tauri `lsp_ensure_ts_server(project_root: String) -> Result<LaunchInfo>`:
      - Retorna `{ program, args }` para o front usar ao chamar `lsp_start_server`.
- [x] Registrar em `lib.rs` e expor em `api.ts`.

## Arquivos

- `src-tauri/src/lsp/typescript.rs` (novo)
- `src-tauri/src/lsp/mod.rs` (adicionar `mod typescript;`)
- `src-tauri/src/lib.rs` (registrar `lsp_ensure_ts_server`)
- `src/api.ts` (adicionar `ensureTsServer`)

## Detalhes técnicos

- O `typescript-language-server` é invocado como:
  `node /path/to/typescript-language-server --stdio`
  com opção `--tsserver-path /path/to/node_modules/typescript/lib/tsserver.js`.
- Preferir a versão local do projeto (`node_modules/.bin/`) sobre a global para respeitar
  a versão de TypeScript configurada no projeto.
- Não fazer download automático do `typescript-language-server` — exigir que esteja instalado
  (via `npm install -g typescript-language-server typescript` ou no projeto).
  Erro claro na UX se ausente (ISSUE-28 cobre o padrão de exibição).
- Não é necessário `tokio` adicional — reutiliza o módulo já configurado nas issues anteriores.

## Critérios de aceite

- [x] `lsp_ensure_ts_server` retorna `{ program, args }` corretos em um projeto com `typescript-language-server` instalado.
- [x] Se `node` não estiver no PATH, retorna erro com mensagem descritiva.
- [x] Se `typescript-language-server` não estiver instalado, retorna erro com instrução de instalação.
- [x] Prefere versão local ao global quando disponível.
- [x] `cargo check` passa.
