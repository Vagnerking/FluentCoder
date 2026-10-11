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

## Grafo paginado, detalhes e linhagem (`src-tauri/src/git/graph.rs`)

- `git_graph_page(path, query, cursor, pageSize=200)` (+ `ssh_git_graph_page`).
  Sem cursor = 1ª página **com cabeçalho**: refs (`for-each-ref`, upstream e
  ahead/behind de todas as branches, tags descascadas), HEAD, branch base
  (`origin/HEAD` → main/master/develop/trunk), remotos (links do provedor),
  identidade, `incoming`/`outgoing` (`rev-list --left-right HEAD...@{u}`).
  Meta/refs/HEAD/track rodam em paralelo; no SSH, 1 lote + o log.
- O cursor guarda `skip` + os **hashes** das revs resolvidas na 1ª página:
  rolar não muda se uma ref andar. Nunca recalcule revs por página.
- Refs: `auto` (HEAD + upstream + base e a remota da base, como o
  "Automático" do VS Code), `current` (HEAD + upstream), `all` (refs +
  HEAD, nunca `refs/stash`), `selected`.
- Filtros: `author`/`search` **não removem linhas** — a 1ª página traz
  `matches` (hashes) e a UI esmaece o resto; `path` limita o grafo com
  `--parents` (pais reescritos, grafo conexo); `firstParent`.
- `git_commit_details`: **um** `git show -z --raw --numstat
  --diff-merges=first-parent` (mensagem `%B`, committer, co-autores,
  arquivos com +/−); cache por hash no backend e no front (`graphApi.ts`).
- `git_branch_lineage(ref, base?)`: merge-base, ahead/behind, caminho
  first-parent `base..ref` e, se integrada, o merge mais antigo do
  first-parent da base que descende da ponta (`--ancestry-path`), com o PR
  (`Merge pull request #N`, `(#N)`, `See merge request …!N`).
- Também: `git_diff_files(from, to|null)`, `git_cherry_pick`,
  `git_create_branch_at`; `git_diff_file_revision` aceita `rev:<hash>`
  (Comparar com…). Medido: 1ª página em 15 ms neste repo (465 commits) e
  160 ms num sintético de 50k sem commit-graph.

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

## Avatares (privacidade)

- Proibido mandar e-mail de autor para terceiros. `avatarUrl` no wire é
  sempre vazio; avatares vêm de `git_avatar(email, mode)` →
  `data:` URL ou `null` (iniciais), com cache em `app_data_dir/avatars`
  (7 dias positivo, 1 dia negativo, ≤ 256 KiB, 4 downloads simultâneos).
- Setting `git.avatars` (menu "…" do Git Fluent → Avatares dos autores):
  `github` (padrão: só `@users.noreply.github.com`), `gravatar` (opt-in,
  envia só o SHA-256 do e-mail) e `off` (nenhuma requisição).
- UI: `<GitAvatar>` (iniciais na hora, imagem quando chegar) ou
  `peekGitAvatar(email)` onde não dá para esperar (hover/status bar). Nunca
  coloque `<img src="https://…">` de avatar no DOM.

## Layout do painel SCM (até o ViewPane compartilhado chegar)

- A view de commit tem o nome do repositório (pasta única) ou "Controle do
  código-fonte" (multi-root); Conflitos › Preparadas › Alterações são linhas de
  grupo (`GitResourceGroupRow`), não cabeçalhos de seção. Não reintroduza o
  cartão "Index preparado".
- Corpos das views usam `flex: 0 1 var(--git-view-height)` + `overflow` na
  seção: encolhem e rolam, nunca desenham sobre o vizinho. Listas em grid do
  Git Fluent usam `align-content: start`.
- Cabeçalho do Git Fluent = título + "…"; o seletor de views é a faixa
  `GitFluentToolbar placement="body"` no topo do corpo. Seção recolhida
  esconde as ações (aparecem no hover/foco).
- Commit: placeholder curto ("Mensagem de commit"), atalho/branch no tooltip,
  textarea de 1–6 linhas, botão "Fazer commit (n)".
- Erros de operação Git: `showGitToast` (`src/git/gitToasts.ts`), nunca
  `alert()`.
