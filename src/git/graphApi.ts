/**
 * IPC do grafo paginado, detalhes de commit e linhagem de branches
 * (`src-tauri/src/git/graph.rs` + espelhos `ssh_git_*`). Mesmo roteamento do
 * resto da API git: `connId` explícito → SSH; senão remoto ativo → SSH;
 * senão local.
 */
import { invoke } from "@tauri-apps/api/core";
import { getActiveRemote } from "../remote/host";
import type { GitCommitFile } from "../types";

export type GraphRefMode = "auto" | "all" | "current" | "selected";

export interface GraphQuery {
  refs: GraphRefMode;
  /** Nomes curtos/completos para `selected`. */
  selected?: string[];
  /** Esmaece (não remove) quem não casa. */
  author?: string;
  search?: string;
  /** Limita o grafo (pais reescritos). */
  path?: string;
  firstParent?: boolean;
}

export interface GraphCursor {
  skip: number;
  revs: string[];
}

export interface GraphPerson {
  name: string;
  email: string;
}

export interface GraphRow {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Unix (s). */
  authorTime: number;
  commitTime: number;
  subject: string;
  coAuthors: GraphPerson[];
}

export type GraphRefKind = "branch" | "remote" | "tag";

export interface GraphRef {
  name: string;
  short: string;
  kind: GraphRefKind;
  target: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  isHead: boolean;
}

export interface GraphHead {
  hash: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GraphRemote {
  name: string;
  url: string;
}

export interface GraphHeader {
  refs: GraphRef[];
  head: GraphHead;
  defaultBranch: string | null;
  selectedRefs: string[];
  incoming: string[];
  outgoing: string[];
  remotes: GraphRemote[];
  identity: GraphPerson | null;
  matches: string[] | null;
}

export interface GraphPage {
  commits: GraphRow[];
  cursor: GraphCursor | null;
  header: GraphHeader | null;
  elapsedMs: number;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  subject: string;
  message: string;
  coAuthors: GraphPerson[];
  files: GitCommitFile[];
  additions: number;
  deletions: number;
}

export interface LineageMerge {
  hash: string;
  subject: string;
  time: number;
  pr: number | null;
  fastForward: boolean;
  /** 1º pai do merge (a base antes da integração). */
  firstParent: string | null;
  /** Commits que a branch levou no merge. */
  commits: number;
}

export interface BranchLineage {
  reference: string;
  base: string;
  tip: string;
  baseTip: string;
  mergeBase: string | null;
  mergeBaseSubject: string | null;
  mergeBaseTime: number | null;
  ahead: number;
  behind: number;
  path: string[];
  mergedInto: LineageMerge | null;
  isBase: boolean;
}

function route<T>(local: string, ssh: string, args: Record<string, unknown>, path: string, connId?: string): Promise<T> {
  const conn = connId ?? getActiveRemote()?.connId;
  if (conn) return invoke<T>(ssh, { connId: conn, root: path, ...args });
  return invoke<T>(local, { path, ...args });
}

export function gitGraphPage(
  path: string,
  query: GraphQuery,
  cursor: GraphCursor | null,
  pageSize = 200,
  connId?: string
): Promise<GraphPage> {
  return route("git_graph_page", "ssh_git_graph_page", { query, cursor, pageSize }, path, connId);
}

/** Cache por (repo, hash): commits são imutáveis. */
const detailsCache = new Map<string, Promise<CommitDetails>>();
const DETAILS_CACHE_MAX = 400;

export function gitCommitDetails(path: string, commit: string, connId?: string): Promise<CommitDetails> {
  const key = `${connId ?? ""}\u0000${path}\u0000${commit}`;
  const hit = detailsCache.get(key);
  if (hit) return hit;
  const promise = route<CommitDetails>("git_commit_details", "ssh_git_commit_details", { commit }, path, connId);
  detailsCache.set(key, promise);
  promise.catch(() => detailsCache.delete(key));
  if (detailsCache.size > DETAILS_CACHE_MAX) {
    const first = detailsCache.keys().next().value;
    if (first !== undefined) detailsCache.delete(first);
  }
  return promise;
}

/** Detalhes já resolvidos (sem disparar IPC) — para o hover abrir pronto. */
export function peekCommitDetails(path: string, commit: string, connId?: string): Promise<CommitDetails> | undefined {
  return detailsCache.get(`${connId ?? ""}\u0000${path}\u0000${commit}`);
}

export function gitBranchLineage(
  path: string,
  reference: string,
  base: string | null,
  connId?: string
): Promise<BranchLineage> {
  return route("git_branch_lineage", "ssh_git_branch_lineage", { reference, base }, path, connId);
}

/** Arquivos entre `from` e `to` (`null` = árvore de trabalho). */
export function gitDiffFiles(path: string, from: string, to: string | null, connId?: string): Promise<GitCommitFile[]> {
  return route("git_diff_files", "ssh_git_diff_files", { from, to }, path, connId);
}

export function gitCherryPick(path: string, commit: string, connId?: string): Promise<string> {
  return route("git_cherry_pick", "ssh_git_cherry_pick", { commit }, path, connId);
}

export function gitCreateBranchAt(
  path: string,
  name: string,
  start: string,
  checkout: boolean,
  connId?: string
): Promise<void> {
  return route("git_create_branch_at", "ssh_git_create_branch_at", { name, start, checkout }, path, connId);
}
