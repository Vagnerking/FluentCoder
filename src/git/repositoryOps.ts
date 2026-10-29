/**
 * Regras puras da view "Repositórios" (testadas em `repositoryOps.test.ts`):
 * operações em lote com limite de concorrência (erros por repo não abortam
 * os demais) e o plano de sincronização de cada repo.
 */

export interface SettledResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/**
 * Roda `fn` para cada item com no máximo `limit` em paralelo. Nunca rejeita:
 * devolve um resultado por item, na ordem de entrada.
 */
export async function runWithConcurrency<I, T>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<T>
): Promise<SettledResult<T>[]> {
  const results: SettledResult<T>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

export interface RepoStatusLike {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  conflicted?: number;
  files: readonly unknown[];
}

export interface SyncPlan {
  pull: boolean;
  push: boolean;
  /** Por que não há nada a fazer (para o tooltip/toast). */
  skip?: string;
}

/** Sincronizar = puxar se atrás, enviar se à frente (como o VS Code). */
export function repoSyncPlan(status: RepoStatusLike | null | undefined): SyncPlan {
  if (!status || !status.isRepo) return { pull: false, push: false, skip: "não é um repositório" };
  if (!status.hasUpstream) return { pull: false, push: false, skip: "branch sem upstream" };
  if ((status.conflicted ?? 0) > 0) return { pull: false, push: false, skip: "há conflitos" };
  if (status.branch.startsWith("(")) return { pull: false, push: false, skip: "HEAD destacado" };
  if (!status.ahead && !status.behind) return { pull: false, push: false, skip: "em dia" };
  return { pull: status.behind > 0, push: status.ahead > 0 };
}

/** Rótulo de sincronização curto: "↓2 ↑1", "✓" (em dia) ou "" (sem upstream). */
export function repoSyncLabel(status: RepoStatusLike | null | undefined): string {
  if (!status?.isRepo || !status.hasUpstream) return "";
  const parts: string[] = [];
  if (status.behind) parts.push(`↓${status.behind}`);
  if (status.ahead) parts.push(`↑${status.ahead}`);
  return parts.join(" ");
}
