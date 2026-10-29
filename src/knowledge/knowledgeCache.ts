/**
 * Shared, in-memory cache of the workspace KNOWLEDGE INDEX (richer than the
 * graph: links carry line + snippet, plus tags + headings). One backend scan per
 * workspace, reused by the backlinks panel and — later — the MCP tools + RAG.
 */
import { buildKnowledgeIndex } from "../api";
import type { KnowledgeIndex } from "../types";

let cache: { key: string; index: KnowledgeIndex } | null = null;
let inflight: { key: string; promise: Promise<KnowledgeIndex> } | null = null;

function cacheKey(root: string, connId?: string | null): string {
  return `${connId ?? "local"}:${root}`;
}

export function getCachedIndex(root: string, connId?: string | null): KnowledgeIndex | null {
  const key = cacheKey(root, connId);
  return cache && cache.key === key ? cache.index : null;
}

export function loadIndex(
  root: string,
  connId?: string | null,
  force = false
): Promise<KnowledgeIndex> {
  const key = cacheKey(root, connId);
  if (!force && cache && cache.key === key) return Promise.resolve(cache.index);
  if (!force && inflight && inflight.key === key) return inflight.promise;
  const promise = buildKnowledgeIndex(root, connId ?? undefined)
    .then((index) => {
      cache = { key, index };
      return index;
    })
    .finally(() => {
      if (inflight?.key === key) inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

export function invalidateIndex(): void {
  cache = null;
  inflight = null;
}

/** One linked mention — a connection with its line + context snippet. */
export interface Mention {
  /** The OTHER file (the backlink source, or the outgoing target). */
  path: string;
  name: string;
  kind: "markdown" | "code";
  relation: "link" | "wikilink" | "import";
  /** Line in the SOURCE file where the link sits, and that line's text. */
  line: number;
  snippet: string;
}

export interface Mentions {
  backlinks: Mention[];
  outgoing: Mention[];
}

/** Derives a file's backlinks (who links here, with the source line/snippet) and
 *  outgoing links (where it points, with its own line/snippet) from the index. */
export function mentionsFor(index: KnowledgeIndex, path: string): Mentions {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const backlinks: Mention[] = [];
  for (const f of index.files) {
    if (f.path === path) continue;
    for (const l of f.outgoing) {
      if (l.target === path) {
        backlinks.push({
          path: f.path,
          name: f.name,
          kind: f.kind,
          relation: l.relation,
          line: l.line,
          snippet: l.snippet,
        });
      }
    }
  }
  const self = byPath.get(path);
  const outgoing: Mention[] = (self?.outgoing ?? []).map((l) => {
    const t = byPath.get(l.target);
    return {
      path: l.target,
      name: t?.name ?? l.target.split(/[\\/]/).pop() ?? l.target,
      kind: t?.kind ?? "code",
      relation: l.relation,
      line: l.line,
      snippet: l.snippet,
    };
  });
  const byName = (a: Mention, b: Mention) => a.name.localeCompare(b.name);
  backlinks.sort(byName);
  outgoing.sort(byName);
  return { backlinks, outgoing };
}
