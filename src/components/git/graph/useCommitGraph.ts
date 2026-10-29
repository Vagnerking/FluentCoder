import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitGraphPage, type GraphCursor, type GraphHeader, type GraphQuery, type GraphRow } from "../../../git/graphApi";
import { GraphLaneLayout, type GraphRowLayout } from "../../../git/graphLayout";
import { buildRefIndex, type RefIndex } from "../../../git/graphModel";

export const GRAPH_PAGE_SIZE = 200;

export interface CommitGraphData {
  header: GraphHeader | null;
  rows: GraphRow[];
  layout: GraphRowLayout[];
  maxWidth: number;
  refIndex: RefIndex;
  /** hash → índice da linha. */
  indexOf: Map<string, number>;
  hasMore: boolean;
  loading: boolean;
  /** Recarregando por cima do conteúdo atual (sem piscar). */
  refreshing: boolean;
  error: string | null;
  /** Tempo do backend na última página (ms). */
  elapsedMs: number | null;
}

const EMPTY_INDEX = buildRefIndex(null);

const EMPTY: CommitGraphData = {
  header: null,
  rows: [],
  layout: [],
  maxWidth: 1,
  refIndex: EMPTY_INDEX,
  indexOf: new Map(),
  hasMore: false,
  loading: false,
  refreshing: false,
  error: null,
  elapsedMs: null,
};

/**
 * Dados do grafo paginado: 1ª página (com cabeçalho) ao habilitar/mudar a
 * consulta, páginas seguintes sob demanda (`loadMore`), e `reload` suave
 * (mantém as linhas até a nova 1ª página chegar). Respostas atrasadas de
 * uma consulta antiga são descartadas.
 */
export function useCommitGraph(
  rootPath: string | null,
  connId: string | undefined,
  query: GraphQuery,
  enabled: boolean,
  reloadKey: number
): CommitGraphData & { loadMore: () => void; reload: () => void } {
  const [data, setData] = useState<CommitGraphData>(EMPTY);
  const token = useRef(0);
  const cursor = useRef<GraphCursor | null>(null);
  const layout = useRef<GraphLaneLayout | null>(null);
  const inflight = useRef(false);
  const queryKey = JSON.stringify(query);
  const stableQuery = useMemo(() => query, [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstParent = Boolean(query.firstParent);

  const normalize = useCallback(
    (rows: GraphRow[]) => (firstParent ? rows.map((r) => (r.parents.length > 1 ? { ...r, parents: r.parents.slice(0, 1) } : r)) : rows),
    [firstParent]
  );

  const load = useCallback(
    (soft: boolean) => {
      if (!rootPath) return;
      const my = ++token.current;
      inflight.current = true;
      setData((prev) => (soft && prev.rows.length ? { ...prev, refreshing: true } : { ...EMPTY, loading: true }));
      gitGraphPage(rootPath, stableQuery, null, GRAPH_PAGE_SIZE, connId)
        .then((page) => {
          if (my !== token.current) return;
          inflight.current = false;
          const refIndex = buildRefIndex(page.header);
          const lanes = new GraphLaneLayout({ colorKeyOf: (h) => refIndex.colorKey.get(h) });
          const rows = normalize(page.commits);
          const laid = lanes.append(rows);
          layout.current = lanes;
          cursor.current = page.cursor;
          const indexOf = new Map<string, number>();
          rows.forEach((r, i) => indexOf.set(r.hash, i));
          setData({
            header: page.header,
            rows,
            layout: laid,
            maxWidth: Math.max(1, lanes.maxWidth),
            refIndex,
            indexOf,
            hasMore: Boolean(page.cursor),
            loading: false,
            refreshing: false,
            error: null,
            elapsedMs: page.elapsedMs,
          });
        })
        .catch((err) => {
          if (my !== token.current) return;
          inflight.current = false;
          setData((prev) => ({ ...prev, loading: false, refreshing: false, error: String(err) }));
        });
    },
    [connId, normalize, rootPath, stableQuery]
  );

  useEffect(() => {
    if (!enabled || !rootPath) return;
    load(false);
  }, [enabled, load, rootPath]);

  // Refs mudaram (commit, checkout, fetch…): recarrega sem piscar.
  const lastReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (lastReloadKey.current === reloadKey) return;
    lastReloadKey.current = reloadKey;
    if (enabled) load(true);
  }, [enabled, load, reloadKey]);

  const loadMore = useCallback(() => {
    const next = cursor.current;
    if (!rootPath || !next || inflight.current || !layout.current) return;
    const my = token.current;
    inflight.current = true;
    setData((prev) => ({ ...prev, loading: true }));
    gitGraphPage(rootPath, stableQuery, next, GRAPH_PAGE_SIZE, connId)
      .then((page) => {
        if (my !== token.current || !layout.current) return;
        inflight.current = false;
        cursor.current = page.cursor;
        const rows = normalize(page.commits);
        const laid = layout.current.append(rows);
        const maxWidth = Math.max(1, layout.current.maxWidth);
        setData((prev) => {
          const indexOf = new Map(prev.indexOf);
          rows.forEach((r, i) => indexOf.set(r.hash, prev.rows.length + i));
          return {
            ...prev,
            rows: prev.rows.concat(rows),
            layout: prev.layout.concat(laid),
            maxWidth,
            indexOf,
            hasMore: Boolean(page.cursor),
            loading: false,
            elapsedMs: page.elapsedMs,
          };
        });
      })
      .catch((err) => {
        if (my !== token.current) return;
        inflight.current = false;
        setData((prev) => ({ ...prev, loading: false, error: String(err) }));
      });
  }, [connId, normalize, rootPath, stableQuery]);

  const reload = useCallback(() => load(true), [load]);

  return { ...data, loadMore, reload };
}
