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

## Status (`src-tauri/src/git/status.rs`)

- `git status --porcelain=v2 -z --branch`: caminhos crus (acentos, espaços,
  aspas), rename com `origPath`, conflito `u` com 10 campos antes do caminho.
  Detached sai do `# branch.oid` (sem spawn extra).
- `GitStatus.root` = `rev-parse --show-toplevel`. **Os caminhos de
  `files[]` são relativos a `root`**, não à pasta do workspace consultada
  (que pode ser subpasta do repo). Junte caminhos e rode operações a partir de
  `root` (`joinRepoPath(status.root, f.path)`).
- Branch: `symbolic-ref --short -q HEAD` (nome completo, `feat/x`), destacado
  `(abc1234…)`; leitura de `HEAD` só como fallback sem CLI, seguindo `.git`
  arquivo (`gitdir:`) de worktrees/submódulos.

## Atualização: agendador único + watcher

- **Frontend** (`src/git/gitRefresh.ts`): um único agendador por janela. Não
  crie `setInterval` de status em componentes — use `useGitStatuses`
  (App: status bar/decorações) ou `useGitRefresh` (painel SCM) e, depois de
  qualquer operação que muda o repo (commit, checkout, pull, push, stash,
  worktree…), chame `requestGitRefresh({ root, connId }, "op")`.
  - Repos locais com watcher `full`: nenhum polling.
  - SSH e watcher `git-only`/`failed`: polling 5 s com foco, 30 s sem foco,
    pausado com a janela oculta/minimizada.
  - Auto-fetch: relógio por repo (chave raiz+conexão) no agendador; trocar de
    aba não reinicia.
  - `fetchGitStatusShared` deduplica o status em voo entre App e SCM.
- **Backend** (`src-tauri/src/git/watcher.rs`, `git_watch_set(roots)`): emite
  `git://repo-changed {root, scopes}` (debounce 300 ms). Observa o git dir
  (HEAD/index/estado de operação), `refs/` e a árvore de trabalho **sem
  diretórios ignorados**. No Linux cada diretório custa 1 watch do inotify:
  teto global `DEFAULT_DIR_CAP` (2048) somado entre repos; repo que não cabe
  fica `git-only` e o frontend faz polling. Neste repo: 77 diretórios
  observados de 28 211 (node_modules/target/worktrees ignorados).

## Repositórios e repositório ativo

- `git_repos_discover(folders, maxDepth)` (`src-tauri/src/git/discovery.rs`):
  repos deduplicados por toplevel; aninhados até `git.repositoryScanMaxDepth`
  (localStorage, padrão 1, máx. 5; ignora node_modules/target/dist/…);
  `kind` = `main` | `worktree` | `submodule` | `nested` com `parentRoot`.
- Frontend: `buildWorkspaceRepositories` (`src/git/repositories.ts`) gera a
  lista única de repos (alvos de status/SCM) e o mapa pasta → repo. **Nunca**
  trate "pasta do workspace" como "repositório": uma subpasta de um repo é o
  mesmo repo; a status bar soma por `repoId` (`uniqueRepoRows`).
- Repo ativo único (`src/git/activeRepository.ts`): escolha explícita (clique
  no repo do SCM) > repo mais profundo que contém o arquivo focado > primeiro.
  React: `useActiveGitRepository()`; fora do React:
  `getActiveGitRepository()`/`subscribeActiveGitRepository()` (ex.: cwd de
  terminal novo).
