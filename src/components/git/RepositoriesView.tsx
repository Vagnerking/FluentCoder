import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { IconButton } from "../ui/IconButton";
import { gitFetch, gitPull, gitPush } from "../../api";
import type { GitStatus } from "../../types";
import { fetchGitStatusShared, requestGitRefresh } from "../../git/useGitStatuses";
import { getGitRefreshScheduler, gitRepoKey } from "../../git/gitRefresh";
import { showGitToast } from "../../git/gitToasts";
import { repoSyncLabel, repoSyncPlan, runWithConcurrency } from "../../git/repositoryOps";

/** Um repositório da lista (repo descoberto, worktree, aninhado ou SSH). */
export interface RepositoryEntry {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
  connId?: string;
  /** SSH: conectado, conectando ou com erro. */
  status?: "connected" | "connecting" | "error";
  error?: string;
  kind?: string;
}

const KIND_LABEL: Record<string, string> = {
  worktree: "worktree",
  submodule: "submódulo",
  nested: "aninhado",
};

const BULK_LIMIT = 4;

export type RepoState = GitStatus | "loading" | { error: string };

/**
 * Status dos repositórios da lista. Usa o status compartilhado (1 chamada em
 * voo por repo com a status bar) e o agendador único (watcher/polling) — não
 * cria timers nem muda os alvos do agendador.
 */
export function useRepositoryStatuses(repos: RepositoryEntry[]): Record<string, RepoState> {
  const [states, setStates] = useState<Record<string, RepoState>>({});
  const key = repos.map((r) => `${r.id}\u0001${r.connId ?? ""}\u0001${r.status ?? ""}`).join("\u0000");
  const reposRef = useRef(repos);
  reposRef.current = repos;
  useEffect(() => {
    const load = (only: Set<string> | null) => {
      for (const repo of reposRef.current) {
        if (repo.provider === "ssh" && !repo.connId) continue;
        const repoKey = gitRepoKey(repo.path, repo.connId);
        if (only && !only.has(repoKey)) continue;
        setStates((prev) => (prev[repo.id] ? prev : { ...prev, [repo.id]: "loading" }));
        fetchGitStatusShared(repo.path, repo.connId)
          .then((status) => setStates((prev) => ({ ...prev, [repo.id]: status })))
          .catch((err) => setStates((prev) => ({ ...prev, [repo.id]: { error: String(err) } })));
      }
    };
    load(null);
    return getGitRefreshScheduler().subscribe((event) => load(new Set(event.keys)));
  }, [key]);
  return states;
}

interface RepositoriesViewProps {
  repos: RepositoryEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onOpenTerminal?: (path: string, connId?: string) => void;
  /** Tira o repo da lista (volta pelo menu "Mostrar ocultos"). */
  onHide?: (id: string) => void;
  /** Status por repo (de `useRepositoryStatuses`). */
  states: Record<string, RepoState>;
  /** Operações por repo / em lote (de `useRepositoryBulk`). */
  bulk: BulkController;
}

export interface BulkController {
  running: string | null;
  busy: ReadonlySet<string>;
  fetchAll: () => void;
  syncAll: () => void;
  run: (repo: RepositoryEntry, op: "fetch" | "pull" | "push" | "sync") => void;
}

/** Operações por repo e em lote (concorrência 4, erro por repo em toast). */
export function useRepositoryBulk(repos: RepositoryEntry[], states: Record<string, RepoState>): BulkController {
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [running, setRunning] = useState<string | null>(null);
  const statesRef = useRef(states);
  statesRef.current = states;

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const exec = useCallback(async (repo: RepositoryEntry, op: "fetch" | "pull" | "push" | "sync") => {
    mark(repo.id, true);
    try {
      if (op === "fetch") await gitFetch(repo.path, repo.connId);
      else if (op === "pull") await gitPull(repo.path, repo.connId);
      else if (op === "push") await gitPush(repo.path, repo.connId);
      else {
        const s = statesRef.current[repo.id];
        const plan = repoSyncPlan(typeof s === "object" && s && "isRepo" in s ? s : null);
        if (plan.pull) await gitPull(repo.path, repo.connId);
        if (plan.push) await gitPush(repo.path, repo.connId);
      }
    } finally {
      mark(repo.id, false);
      requestGitRefresh({ root: repo.path, connId: repo.connId }, op === "fetch" ? "fetch" : "op");
    }
  }, []);

  const run = useCallback(
    (repo: RepositoryEntry, op: "fetch" | "pull" | "push" | "sync") => {
      exec(repo, op).catch((err) => showGitToast("error", `${repo.name}: a operação Git falhou`, err));
    },
    [exec]
  );

  const bulk = useCallback(
    async (label: string, op: "fetch" | "sync") => {
      const targets = repos.filter((r) => {
        if (r.provider === "ssh" && !r.connId) return false;
        if (op === "fetch") return true;
        const s = statesRef.current[r.id];
        const plan = repoSyncPlan(typeof s === "object" && s && "isRepo" in s ? s : null);
        return plan.pull || plan.push;
      });
      if (!targets.length) {
        showGitToast("info", op === "sync" ? "Todos os repositórios já estão em dia." : "Nenhum repositório para buscar.");
        return;
      }
      setRunning(label);
      const results = await runWithConcurrency(targets, BULK_LIMIT, (repo) => exec(repo, op));
      setRunning(null);
      const failed = results.map((r, i) => ({ r, repo: targets[i] })).filter((x) => !x.r.ok);
      for (const { r, repo } of failed) showGitToast("error", `${repo.name}: ${label.toLowerCase()} falhou`, r.error);
      if (!failed.length) showGitToast("info", `${label}: ${targets.length} repositório${targets.length === 1 ? "" : "s"} concluído${targets.length === 1 ? "" : "s"}.`);
    },
    [exec, repos]
  );

  return {
    running,
    busy,
    fetchAll: () => void bulk("Buscar todos", "fetch"),
    syncAll: () => void bulk("Sincronizar todos", "sync"),
    run,
  };
}

function kindIcon(repo: RepositoryEntry): IconAction {
  if (repo.provider === "ssh") return "remote";
  if (repo.kind === "worktree") return "gitWorktree";
  if (repo.kind === "submodule" || repo.kind === "nested") return "folder";
  return "gitRepo";
}

/**
 * View "Repositórios" (estilo VS Code): uma linha por repositório com branch,
 * ↓/↑, alterações e ações (buscar, puxar, enviar, sincronizar, terminal). O
 * ativo fica destacado; clicar escolhe o ativo de SCM, grafo, status bar e
 * terminal novo. ↑/↓/Home/End movem; Enter/Espaço escolhem.
 */
export function RepositoriesView({ repos, activeId, onSelect, onOpenTerminal, onHide, states, bulk }: RepositoriesViewProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, repos.findIndex((r) => r.id === activeId)));

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    let next = focusIndex;
    if (e.key === "ArrowDown") next = Math.min(repos.length - 1, focusIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, focusIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = repos.length - 1;
    else return;
    e.preventDefault();
    setFocusIndex(next);
    listRef.current?.querySelectorAll<HTMLElement>("[data-repo-row]")[next]?.focus();
  };

  if (!repos.length) {
    return <div className="repos-empty">Nenhum repositório Git no workspace.</div>;
  }

  return (
    <ul ref={listRef} className="repos-list" role="listbox" aria-label="Repositórios do workspace" onKeyDown={onKeyDown}>
      {repos.map((repo, index) => {
        const state = states[repo.id];
        const status = state && typeof state === "object" && "isRepo" in state ? state : null;
        const disconnected = repo.provider === "ssh" && !repo.connId;
        const isActive = repo.id === activeId;
        const changes = status?.files.length ?? 0;
        const sync = repoSyncLabel(status);
        const plan = repoSyncPlan(status);
        const isBusy = bulk.busy.has(repo.id);
        const kind = repo.provider === "ssh" ? "SSH" : repo.kind ? KIND_LABEL[repo.kind] : undefined;
        const detail = disconnected
          ? repo.status === "connecting"
            ? "conectando…"
            : repo.status === "error"
              ? `erro SSH${repo.error ? `: ${repo.error}` : ""}`
              : "desconectado"
          : state === "loading" || !state
            ? "carregando…"
            : "error" in (state as object)
              ? "sem acesso ao status"
              : status && !status.isRepo
                ? "não é um repositório Git"
                : null;
        return (
          <li
            key={repo.id}
            data-repo-row
            role="option"
            aria-selected={isActive}
            aria-current={isActive ? "true" : undefined}
            tabIndex={index === focusIndex ? 0 : -1}
            className={`repos-row${isActive ? " is-active" : ""}${disconnected ? " is-disconnected" : ""}`}
            title={`${repo.path}${kind ? ` (${kind})` : ""}`}
            onClick={() => {
              setFocusIndex(index);
              if (!disconnected) onSelect(repo.id);
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                e.preventDefault();
                if (!disconnected) onSelect(repo.id);
              }
            }}
          >
            <Codicon name={kindIcon(repo)} size={14} className="repos-kind-icon" />
            <span className="repos-name">{repo.name}</span>
            {kind && <span className="repos-kind">{kind}</span>}
            {detail ? (
              <span className="repos-detail">{detail}</span>
            ) : (
              <span className="repos-meta">
                <span className="repos-branch" title={`Branch ${status?.branch ?? ""}`}>
                  <Codicon name="gitBranch" size={12} />
                  <span>{status?.branch || "—"}</span>
                </span>
                {sync && (
                  <span className="repos-sync" aria-label={`${status?.behind ?? 0} a receber, ${status?.ahead ?? 0} a enviar`}>
                    {sync}
                  </span>
                )}
                {changes > 0 && (
                  <span className="repos-changes" aria-label={`${changes} alterações`} title={`${changes} alterações`}>
                    {changes}
                  </span>
                )}
              </span>
            )}
            {!disconnected && (
              <span className="repos-actions" onClick={(e) => e.stopPropagation()}>
                {isBusy ? (
                  <span className="repos-busy" role="status" aria-label={`Operação em andamento em ${repo.name}`}>
                    <Codicon name="loading" size={14} />
                  </span>
                ) : (
                  <>
                    <IconButton
                      icon="sync"
                      size="sm"
                      label={plan.pull || plan.push ? `Sincronizar ${repo.name} (${sync})` : `Sincronizar ${repo.name}: ${plan.skip}`}
                      disabled={!(plan.pull || plan.push)}
                      onClick={() => bulk.run(repo, "sync")}
                    />
                    <IconButton icon="gitFetch" size="sm" label={`Buscar (fetch) em ${repo.name}`} onClick={() => bulk.run(repo, "fetch")} />
                    {onOpenTerminal && (
                      <IconButton
                        icon="terminal"
                        size="sm"
                        label={`Abrir terminal em ${repo.name}`}
                        onClick={() => onOpenTerminal(repo.path, repo.connId)}
                      />
                    )}
                    {onHide && (
                      <IconButton icon="hideView" size="sm" label={`Ocultar ${repo.name} da lista`} onClick={() => onHide(repo.id)} />
                    )}
                  </>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
