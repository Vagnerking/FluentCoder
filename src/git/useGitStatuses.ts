import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { gitStatus } from "../api";
import type { GitStatus } from "../types";
import {
  getActiveGitRepository,
  getGitRepositories,
  subscribeActiveGitRepository,
  type GitRepositoryRef,
} from "./activeRepository";
import {
  getGitRefreshScheduler,
  gitRepoKey,
  sharedGitCall,
  type GitRefreshEvent,
  type GitRefreshReason,
} from "./gitRefresh";

export interface GitStatusTarget {
  id: string;
  rootPath: string;
  connId?: string;
}

export interface GitStatusEntry extends GitStatusTarget {
  status: GitStatus | null;
}

/** Status compartilhado (1 chamada em voo por repo entre App e painel SCM). */
export function fetchGitStatusShared(rootPath: string, connId?: string): Promise<GitStatus> {
  return sharedGitCall(`status:${gitRepoKey(rootPath, connId)}`, () => gitStatus(rootPath, connId));
}

/**
 * Status de vários alvos, dirigido pelo agendador único (watcher + polling de
 * fallback + pedidos após operações). Não cria timers próprios.
 */
export function useGitStatuses(targets: GitStatusTarget[]): {
  states: Record<string, GitStatusEntry>;
  refresh: (target?: string | { root: string; connId?: string } | null, reason?: GitRefreshReason) => void;
} {
  const [states, setStates] = useState<Record<string, GitStatusEntry>>({});
  const targetsKey = targets.map((t) => `${t.id}\u0001${gitRepoKey(t.rootPath, t.connId)}`).join("\u0000");
  const stableTargets = useMemo(() => targets, [targetsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const targetsRef = useRef(stableTargets);
  targetsRef.current = stableTargets;
  const statesRef = useRef(states);
  statesRef.current = states;

  useEffect(() => {
    const scheduler = getGitRefreshScheduler();
    const load = (keys: Set<string> | null) => {
      for (const target of targetsRef.current) {
        const key = gitRepoKey(target.rootPath, target.connId);
        if (keys ? !keys.has(key) : statesRef.current[target.id] !== undefined) continue;
        fetchGitStatusShared(target.rootPath, target.connId)
          .then((status) => {
            if (status.isRepo && status.root) scheduler.setRepoRoot(key, status.root);
            setStates((prev) => {
              const current = prev[target.id];
              if (current && sameStatus(current.status, status)) return prev;
              return { ...prev, [target.id]: { ...target, status } };
            });
          })
          .catch(() => {
            setStates((prev) => ({ ...prev, [target.id]: { ...target, status: null } }));
          });
      }
    };
    const unsubscribe = scheduler.subscribe((event: GitRefreshEvent) => load(new Set(event.keys)));
    // Remove estados de alvos que saíram.
    const ids = new Set(stableTargets.map((t) => t.id));
    setStates((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    scheduler.setTargets(
      stableTargets.map((t) => ({ key: gitRepoKey(t.rootPath, t.connId), root: t.rootPath, connId: t.connId }))
    );
    // O agendador só emite "targets" para chaves novas NELE; um alvo que este
    // hook ainda não carregou (remontagem) é buscado já.
    load(null);
    return unsubscribe;
  }, [stableTargets]);

  const refresh = useCallback(
    (target?: string | { root: string; connId?: string } | null, reason: GitRefreshReason = "manual") =>
      getGitRefreshScheduler().request(target, reason),
    []
  );

  return { states, refresh };
}

/**
 * Assina o agendador para um repo (painel SCM). `onRefresh` recebe o evento
 * agregado para decidir o que recarregar (status sempre; refs/stash/grafo só
 * quando HEAD/refs/operação mudaram).
 */
export function useGitRefresh(
  rootPath: string | null,
  connId: string | undefined,
  onRefresh: (event: GitRefreshEvent) => void
): void {
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;
  useEffect(() => {
    if (!rootPath) return;
    const key = gitRepoKey(rootPath, connId);
    const scheduler = getGitRefreshScheduler();
    return scheduler.subscribe((event) => {
      if (event.keys.includes(key)) callbackRef.current(event);
    });
  }, [rootPath, connId]);
}

/** Pede atualização a todos que observam esse repo (App, SCM, grafo). */
export function requestGitRefresh(
  target?: string | { root: string; connId?: string } | null,
  reason: GitRefreshReason = "op"
): void {
  getGitRefreshScheduler().request(target, reason);
}

/** Eventos que mexem em refs/HEAD/operação (grafo, branches, stash, worktrees). */
export function gitEventTouchesRefs(event: GitRefreshEvent): boolean {
  if (event.reasons.some((r) => r === "op" || r === "fetch" || r === "manual" || r === "visible")) return true;
  return event.scopes.some((s) => s === "head" || s === "refs" || s === "operation");
}

/** Repositório ativo compartilhado (SCM, grafo, status bar, terminal). */
export function useActiveGitRepository(): GitRepositoryRef | null {
  return useSyncExternalStore(subscribeActiveGitRepository, getActiveGitRepository, getActiveGitRepository);
}

/** Repositórios conhecidos (descobertos + SSH), deduplicados por toplevel. */
export function useGitRepositoryList(): GitRepositoryRef[] {
  return useSyncExternalStore(subscribeActiveGitRepository, getGitRepositories, getGitRepositories);
}

function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.root !== b.root ||
    a.branch !== b.branch ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.isRepo !== b.isRepo ||
    a.hasUpstream !== b.hasUpstream ||
    a.conflicted !== b.conflicted ||
    a.files.length !== b.files.length
  ) {
    return false;
  }
  return a.files.every((f, i) => {
    const g = b.files[i];
    return f.path === g.path && f.code === g.code && f.staged === g.staged;
  });
}
