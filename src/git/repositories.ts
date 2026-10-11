/**
 * Modelo de repositórios do workspace (puro, testado).
 *
 * Entrada: pastas do workspace + repos descobertos pelo backend
 * (`git_repos_discover`, deduplicados por toplevel) + conexões SSH.
 * Saída: a lista única de repositórios (alvos de status/SCM) e o mapa
 * pasta → repo, usado para a status bar não somar duas vezes o mesmo repo.
 */
import type { GitRepositoryRef } from "./activeRepository.ts";
import { gitRepoKey } from "./gitRefresh.ts";

export interface DiscoveredRepo {
  id: string;
  root: string;
  gitDir: string;
  commonDir: string;
  kind: string;
  parentRoot?: string | null;
  folders: string[];
}

export interface WorkspaceFolderLike {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
}

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function baseName(path: string): string {
  return norm(path).split("/").pop() || path;
}

function within(path: string, root: string): boolean {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

export interface WorkspaceRepositories {
  repos: GitRepositoryRef[];
  /** folder.id → repo.id (pastas sem repo ficam de fora). */
  folderRepo: Record<string, string>;
}

/**
 * - Local: um repo por toplevel descoberto (ordem das pastas). Nome = nome da
 *   pasta do workspace quando ela É o toplevel; senão o nome do toplevel (e
 *   `pai/filho` para aninhados).
 * - Enquanto a descoberta não chegou (`discovered === null`), cada pasta local
 *   vira um alvo provisório (o status resolve o toplevel depois).
 * - SSH: uma entrada por pasta conectada; pastas SSH que apontam para o mesmo
 *   toplevel (aprendido do status) são unidas.
 */
export function buildWorkspaceRepositories(
  folders: WorkspaceFolderLike[],
  discovered: DiscoveredRepo[] | null,
  sshConnIds: Record<string, string | undefined>,
  sshToplevels: Record<string, string | undefined> = {}
): WorkspaceRepositories {
  const repos: GitRepositoryRef[] = [];
  const folderRepo: Record<string, string> = {};
  const localFolders = folders.filter((folder) => folder.provider === "local");

  if (discovered) {
    for (const repo of discovered) {
      const exactFolder = localFolders.find((folder) => norm(folder.path) === norm(repo.root));
      const parentName = repo.parentRoot ? baseName(repo.parentRoot) : null;
      const name =
        exactFolder?.name ??
        (repo.kind === "nested" || repo.kind === "submodule"
          ? `${parentName ? `${parentName}/` : ""}${baseName(repo.root)}`
          : baseName(repo.root));
      repos.push({
        id: gitRepoKey(repo.root),
        root: repo.root,
        name,
        provider: "local",
        kind: repo.kind,
        parentRoot: repo.parentRoot ?? null,
        folders: repo.folders,
      });
    }
    for (const folder of localFolders) {
      let best: GitRepositoryRef | null = null;
      for (const repo of repos) {
        if (repo.provider !== "local" || !within(folder.path, repo.root)) continue;
        if (!best || norm(repo.root).length > norm(best.root).length) best = repo;
      }
      if (best) folderRepo[folder.id] = best.id;
    }
  } else {
    for (const folder of localFolders) {
      const id = gitRepoKey(folder.path);
      repos.push({ id, root: folder.path, name: folder.name, provider: "local", folders: [folder.path] });
      folderRepo[folder.id] = id;
    }
  }

  const sshByToplevel = new Map<string, GitRepositoryRef>();
  for (const folder of folders) {
    if (folder.provider !== "ssh") continue;
    const connId = sshConnIds[folder.id];
    if (!connId) continue;
    const toplevel = sshToplevels[folder.id];
    const dedupeKey = toplevel ? `${connId}::${norm(toplevel)}` : null;
    const existing = dedupeKey ? sshByToplevel.get(dedupeKey) : undefined;
    if (existing) {
      existing.folders = [...(existing.folders ?? []), folder.path];
      folderRepo[folder.id] = existing.id;
      continue;
    }
    const repo: GitRepositoryRef = {
      id: gitRepoKey(folder.path, connId),
      root: folder.path,
      connId,
      name: folder.name,
      provider: "ssh",
      folders: [folder.path],
    };
    repos.push(repo);
    folderRepo[folder.id] = repo.id;
    if (dedupeKey) sshByToplevel.set(dedupeKey, repo);
  }

  return { repos, folderRepo };
}

export interface RepoCountsLike {
  repoId?: string;
  isRepo: boolean;
  changes?: number;
  conflicted?: number;
  ahead?: number;
  behind?: number;
  branch?: string | null;
}

/** Uma linha por repo (a primeira pasta de cada repo), para somas e contagens. */
export function uniqueRepoRows<T extends RepoCountsLike & { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (!row.isRepo) return false;
    const key = row.repoId ?? row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
