/**
 * Agendador ÚNICO de atualização do Git (SCM, status bar, decorações, grafo).
 *
 * Substitui os dois `setInterval(5s)` do App (um da root ativa e outro de
 * todas as roots, que incluía a ativa de novo) e o "refresh só no mount" do
 * painel SCM. Regras (ver `docs/context/git.md`):
 * - Repos locais com watcher `full` NÃO são consultados por timer: o backend
 *   emite `git://repo-changed` (árvore de trabalho com .gitignore, index,
 *   HEAD, refs) e o agendador agrega e repassa aos assinantes.
 * - Polling só como fallback (SSH, watcher `git-only`/`failed`), com
 *   intervalo adaptativo: 5 s com foco, 30 s sem foco, **pausado** com a
 *   janela oculta/minimizada.
 * - Pedidos (`request`) são coalescidos por repo com debounce curto; após
 *   commit/checkout/pull/stash quem executou chama `request(repo, "op")`.
 * - Auto-fetch: um relógio por repo (chave estável raiz+conexão), que NÃO é
 *   reiniciado por troca de aba/arquivo.
 *
 * O núcleo é puro (dependências injetadas) para ser testável; o singleton
 * real é montado por `getGitRefreshScheduler()`.
 */

export type GitRefreshReason =
  | "watch"
  | "op"
  | "poll"
  | "focus"
  | "visible"
  | "manual"
  | "fetch"
  | "targets";

export interface GitRepoTarget {
  /** Chave estável (ver {@link gitRepoKey}). */
  key: string;
  /** Pasta consultada (root do workspace ou toplevel do repo). */
  root: string;
  connId?: string;
}

export interface GitRefreshEvent {
  keys: string[];
  reasons: GitRefreshReason[];
  /** Escopos do watcher (`head`, `index`, `refs`, `operation`, `worktree`). */
  scopes: string[];
}

export interface GitWatchInfo {
  root: string;
  mode: "full" | "git-only" | "failed" | string;
  dirs: number;
  error?: string | null;
}

export interface GitRefreshDeps {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** Janela oculta/minimizada → nada de polling nem auto-fetch. */
  isHidden: () => boolean;
  isFocused: () => boolean;
  /** Define os toplevels locais observados pelo backend. */
  watchRoots: (roots: string[]) => Promise<GitWatchInfo[]>;
  /** `git fetch` (local ou SSH). */
  fetch: (root: string, connId?: string) => Promise<void>;
  onFetched?: (key: string, at: number) => void;
}

export const GIT_POLL_FOCUSED_MS = 5_000;
export const GIT_POLL_UNFOCUSED_MS = 30_000;
export const GIT_REQUEST_DEBOUNCE_MS = 120;
export const GIT_AUTOFETCH_DEFAULT_MS = 180_000;

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

export function gitRepoKey(root: string, connId?: string | null): string {
  return `${connId || "local"}::${normalizeGitPath(root)}`;
}

function within(path: string, root: string): boolean {
  const p = normalizeGitPath(path);
  const r = normalizeGitPath(root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

interface TargetState {
  target: GitRepoTarget;
  /** Toplevel aprendido do status (`GitStatus.root`). */
  toplevel?: string;
  watchMode?: string;
  lastPollAt: number;
  lastFetchAt: number;
  fetching: boolean;
}

export interface GitRefreshScheduler {
  setTargets(targets: GitRepoTarget[]): void;
  /** Informa o toplevel real de um alvo (vem de `GitStatus.root`). */
  setRepoRoot(key: string, toplevel: string): void;
  subscribe(listener: (event: GitRefreshEvent) => void): () => void;
  /** Pede atualização de um alvo (chave, pasta ou toplevel) ou de todos. */
  request(target?: string | { root: string; connId?: string } | null, reason?: GitRefreshReason): void;
  /** Evento do watcher do backend. */
  handleRepoChanged(change: { root: string; scopes: string[] }): void;
  setAutoFetch(enabled: boolean, periodMs?: number): void;
  /** Chame em `visibilitychange`/`focus`/`blur`. */
  onWindowStateChange(): void;
  /** Modo do watcher por chave (diagnóstico/testes). */
  watchMode(key: string): string | undefined;
  dispose(): void;
}

export function createGitRefreshScheduler(deps: GitRefreshDeps): GitRefreshScheduler {
  const targets = new Map<string, TargetState>();
  const listeners = new Set<(event: GitRefreshEvent) => void>();
  let pendingKeys = new Set<string>();
  let pendingReasons = new Set<GitRefreshReason>();
  let pendingScopes = new Set<string>();
  let flushTimer: unknown = null;
  let pollTimer: unknown = null;
  let autoFetch = { enabled: false, periodMs: GIT_AUTOFETCH_DEFAULT_MS };
  let watchedKey = "";
  let disposed = false;
  let wasHidden = deps.isHidden();

  const flush = () => {
    flushTimer = null;
    if (pendingKeys.size === 0) return;
    const event: GitRefreshEvent = {
      keys: [...pendingKeys].filter((key) => targets.has(key)),
      reasons: [...pendingReasons],
      scopes: [...pendingScopes],
    };
    pendingKeys = new Set();
    pendingReasons = new Set();
    pendingScopes = new Set();
    if (event.keys.length === 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Um assinante com erro não derruba os outros.
      }
    }
  };

  const enqueue = (keys: Iterable<string>, reason: GitRefreshReason, scopes: string[] = []) => {
    let any = false;
    for (const key of keys) {
      if (!targets.has(key)) continue;
      pendingKeys.add(key);
      any = true;
    }
    if (!any) return;
    pendingReasons.add(reason);
    scopes.forEach((scope) => pendingScopes.add(scope));
    if (flushTimer == null) flushTimer = deps.setTimeout(flush, GIT_REQUEST_DEBOUNCE_MS);
  };

  const needsPolling = (state: TargetState) =>
    Boolean(state.target.connId) || state.watchMode !== "full";

  const syncWatch = () => {
    const roots = [
      ...new Set(
        [...targets.values()]
          .filter((state) => !state.target.connId)
          .map((state) => normalizeGitPath(state.toplevel ?? state.target.root))
      ),
    ].sort();
    const key = roots.join("\0");
    if (key === watchedKey) return;
    watchedKey = key;
    deps
      .watchRoots(roots)
      .then((infos) => {
        const byRoot = new Map(infos.map((info) => [normalizeGitPath(info.root), info.mode]));
        for (const state of targets.values()) {
          if (state.target.connId) continue;
          state.watchMode = byRoot.get(normalizeGitPath(state.toplevel ?? state.target.root)) ?? "failed";
        }
      })
      .catch(() => {
        for (const state of targets.values()) if (!state.target.connId) state.watchMode = "failed";
      });
  };

  const tick = () => {
    pollTimer = null;
    if (disposed) return;
    const hidden = deps.isHidden();
    const now = deps.now();
    if (!hidden) {
      const interval = deps.isFocused() ? GIT_POLL_FOCUSED_MS : GIT_POLL_UNFOCUSED_MS;
      const due = [...targets.values()].filter(
        (state) => needsPolling(state) && now - state.lastPollAt >= interval - 50
      );
      due.forEach((state) => (state.lastPollAt = now));
      enqueue(
        due.map((state) => state.target.key),
        "poll"
      );
      if (autoFetch.enabled) {
        for (const state of targets.values()) {
          if (state.fetching || now - state.lastFetchAt < autoFetch.periodMs) continue;
          state.fetching = true;
          const key = state.target.key;
          deps
            .fetch(state.target.root, state.target.connId)
            .then(() => {
              const at = deps.now();
              const current = targets.get(key);
              if (current) current.lastFetchAt = at;
              deps.onFetched?.(key, at);
              enqueue([key], "fetch");
            })
            .catch(() => {
              // Silencioso (credencial/rede); tenta de novo no próximo período.
              const current = targets.get(key);
              if (current) current.lastFetchAt = deps.now();
            })
            .finally(() => {
              const current = targets.get(key);
              if (current) current.fetching = false;
            });
        }
      }
    }
    schedulePoll();
  };

  const schedulePoll = () => {
    if (disposed || pollTimer != null) return;
    if (targets.size === 0 || deps.isHidden()) return;
    const interval = deps.isFocused() ? GIT_POLL_FOCUSED_MS : GIT_POLL_UNFOCUSED_MS;
    pollTimer = deps.setTimeout(tick, interval);
  };

  /** Um caminho (arquivo, pasta do workspace ou toplevel) pertence ao alvo? */
  const matchesPath = (state: TargetState, path: string) =>
    within(path, state.target.root) ||
    within(state.target.root, path) ||
    (state.toplevel != null && within(path, state.toplevel));

  const keysFor = (target?: string | { root: string; connId?: string } | null): string[] => {
    if (target == null) return [...targets.keys()];
    if (typeof target === "string" && targets.has(target)) return [target];
    const path = typeof target === "string" ? target : target.root;
    const connId = typeof target === "string" ? undefined : target.connId || undefined;
    return [...targets.values()]
      .filter((state) => typeof target === "string" || (state.target.connId || undefined) === connId)
      .filter((state) => matchesPath(state, path))
      .map((state) => state.target.key);
  };

  return {
    setTargets(next) {
      const now = deps.now();
      const nextKeys = new Set(next.map((target) => target.key));
      for (const key of [...targets.keys()]) if (!nextKeys.has(key)) targets.delete(key);
      const added: string[] = [];
      for (const target of next) {
        const existing = targets.get(target.key);
        if (existing) {
          existing.target = target;
          continue;
        }
        targets.set(target.key, {
          target,
          lastPollAt: now,
          // O primeiro auto-fetch acontece um período depois de o repo aparecer.
          lastFetchAt: now,
          fetching: false,
        });
        added.push(target.key);
      }
      syncWatch();
      enqueue(added, "targets");
      schedulePoll();
    },
    setRepoRoot(key, toplevel) {
      const state = targets.get(key);
      if (!state || !toplevel) return;
      if (state.toplevel && normalizeGitPath(state.toplevel) === normalizeGitPath(toplevel)) return;
      state.toplevel = toplevel;
      syncWatch();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(target, reason = "manual") {
      enqueue(keysFor(target), reason);
    },
    handleRepoChanged(change) {
      const root = normalizeGitPath(change.root);
      const keys = [...targets.values()]
        .filter(
          (state) =>
            !state.target.connId &&
            (normalizeGitPath(state.toplevel ?? state.target.root) === root ||
              within(state.target.root, root))
        )
        .map((state) => state.target.key);
      enqueue(keys, "watch", change.scopes);
    },
    setAutoFetch(enabled, periodMs = GIT_AUTOFETCH_DEFAULT_MS) {
      autoFetch = { enabled, periodMs: Math.max(30_000, periodMs) };
      schedulePoll();
    },
    onWindowStateChange() {
      const hidden = deps.isHidden();
      if (wasHidden && !hidden) {
        // Voltou a ficar visível: uma atualização geral, e o polling recomeça.
        enqueue(targets.keys(), "visible");
      } else if (!hidden && deps.isFocused()) {
        enqueue(targets.keys(), "focus");
      }
      wasHidden = hidden;
      if (pollTimer != null) {
        deps.clearTimeout(pollTimer);
        pollTimer = null;
      }
      schedulePoll();
    },
    watchMode(key) {
      return targets.get(key)?.watchMode;
    },
    dispose() {
      disposed = true;
      if (pollTimer != null) deps.clearTimeout(pollTimer);
      if (flushTimer != null) deps.clearTimeout(flushTimer);
      listeners.clear();
      targets.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Status compartilhado: App (status bar/decorações) e painel SCM pedem o status
// do mesmo repo no mesmo evento — uma única chamada em voo por repo.
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

export function sharedGitCall<T>(key: string, call: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = call().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

let singleton: GitRefreshScheduler | null = null;

/** Agendador da janela (monta listeners de watcher/visibilidade/foco). */
export function getGitRefreshScheduler(): GitRefreshScheduler {
  if (singleton) return singleton;
  const hasWindow = typeof window !== "undefined";
  const scheduler = createGitRefreshScheduler({
    now: () => Date.now(),
    setTimeout: (fn, ms) => (hasWindow ? window.setTimeout(fn, ms) : setTimeout(fn, ms)),
    clearTimeout: (id) => (hasWindow ? window.clearTimeout(id as number) : clearTimeout(id as never)),
    isHidden: () =>
      minimized || (typeof document !== "undefined" && document.visibilityState === "hidden"),
    isFocused: () => typeof document === "undefined" || document.hasFocus(),
    watchRoots: async (roots) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<GitWatchInfo[]>("git_watch_set", { roots });
    },
    fetch: async (root, connId) => {
      const { gitFetch } = await import("../api");
      await gitFetch(root, connId);
    },
    onFetched: (_key, at) => {
      lastAutoFetchAt = at;
      fetchListeners.forEach((listener) => listener(at));
    },
  });
  singleton = scheduler;
  if (hasWindow) {
    const onState = () => scheduler.onWindowStateChange();
    document.addEventListener("visibilitychange", onState);
    window.addEventListener("focus", onState);
    window.addEventListener("blur", onState);
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ root: string; scopes: string[] }>("git://repo-changed", (event) =>
          scheduler.handleRepoChanged(event.payload)
        )
      )
      .catch(() => {
        // Fora do Tauri (testes/preview): fica só o polling.
      });
    // WebKitGTK nem sempre marca a página como oculta ao minimizar: pergunta
    // ao Tauri e trata minimizado como oculto.
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        return win.onResized(async () => {
          minimized = await win.isMinimized().catch(() => false);
          scheduler.onWindowStateChange();
        });
      })
      .catch(() => {});
  }
  return scheduler;
}

let minimized = false;
let lastAutoFetchAt: number | null = null;
const fetchListeners = new Set<(at: number) => void>();

/** Notificado quando um auto-fetch conclui (status bar "último fetch"). */
export function onGitAutoFetched(listener: (at: number) => void): () => void {
  fetchListeners.add(listener);
  return () => fetchListeners.delete(listener);
}

export function lastGitAutoFetchAt(): number | null {
  return lastAutoFetchAt;
}

/** Usado pelo singleton: minimizado conta como oculto. */
export function isGitWindowMinimized(): boolean {
  return minimized;
}
