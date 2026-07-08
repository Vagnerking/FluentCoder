export type GraphLayoutMode = "colony" | "organic";
export type GraphLayoutRelationKind = "link" | "wikilink" | "import";

export interface GraphLayoutRelation {
  target: string;
  kind: GraphLayoutRelationKind;
}

export interface GraphLayoutNode {
  id: string;
  rel: string;
  degree: number;
  refs?: number;
  links?: readonly string[];
  relations?: readonly GraphLayoutRelation[];
}

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphIslandInfo {
  key: string;
  label: string;
}

export interface GraphCellInfo {
  key: string;
  hubId: string;
  relationKind: GraphLayoutRelationKind;
  center: GraphPoint;
  radius: number;
}

export interface GraphLayoutSnapshot {
  positions: Map<string, GraphPoint>;
  islandInfo: Map<string, GraphIslandInfo>;
  cellInfo: Map<string, GraphCellInfo>;
}

interface Colony {
  name: string;
  nodes: GraphLayoutNode[];
  islands: GraphLayoutNode[][];
  islandCenters: GraphPoint[];
  radius: number;
  center: GraphPoint;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const LAYOUT = {
  nodeSpacing: 46,
  minIslandRadius: 18,
  islandBaseRadius: 26,
  islandGap: 88,
  singletonIslandSpacing: 136,
  minColonyRadius: 104,
  colonyPadding: 64,
  colonyGap: 54,
  colonyCandidateStep: 92,
  minColonyCandidates: 400,
  colonyCandidateBudget: 90,
  mixedIslandCandidateStep: 42,
  minMixedIslandCandidates: 120,
  mixedIslandCandidateBudget: 40,
  maxMixedIslandCandidateBudget: 260,
  organicRadiusStep: 38,
  organicCellNodeSpacing: 30,
  organicCellGap: 48,
  organicCellCandidateStep: 46,
  organicHubMinChildren: 3,
  organicSatelliteMinChildren: 2,
  organicSatelliteGap: 58,
} as const;

export function graphFolder(rel: string): string {
  const normalized = rel.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  return slash < 0 ? "Raiz" : normalized.slice(0, slash);
}

function pathSegments(rel: string): string[] {
  return rel.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function graphIslandLabel(nodes: readonly GraphLayoutNode[]): string {
  if (nodes.length === 0) return "Grupo";

  const segments = nodes.map((node) => pathSegments(node.rel));
  if (nodes.length === 1) {
    const single = segments[0];
    if (single.length <= 1) return single[0] ?? "Raiz";
    return single[1] ?? single[0] ?? "Grupo";
  }

  const folder = graphFolder(nodes[0].rel);
  const start = folder === "Raiz" ? 0 : 1;
  let commonEnd = start;
  while (segments.every((parts) => parts[commonEnd] && parts[commonEnd] === segments[0][commonEnd])) {
    commonEnd++;
  }

  if (commonEnd > start) return segments[0][commonEnd - 1];
  if (folder !== "Raiz") return `${nodes.length} arquivos`;
  return "Raiz";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexCandidates(limit: number, step: number): GraphPoint[] {
  const result: GraphPoint[] = [{ x: 0, y: 0 }];
  for (let ring = 1; result.length < limit; ring++) {
    for (let q = -ring; q <= ring; q++) {
      const minR = Math.max(-ring, -q - ring);
      const maxR = Math.min(ring, -q + ring);
      for (let r = minR; r <= maxR; r++) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) !== ring) continue;
        result.push({
          x: step * Math.sqrt(3) * (q + r / 2),
          y: step * 1.5 * r,
        });
        if (result.length >= limit) return result;
      }
    }
  }
  return result;
}

function islandScore(nodes: readonly GraphLayoutNode[]): number {
  return nodes.reduce((total, node) => total + node.degree, 0);
}

function islandRadius(size: number): number {
  if (size <= 1) return LAYOUT.minIslandRadius;
  return LAYOUT.islandBaseRadius + Math.sqrt(size) * LAYOUT.nodeSpacing;
}

function colonyRadius(islands: readonly GraphLayoutNode[][], islandCenters: readonly GraphPoint[]): number {
  const occupiedRadius = islands.reduce((largest, island, index) => {
    const center = islandCenters[index] ?? { x: 0, y: 0 };
    return Math.max(largest, Math.hypot(center.x, center.y) + islandRadius(island.length));
  }, 0);
  return Math.max(LAYOUT.minColonyRadius, occupiedRadius + LAYOUT.colonyPadding);
}

function groupNodes(
  nodes: readonly GraphLayoutNode[],
  keyForNode: (node: GraphLayoutNode) => string
): Map<string, GraphLayoutNode[]> {
  const groups = new Map<string, GraphLayoutNode[]>();
  for (const node of nodes) {
    const key = keyForNode(node);
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  return groups;
}

function islandScope(node: GraphLayoutNode): string {
  const parts = pathSegments(node.rel);
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  return node.id;
}

function partitionIslands(nodes: readonly GraphLayoutNode[]): GraphLayoutNode[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byScope = groupNodes(nodes, islandScope);
  const seen = new Set<string>();
  const islands: GraphLayoutNode[][] = [];

  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const island: GraphLayoutNode[] = [];
    const stack = [node];
    seen.add(node.id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      island.push(current);
      for (const linkedId of current.links ?? []) {
        const linked = byId.get(linkedId);
        if (!linked || seen.has(linked.id)) continue;
        seen.add(linked.id);
        stack.push(linked);
      }
      for (const scoped of byScope.get(islandScope(current)) ?? []) {
        if (seen.has(scoped.id)) continue;
        seen.add(scoped.id);
        stack.push(scoped);
      }
    }
    islands.push(island.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)));
  }

  return islands.sort(
    (a, b) => b.length - a.length || islandScore(b) - islandScore(a) || a[0].id.localeCompare(b[0].id)
  );
}

function centeredPoints(points: readonly GraphPoint[]): GraphPoint[] {
  if (points.length === 0) return [];
  const centroid = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 }
  );
  centroid.x /= points.length;
  centroid.y /= points.length;
  return points.map((point) => ({ x: point.x - centroid.x, y: point.y - centroid.y }));
}

function islandInfoFromGroups(groups: Map<string, GraphLayoutNode[]>): Map<string, GraphIslandInfo> {
  const result = new Map<string, GraphIslandInfo>();
  for (const [folder, group] of Array.from(groups).sort(([a], [b]) => a.localeCompare(b))) {
    const islands = partitionIslands(group);
    islands.forEach((island, index) => {
      const info = { key: `${folder}:${index}`, label: graphIslandLabel(island) };
      for (const node of island) result.set(node.id, info);
    });
  }
  return result;
}

function islandInfoFromColonies(colonies: readonly Colony[]): Map<string, GraphIslandInfo> {
  const result = new Map<string, GraphIslandInfo>();
  for (const colony of colonies) {
    colony.islands.forEach((island, index) => {
      const info = { key: `${colony.name}:${index}`, label: graphIslandLabel(island) };
      for (const node of island) result.set(node.id, info);
    });
  }
  return result;
}

export function createGraphIslandInfo(nodes: readonly GraphLayoutNode[]): Map<string, GraphIslandInfo> {
  return islandInfoFromGroups(groupNodes(nodes, (node) => graphFolder(node.rel)));
}

export function createGraphIslandKeys(nodes: readonly GraphLayoutNode[]): Map<string, string> {
  return new Map(Array.from(createGraphIslandInfo(nodes), ([id, info]) => [id, info.key]));
}

function placeColonies(groups: Map<string, GraphLayoutNode[]>): Colony[] {
  const colonies: Colony[] = Array.from(groups, ([name, nodes]) => {
    const islands = partitionIslands(nodes);
    const islandCenters = arrangeIslandCenters(islands);
    return {
      name,
      nodes: [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)),
      islands,
      islandCenters,
      radius: colonyRadius(islands, islandCenters),
      center: { x: 0, y: 0 },
    };
  }).sort((a, b) => b.nodes.length - a.nodes.length || a.name.localeCompare(b.name));

  // Candidate centres sit on a hex lattice. Variable colony radii reject cells
  // that would overlap, producing a compact honeycomb even with uneven folders.
  const candidates = hexCandidates(
    Math.max(LAYOUT.minColonyCandidates, colonies.length * LAYOUT.colonyCandidateBudget),
    LAYOUT.colonyCandidateStep
  );
  const placed: Colony[] = [];
  for (const colony of colonies) {
    const candidate = candidates.find((point) =>
      placed.every((other) => {
        const dx = point.x - other.center.x;
        const dy = point.y - other.center.y;
        const gap = colony.radius + other.radius + LAYOUT.colonyGap;
        return dx * dx + dy * dy >= gap * gap;
      })
    );
    const fallbackX =
      placed.reduce((right, other) => Math.max(right, other.center.x + other.radius), 0) +
      colony.radius +
      LAYOUT.colonyGap;
    colony.center = candidate ?? { x: fallbackX, y: 0 };
    placed.push(colony);
  }
  return placed;
}

function arrangeIslandCenters(islands: readonly GraphLayoutNode[][]): GraphPoint[] {
  if (islands.length === 1) return [{ x: 0, y: 0 }];

  const allAreSingletons = islands.every((island) => island.length === 1);
  if (allAreSingletons) {
    // Common mono-repo case: many unrelated files/projects under the same
    // top-level folder. Use direct hex-ring assignment instead of pairwise
    // placement so very large graphs stay predictable and fast. Re-centering
    // avoids the ugly "wall stuck to one side" effect for small groups such as
    // three unrelated projects in the same folder.
    return centeredPoints(hexCandidates(islands.length, LAYOUT.singletonIslandSpacing));
  }

  const sortByDistance = (a: GraphPoint, b: GraphPoint) => {
    const da = a.x * a.x + a.y * a.y;
    const db = b.x * b.x + b.y * b.y;
    return da - db || a.x - b.x || a.y - b.y;
  };
  let candidateLimit = Math.max(
    LAYOUT.minMixedIslandCandidates,
    islands.length * LAYOUT.mixedIslandCandidateBudget
  );
  const maxCandidateLimit = Math.max(
    candidateLimit,
    islands.length * LAYOUT.maxMixedIslandCandidateBudget
  );
  let sortedCandidates = hexCandidates(candidateLimit, LAYOUT.mixedIslandCandidateStep).sort(sortByDistance);
  const centers: GraphPoint[] = [];

  for (let index = 0; index < islands.length; index++) {
    const island = islands[index];
    const requiredRadius = islandRadius(island.length);
    let chosen: GraphPoint | undefined;
    while (!chosen) {
      chosen = sortedCandidates.find((point) =>
        centers.every((other, otherIndex) => {
          const otherRadius = islandRadius(islands[otherIndex].length);
          const dx = point.x - other.x;
          const dy = point.y - other.y;
          const gap = requiredRadius + otherRadius + LAYOUT.islandGap;
          return dx * dx + dy * dy >= gap * gap;
        })
      );
      if (chosen || candidateLimit >= maxCandidateLimit) break;
      candidateLimit = Math.min(maxCandidateLimit, Math.ceil(candidateLimit * 1.6));
      sortedCandidates = hexCandidates(candidateLimit, LAYOUT.mixedIslandCandidateStep).sort(sortByDistance);
    }
    if (!chosen) {
      // Last-resort placement still respects the already placed radii. This is
      // deliberately rare, but avoids a visually broken linear fallback if a
      // future workspace shape exceeds the candidate budget.
      let ring = 1;
      while (!chosen) {
        const radius = (requiredRadius + LAYOUT.islandGap) * ring;
        const slots = Math.max(6, ring * 6);
        for (let slot = 0; slot < slots; slot++) {
          const angle = slot * GOLDEN_ANGLE;
          const point = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
          if (
            centers.every((other, otherIndex) => {
              const otherRadius = islandRadius(islands[otherIndex].length);
              const dx = point.x - other.x;
              const dy = point.y - other.y;
              const gap = requiredRadius + otherRadius + LAYOUT.islandGap;
              return dx * dx + dy * dy >= gap * gap;
            })
          ) {
            chosen = point;
            break;
          }
        }
        ring++;
      }
    }
    centers.push(chosen);
  }

  return centeredPoints(centers);
}

function placeIslandNodes(
  result: Map<string, GraphPoint>,
  island: readonly GraphLayoutNode[],
  center: GraphPoint,
  rotation: number
) {
  const offsets = hexCandidates(island.length, LAYOUT.nodeSpacing);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  island.forEach((node, index) => {
    const offset = offsets[index] ?? { x: 0, y: 0 };
    result.set(node.id, {
      x: center.x + offset.x * cos - offset.y * sin,
      y: center.y + offset.x * sin + offset.y * cos,
    });
  });
}

interface OrganicCell {
  hub: GraphLayoutNode;
  nodes: GraphLayoutNode[];
  relationKind: GraphLayoutRelationKind;
  radius: number;
  layoutRadius: number;
  center: GraphPoint;
  parentHubId?: string;
  satelliteIndex?: number;
  satelliteTotal?: number;
}

function nodeLinksById(nodes: readonly GraphLayoutNode[]): Map<string, Set<string>> {
  const known = new Set(nodes.map((node) => node.id));
  const links = new Map<string, Set<string>>();
  for (const node of nodes) links.set(node.id, new Set());
  for (const node of nodes) {
    const nodeLinks = links.get(node.id)!;
    for (const relation of node.relations ?? []) {
      if (!known.has(relation.target)) continue;
      nodeLinks.add(relation.target);
      links.get(relation.target)?.add(node.id);
    }
    for (const linkedId of node.links ?? []) {
      if (!known.has(linkedId)) continue;
      nodeLinks.add(linkedId);
      links.get(linkedId)?.add(node.id);
    }
  }
  return links;
}

function relationRank(kind: GraphLayoutRelationKind): number {
  return kind === "wikilink" ? 0 : kind === "link" ? 1 : 2;
}

function relationSatelliteGap(kind: GraphLayoutRelationKind): number {
  return LAYOUT.organicSatelliteGap * (kind === "wikilink" ? 0.85 : kind === "link" ? 1 : 1.25);
}

function bestRelationKind(
  first: GraphLayoutNode,
  second: GraphLayoutNode
): GraphLayoutRelationKind {
  let best: GraphLayoutRelationKind | null = null;
  const consider = (kind: GraphLayoutRelationKind) => {
    if (!best || relationRank(kind) < relationRank(best)) best = kind;
  };
  for (const relation of first.relations ?? []) {
    if (relation.target === second.id) consider(relation.kind);
  }
  for (const relation of second.relations ?? []) {
    if (relation.target === first.id) consider(relation.kind);
  }
  return best ?? "link";
}

function organicCellRadius(size: number): number {
  if (size <= 1) return 12;
  return 24 + Math.sqrt(size) * LAYOUT.organicCellNodeSpacing;
}

function buildOrganicCells(nodes: readonly GraphLayoutNode[]): OrganicCell[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = nodeLinksById(nodes);
  const assigned = new Set<string>();
  const cells: OrganicCell[] = [];
  const hubs = [...nodes].sort((a, b) => {
    const aLinks = links.get(a.id)?.size ?? 0;
    const bLinks = links.get(b.id)?.size ?? 0;
    return (
      (b.refs ?? 0) - (a.refs ?? 0) ||
      bLinks - aLinks ||
      b.degree - a.degree ||
      a.id.localeCompare(b.id)
    );
  });
  const candidateHubIds = new Set(
    hubs
      .filter((node) => {
        const linkedCount = links.get(node.id)?.size ?? 0;
        return linkedCount >= LAYOUT.organicHubMinChildren || (node.refs ?? 0) >= LAYOUT.organicHubMinChildren;
      })
      .map((node) => node.id)
  );

  for (const hub of hubs) {
    if (assigned.has(hub.id)) continue;
    const neighboursByKind = new Map<GraphLayoutRelationKind, GraphLayoutNode[]>();
    for (const neighbour of [...(links.get(hub.id) ?? [])]
      .map((id) => byId.get(id))
      .filter((node): node is GraphLayoutNode => node !== undefined)
      .filter((node) => !assigned.has(node.id))
      .filter((node) => !candidateHubIds.has(node.id))
      .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))) {
      const kind = bestRelationKind(hub, neighbour);
      const group = neighboursByKind.get(kind);
      if (group) group.push(neighbour);
      else neighboursByKind.set(kind, [neighbour]);
    }
    const rankedNeighbourGroups = Array.from(neighboursByKind, ([kind, neighbours]) => ({ kind, neighbours }))
      .sort(
        (a, b) =>
          b.neighbours.length - a.neighbours.length ||
          relationRank(a.kind) - relationRank(b.kind) ||
          b.neighbours.reduce((sum, node) => sum + node.degree, 0) -
            a.neighbours.reduce((sum, node) => sum + node.degree, 0)
      );
    const selected = rankedNeighbourGroups[0];
    const neighbours = selected?.neighbours ?? [];
    if (neighbours.length < LAYOUT.organicHubMinChildren) continue;

    const cellNodes = [hub, ...neighbours];
    for (const node of cellNodes) assigned.add(node.id);
    const secondaryGroups = rankedNeighbourGroups
      .slice(1)
      .map((group) => ({
        kind: group.kind,
        neighbours: group.neighbours.filter((node) => !assigned.has(node.id)),
      }))
      .filter((group) => group.neighbours.length >= LAYOUT.organicSatelliteMinChildren);
    const primaryRadius = organicCellRadius(cellNodes.length);
    const satelliteCells = secondaryGroups.map((group, index) => {
      for (const node of group.neighbours) assigned.add(node.id);
      return {
        hub,
        nodes: group.neighbours,
        relationKind: group.kind,
        radius: organicCellRadius(group.neighbours.length),
        layoutRadius: organicCellRadius(group.neighbours.length),
        center: { x: 0, y: 0 },
        parentHubId: hub.id,
        satelliteIndex: index,
        satelliteTotal: secondaryGroups.length,
      } satisfies OrganicCell;
    });
    const layoutRadius = satelliteCells.reduce((largest, satellite) => {
      const gap = relationSatelliteGap(satellite.relationKind);
      return Math.max(largest, primaryRadius + gap + satellite.radius * 2);
    }, primaryRadius);
    cells.push({
      hub,
      nodes: cellNodes,
      relationKind: selected?.kind ?? "link",
      radius: primaryRadius,
      layoutRadius,
      center: { x: 0, y: 0 },
    });
    cells.push(...satelliteCells);
  }

  for (const node of hubs) {
    if (assigned.has(node.id)) continue;
    assigned.add(node.id);
    cells.push({
      hub: node,
      nodes: [node],
      relationKind: "link",
      radius: organicCellRadius(1),
      layoutRadius: organicCellRadius(1),
      center: { x: 0, y: 0 },
    });
  }

  return cells.sort(
    (a, b) =>
      (b.hub.refs ?? 0) - (a.hub.refs ?? 0) ||
      b.nodes.length - a.nodes.length ||
      b.hub.degree - a.hub.degree ||
      a.hub.id.localeCompare(b.hub.id)
  );
}

function placeOrganicCells(cells: OrganicCell[]) {
  const rootCells = cells.filter((cell) => !cell.parentHubId);
  const candidates = hexCandidates(
    Math.max(600, rootCells.length * 96),
    LAYOUT.organicCellCandidateStep
  ).sort((a, b) => {
    const da = a.x * a.x + a.y * a.y;
    const db = b.x * b.x + b.y * b.y;
    return da - db || a.x - b.x || a.y - b.y;
  });
  const placed: OrganicCell[] = [];
  for (const cell of rootCells) {
    const candidate = candidates.find((point) =>
      placed.every((other) => {
        const gap = cell.layoutRadius + other.layoutRadius + LAYOUT.organicCellGap;
        const dx = point.x - other.center.x;
        const dy = point.y - other.center.y;
        return dx * dx + dy * dy >= gap * gap;
      })
    );
    if (candidate) {
      cell.center = candidate;
    } else {
      const index = placed.length;
      const radius = LAYOUT.organicRadiusStep * Math.sqrt(index + 1) + cell.layoutRadius;
      const angle = index * GOLDEN_ANGLE;
      cell.center = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    }
    placed.push(cell);
  }
  const centered = centeredPoints(rootCells.map((cell) => cell.center));
  rootCells.forEach((cell, index) => {
    cell.center = centered[index];
  });
  const byParent = new Map<string, OrganicCell>();
  for (const cell of rootCells) byParent.set(cell.hub.id, cell);
  for (const satellite of cells.filter((cell) => cell.parentHubId)) {
    const parent = byParent.get(satellite.parentHubId!);
    if (!parent) continue;
    const total = satellite.satelliteTotal ?? 1;
    const index = satellite.satelliteIndex ?? 0;
    const rotation = ((stableHash(`${parent.hub.id}:${satellite.relationKind}`) % 360) * Math.PI) / 180;
    const angle = rotation + (index / total) * Math.PI * 2;
    const ring = Math.max(
      parent.radius + satellite.radius + relationSatelliteGap(satellite.relationKind),
      ((satellite.radius + LAYOUT.organicCellGap) * Math.max(3, total)) / Math.PI
    );
    satellite.center = {
      x: parent.center.x + Math.cos(angle) * ring,
      y: parent.center.y + Math.sin(angle) * ring,
    };
  }
}

function layoutOrganicSphere(nodes: readonly GraphLayoutNode[]): {
  positions: Map<string, GraphPoint>;
  cellInfo: Map<string, GraphCellInfo>;
} {
  const result = new Map<string, GraphPoint>();
  const cellInfo = new Map<string, GraphCellInfo>();
  const cells = buildOrganicCells(nodes);
  placeOrganicCells(cells);

  for (const cell of cells) {
    const cellKey = cell.parentHubId
      ? `organic:${cell.parentHubId}:${cell.relationKind}`
      : `organic:${cell.hub.id}`;
    const info: GraphCellInfo = {
      key: cellKey,
      hubId: cell.hub.id,
      relationKind: cell.relationKind,
      center: { ...cell.center },
      radius: cell.radius,
    };
    const rotation = ((stableHash(cell.hub.id) % 360) * Math.PI) / 180;
    const offsets = hexCandidates(cell.nodes.length, LAYOUT.organicCellNodeSpacing);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    for (let index = 0; index < cell.nodes.length; index++) {
      const node = cell.nodes[index];
      const offset = index === 0 ? { x: 0, y: 0 } : offsets[index] ?? { x: 0, y: 0 };
      result.set(node.id, {
        x: cell.center.x + offset.x * cos - offset.y * sin,
        y: cell.center.y + offset.x * sin + offset.y * cos,
      });
      cellInfo.set(node.id, info);
    }
  }

  return { positions: result, cellInfo };
}

function layoutFromColonies(colonies: readonly Colony[], mode: GraphLayoutMode): Map<string, GraphPoint> {
  const result = new Map<string, GraphPoint>();
  for (const colony of colonies) {
    const rotation = ((stableHash(colony.name) % 360) * Math.PI) / 180;
    const islandCenters =
      mode === "colony"
        ? colony.islandCenters
        : colony.nodes.map((_, index) => {
            const radius = LAYOUT.organicRadiusStep * Math.sqrt(index);
            const angle = rotation + index * GOLDEN_ANGLE;
            return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
          });

    if (mode === "organic") {
      colony.nodes.forEach((node, index) => {
        const point = islandCenters[index];
        result.set(node.id, { x: colony.center.x + point.x, y: colony.center.y + point.y });
      });
      continue;
    }

    colony.islands.forEach((island, islandIndex) => {
      const islandCenter = islandCenters[islandIndex];
      placeIslandNodes(
        result,
        island,
        {
          x: colony.center.x + islandCenter.x,
          y: colony.center.y + islandCenter.y,
        },
        rotation + islandIndex * GOLDEN_ANGLE
      );
    });
  }
  return result;
}

/**
 * Produces deterministic seed positions, avoiding the expensive chaotic phase
 * of a force layout. Colony mode packs top-level folders on a hex lattice;
 * inside each folder, disconnected islands get their own breathing room so
 * unrelated projects do not visually collapse into a single clump.
 */
export function createGraphLayout(
  nodes: readonly GraphLayoutNode[],
  mode: GraphLayoutMode
): Map<string, GraphPoint> {
  return createGraphLayoutSnapshot(nodes, mode).positions;
}

export function createGraphLayoutSnapshot(
  nodes: readonly GraphLayoutNode[],
  mode: GraphLayoutMode
): GraphLayoutSnapshot {
  if (mode === "colony") {
    const colonies = placeColonies(groupNodes(nodes, (node) => graphFolder(node.rel)));
    return {
      positions: layoutFromColonies(colonies, mode),
      islandInfo: islandInfoFromColonies(colonies),
      cellInfo: new Map(),
    };
  }

  const organic = layoutOrganicSphere(nodes);
  return {
    positions: organic.positions,
    islandInfo: createGraphIslandInfo(nodes),
    cellInfo: organic.cellInfo,
  };
}
