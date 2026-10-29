/**
 * Contexto ÚNICO de "repositório ativo", compartilhado por SCM, grafo, chip de
 * branch da status bar e terminal (antes cada superfície resolvia o seu).
 *
 * Resolução (`resolveActiveGitRepository`, pura e testada):
 * 1. escolha explícita (clique num repo do SCM / no menu da status bar), se o
 *    repo ainda existir;
 * 2. o repo de toplevel MAIS PROFUNDO que contém o arquivo focado (um repo
 *    aninhado ganha do pai);
 * 3. o primeiro repo da lista.
 *
 * Uso: `useActiveGitRepository()` (em `useGitStatuses.ts`) em componentes React;
 * `getActiveGitRepository()` / `subscribeActiveGitRepository()` fora do React
 * (ex.: cwd padrão de um terminal novo).
 */
export interface GitRepositoryRef {
  /** Chave estável (`gitRepoKey(root, connId)`). */
  id: string;
  /** Toplevel do repo (local) ou pasta do workspace (SSH). */
  root: string;
  connId?: string;
  name: string;
  provider: "local" | "ssh";
  /** `main` | `worktree` | `submodule` | `nested` (descoberta local). */
  kind?: string;
  parentRoot?: string | null;
  /** Pastas do workspace que caem neste repo. */
  folders?: string[];
}

interface State {
  repos: GitRepositoryRef[];
  focusPath: string | null;
  focusConnId: string | null;
  pinnedId: string | null;
  active: GitRepositoryRef | null;
}

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function within(path: string, root: string): boolean {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

export function resolveActiveGitRepository(
  repos: GitRepositoryRef[],
  focusPath: string | null,
  pinnedId: string | null,
  focusConnId: string | null = null
): GitRepositoryRef | null {
  if (pinnedId) {
    const pinned = repos.find((repo) => repo.id === pinnedId);
    if (pinned) return pinned;
  }
  if (focusPath) {
    let best: GitRepositoryRef | null = null;
    for (const repo of repos) {
      if ((repo.connId ?? null) !== (focusConnId ?? null) && repo.provider === "ssh") continue;
      if (!within(focusPath, repo.root)) continue;
      if (!best || norm(repo.root).length > norm(best.root).length) best = repo;
    }
    if (best) return best;
  }
  return repos[0] ?? null;
}

let state: State = { repos: [], focusPath: null, focusConnId: null, pinnedId: null, active: null };
const listeners = new Set<() => void>();

function recompute() {
  const active = resolveActiveGitRepository(state.repos, state.focusPath, state.pinnedId, state.focusConnId);
  const changed = active?.id !== state.active?.id || active?.root !== state.active?.root;
  state = { ...state, active };
  return changed;
}

function emit() {
  listeners.forEach((listener) => listener());
}

/** Lista de repos (descobertos + SSH). Mantém a escolha explícita se ainda existir. */
export function setGitRepositories(repos: GitRepositoryRef[]): void {
  const same =
    repos.length === state.repos.length &&
    repos.every((repo, i) => {
      const prev = state.repos[i];
      return prev.id === repo.id && prev.root === repo.root && prev.name === repo.name && prev.kind === repo.kind;
    });
  if (same) return;
  state = { ...state, repos };
  if (state.pinnedId && !repos.some((repo) => repo.id === state.pinnedId)) state = { ...state, pinnedId: null };
  recompute();
  emit();
}

/** Arquivo/pasta focado (editor ativo). Sem efeito se o repo resolvido não mudar. */
export function setGitFocusPath(path: string | null, connId: string | null = null): void {
  if (state.focusPath === path && state.focusConnId === connId) return;
  state = { ...state, focusPath: path, focusConnId: connId };
  // Focar um arquivo de OUTRO repo desfaz a escolha explícita (como o VS Code).
  if (state.pinnedId && path) {
    const pinned = state.repos.find((repo) => repo.id === state.pinnedId);
    const focused = resolveActiveGitRepository(state.repos, path, null, connId);
    if (pinned && focused && focused.id !== pinned.id && within(path, focused.root)) {
      state = { ...state, pinnedId: null };
    }
  }
  if (recompute()) emit();
}

/** Escolha explícita (SCM / status bar). `null` volta a seguir o editor. */
export function selectGitRepository(id: string | null): void {
  if (state.pinnedId === id) return;
  state = { ...state, pinnedId: id };
  if (recompute()) emit();
  else emit();
}

export function getActiveGitRepository(): GitRepositoryRef | null {
  return state.active;
}

/**
 * Pasta (e conexão SSH) de um terminal novo sem cwd explícito: o repositório
 * ativo — o mesmo de SCM, grafo e status bar; sem repo ativo, `fallback`.
 */
export function defaultTerminalTarget(
  fallback: string | null,
  active: Pick<GitRepositoryRef, "root" | "connId"> | null = state.active
): { cwd: string | null; connId: string | null } {
  if (active?.root) return { cwd: active.root, connId: active.connId ?? null };
  return { cwd: fallback, connId: null };
}

export function getGitRepositories(): GitRepositoryRef[] {
  return state.repos;
}

export function subscribeActiveGitRepository(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Só para testes. */
export function resetActiveGitRepositoryForTests(): void {
  state = { repos: [], focusPath: null, focusConnId: null, pinnedId: null, active: null };
  listeners.clear();
}
