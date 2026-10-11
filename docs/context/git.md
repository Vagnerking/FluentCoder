# Git — contratos do backend e do painel Controle do Código-Fonte

Regras para quem mexe em `src-tauri/src/git.rs`, `src-tauri/src/git/*`, nos
espelhos `ssh_git_*` de `ssh.rs`, em `src/git/*`, `GitPanel.tsx` e
`src/components/git/*`.

## Runner (`src-tauri/src/git/runner.rs`)

- **Nenhum comando git roda na main thread.** No Tauri 2, `#[tauri::command] fn`
  síncrono executa na thread principal. Todo comando git local é
  `pub async fn` e delega para um `*_blocking` via `runner::blocking`
  (pool bloqueante do runtime). O teste `git_commands_are_async` quebra a
  compilação se um comando voltar a ser síncrono.
- Sempre chame o git por `run_git`/`runner::run_with`, nunca `Command::new("git")`.
  O runner aplica:
  - `-c core.quotepath=false -c color.ui=never`;
  - `GIT_TERMINAL_PROMPT=0` (sem prompt invisível pendurando o processo);
  - `GIT_OPTIONAL_LOCKS=0` em leituras (`CallKind::Read`): o status não
    disputa o `index.lock` nem reescreve o index — senão o watcher veria o
    próprio polling como mudança;
  - timeout por classe (leitura 60 s, escrita 180 s, rede 600 s) e
    cancelamento (`git_cancel(path, networkOnly)`), matando o grupo de
    processos (git + ssh/hooks).
- Formatos parseáveis: use `-z`/`%x00`/`%x1e`/`%x1f`. Nada de parse de saída
  com aspas/escapes octais.

## Histórico, blame e grafo sem N+1 (`src-tauri/src/git/history.rs`)

- Histórico, file history e compare: **um** `git log -z --numstat` com
  `history::LOG_FORMAT` traz metadados e estatísticas. Nunca volte a fazer
  `git show` por commit.
- Line history (`-L`) e blame: os hashes descobertos vão num único
  `git log --no-walk=unsorted -z --numstat` (stdin no local, args no SSH),
  sem pathspec (com pathspec o git descarta commits de renames antigos); o
  numstat é filtrado por caminho no parser.
- Identidade e remoto: um `git config --get-regexp` (`history::META_ARGS`).
- SSH: `exec_git_batch` roda vários `git` num único exec (`sh -c` com
  separador NUL), então histórico/grafo/compare custam 1 RTT e blame 2.
- Datas relativas vêm de `%at` formatado em pt-BR (`format_relative_time`),
  iguais às do blame/CodeLens.
- Grafo usa `--branches --remotes --tags HEAD`, não `--all` (exclui `refs/stash`).
