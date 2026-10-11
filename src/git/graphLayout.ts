/**
 * Layout de lanes do grafo de commits (puro, incremental, testado em
 * `graphLayout.test.ts`).
 *
 * - **Lanes estáveis**: cada lane espera um hash; ao terminar, o slot vira
 *   buraco e é reaproveitado por uma lane nova — as outras nunca deslocam
 *   (nada de diagonais em cascata a cada branch que acaba). O estado continua
 *   entre páginas (`append`), então a página 2 encaixa na 1.
 * - **Cor por branch**: hash estável do nome (`origin/feat/x` e `feat/x`
 *   dividem a cor). Lane de 2º pai herda o nome do assunto do merge
 *   ("Merge pull request #N from dono/feat/x", "Merge branch 'x'"), então a
 *   cor sobrevive à branch apagada. Lane anônima: cor pelo hash do commit.
 * - Cada primitivo guarda o hash que a lane espera (`target`), o que permite
 *   destacar o caminho de uma branch (linhagem) sem recalcular o layout.
 * - Lanes demais: `projectLane` dobra as lanes ≥ `maxLanes` numa coluna de
 *   transbordo ("+N").
 */

export const GRAPH_PALETTE_SIZE = 10;

export interface LayoutCommit {
  hash: string;
  parents: string[];
  subject?: string;
}

/** Segmento que atravessa a linha inteira (lane sem commit aqui). */
export interface LanePass {
  lane: number;
  color: number;
  /** Hash que a lane espera. */
  target: string;
}

/** Aresta do topo da linha até o nó (filho acima → este commit). */
export interface LaneTop {
  lane: number;
  color: number;
}

/** Aresta do nó até a base da linha (este commit → pai). */
export interface LaneBottom {
  lane: number;
  color: number;
  /** Pai que a lane passa a esperar. */
  target: string;
  /** Aresta de 2º+ pai (merge). */
  merge: boolean;
}

export interface GraphRowLayout {
  hash: string;
  lane: number;
  color: number;
  pass: LanePass[];
  top: LaneTop[];
  bottom: LaneBottom[];
  /** Lanes ocupadas na linha (maior índice + 1). */
  width: number;
  isMerge: boolean;
  /** Ponta de lane (nenhum filho carregado acima). */
  isTip: boolean;
}

interface Slot {
  target: string;
  color: number;
}

/** FNV-1a 32 bits (estável entre sessões/plataformas). */
export function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cor (índice da paleta) de uma branch pelo nome. */
export function branchColor(name: string): number {
  return stableHash(name.trim().toLowerCase()) % GRAPH_PALETTE_SIZE;
}

/**
 * Chave de cor de uma ref: remota sem o nome do remoto (`origin/feat/x` →
 * `feat/x`), local como está. `remotes` = nomes de remotos conhecidos.
 */
export function branchColorKey(short: string, kind: "branch" | "remote" | "tag", remotes: readonly string[] = ["origin", "upstream"]): string {
  if (kind !== "remote") return short;
  const slash = short.indexOf("/");
  if (slash > 0 && (remotes.includes(short.slice(0, slash)) || remotes.length === 0)) return short.slice(slash + 1);
  return slash > 0 ? short.slice(slash + 1) : short;
}

/** Nome da branch que um merge trouxe, a partir do assunto. */
export function mergedBranchFromSubject(subject: string | undefined): string | null {
  if (!subject) return null;
  let m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
  if (m) return m[1];
  m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (m) {
    const name = m[1];
    // "origin/feat/x" → "feat/x"
    return /^(origin|upstream)\//.test(name) ? name.slice(name.indexOf("/") + 1) : name;
  }
  m = /^Merge branch (\S+)/.exec(subject);
  return m ? m[1] : null;
}

export interface LayoutOptions {
  /** hash → chave de cor (nome da branch que aponta para o commit). */
  colorKeyOf?: (hash: string) => string | null | undefined;
}

/**
 * Layout incremental. `append(page)` devolve as linhas da página; o estado
 * das lanes continua para a próxima.
 */
export class GraphLaneLayout {
  private slots: (Slot | null)[] = [];
  private readonly colorKeyOf: (hash: string) => string | null | undefined;
  /** Cor reservada para um hash ainda não visto (2º pai de merge nomeado). */
  private readonly pendingColor = new Map<string, number>();
  readonly rows: GraphRowLayout[] = [];
  maxWidth = 0;

  constructor(options: LayoutOptions = {}) {
    this.colorKeyOf = options.colorKeyOf ?? (() => null);
  }

  private freeSlot(prefer = 0): number {
    for (let i = prefer; i < this.slots.length; i++) if (!this.slots[i]) return i;
    for (let i = 0; i < Math.min(prefer, this.slots.length); i++) if (!this.slots[i]) return i;
    return this.slots.length;
  }

  private anonymousColor(hash: string, avoid: number[]): number {
    let color = stableHash(hash) % GRAPH_PALETTE_SIZE;
    for (let k = 0; k < GRAPH_PALETTE_SIZE && avoid.includes(color); k++) color = (color + 1) % GRAPH_PALETTE_SIZE;
    return color;
  }

  private neighbourColors(lane: number): number[] {
    const out: number[] = [];
    const left = this.slots[lane - 1];
    const right = this.slots[lane + 1];
    if (left) out.push(left.color);
    if (right) out.push(right.color);
    return out;
  }

  append(commits: readonly LayoutCommit[]): GraphRowLayout[] {
    const out: GraphRowLayout[] = [];
    for (const commit of commits) {
      const row = this.place(commit);
      this.rows.push(row);
      out.push(row);
      if (row.width > this.maxWidth) this.maxWidth = row.width;
    }
    return out;
  }

  private place(commit: LayoutCommit): GraphRowLayout {
    const { hash } = commit;
    const slots = this.slots;
    const waiting: number[] = [];
    for (let i = 0; i < slots.length; i++) if (slots[i]?.target === hash) waiting.push(i);

    const pass: LanePass[] = [];
    const top: LaneTop[] = [];
    const bottom: LaneBottom[] = [];
    let lane: number;
    let color: number;
    const isTip = waiting.length === 0;
    const key = this.colorKeyOf(hash);

    if (isTip) {
      lane = this.freeSlot();
      const reserved = this.pendingColor.get(hash);
      color = key ? branchColor(key) : reserved ?? this.anonymousColor(hash, this.neighbourColors(lane));
    } else {
      lane = waiting[0];
      color = slots[lane]!.color;
    }
    this.pendingColor.delete(hash);

    // Topo: lanes que esperavam este commit convergem no nó; as demais passam.
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot) continue;
      if (slot.target === hash) top.push({ lane: i, color: slot.color });
      else pass.push({ lane: i, color: slot.color, target: slot.target });
    }
    for (const w of waiting) slots[w] = null;

    // Base: 1º pai continua na lane do nó; os outros reaproveitam a lane que
    // já espera o pai ou abrem uma nova (à direita do nó, se houver buraco).
    const [first, ...others] = commit.parents;
    if (first) {
      slots[lane] = { target: first, color };
      bottom.push({ lane, color, target: first, merge: false });
    } else {
      slots[lane] = null;
    }
    const mergedName = others.length ? mergedBranchFromSubject(commit.subject) : null;
    others.forEach((parent, index) => {
      const existing = slots.findIndex((s) => s?.target === parent);
      if (existing >= 0) {
        bottom.push({ lane: existing, color: slots[existing]!.color, target: parent, merge: true });
        return;
      }
      const at = this.freeSlot(lane + 1);
      const parentKey = this.colorKeyOf(parent);
      const parentColor = parentKey
        ? branchColor(parentKey)
        : index === 0 && mergedName
          ? branchColor(mergedName)
          : this.anonymousColor(parent, [color, ...this.neighbourColors(at)]);
      slots[at] = { target: parent, color: parentColor };
      if (!parentKey) this.pendingColor.set(parent, parentColor);
      bottom.push({ lane: at, color: parentColor, target: parent, merge: true });
    });

    while (slots.length && !slots[slots.length - 1]) slots.pop();

    let width = lane + 1;
    for (const p of pass) width = Math.max(width, p.lane + 1);
    for (const t of top) width = Math.max(width, t.lane + 1);
    for (const b of bottom) width = Math.max(width, b.lane + 1);

    return {
      hash,
      lane,
      color,
      pass,
      top,
      bottom,
      width,
      isMerge: commit.parents.length > 1,
      isTip,
    };
  }
}

/** Layout de uma lista inteira (testes / recomputação). */
export function layoutGraph(commits: readonly LayoutCommit[], options?: LayoutOptions): GraphRowLayout[] {
  const layout = new GraphLaneLayout(options);
  return layout.append(commits);
}

/**
 * Lane visível com transbordo: lanes ≥ `maxLanes` vão para a coluna
 * `maxLanes` (desenhada como "+N").
 */
export function projectLane(lane: number, maxLanes: number): number {
  return lane < maxLanes ? lane : maxLanes;
}

/** Quantas lanes da linha ficam escondidas no transbordo. */
export function hiddenLaneCount(row: GraphRowLayout, maxLanes: number): number {
  return Math.max(0, row.width - maxLanes);
}

/** Largura (em lanes) para desenhar: até `maxLanes` + 1 coluna de transbordo. */
export function visibleLaneWidth(maxWidth: number, maxLanes: number): number {
  return maxWidth > maxLanes ? maxLanes + 1 : Math.max(1, maxWidth);
}

/** Geometria das lanes (px) — compartilhada pelo SVG e pelos testes. */
export const LANE_GEOMETRY = {
  rowHeight: 22,
  laneWidth: 12,
  padding: 6,
  nodeRadius: 4,
} as const;

export function laneX(lane: number, laneWidth: number = LANE_GEOMETRY.laneWidth, padding: number = LANE_GEOMETRY.padding): number {
  return padding + lane * laneWidth + laneWidth / 2;
}

/**
 * Caminho SVG de uma aresta entre (x1, y1) e (x2, y2): reta se na mesma
 * coluna; senão curva suave (as arestas de merge/branch).
 */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
}

/**
 * Conjunto destacado para a linhagem: um primitivo acende se leva a um
 * commit do caminho (`target` ∈ path) e, para arestas de base, se sai de
 * um commit do caminho.
 */
export function isPathEdge(target: string, fromHash: string | null, path: ReadonlySet<string>): boolean {
  if (!path.has(target)) return false;
  return fromHash === null || path.has(fromHash);
}

export interface VirtualWindow {
  /** Primeira linha renderizada (inclusive). */
  start: number;
  /** Última linha renderizada (exclusive). */
  end: number;
  /** Altura total da lista (px). */
  total: number;
}

/**
 * Janela de virtualização com altura de linha fixa: só as linhas visíveis +
 * `overscan` acima/abaixo viram DOM. Estável para `scrollTop` fora da faixa.
 */
export function virtualWindow(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 12
): VirtualWindow {
  const total = count * rowHeight;
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0, total: 0 };
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, total - viewport)));
  const first = Math.floor(top / rowHeight);
  const visible = Math.ceil(Math.max(viewport, rowHeight) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, total };
}

/** Precisa da próxima página? (faltam menos de `threshold` linhas até o fim). */
export function shouldLoadMore(windowEnd: number, count: number, hasMore: boolean, loading: boolean, threshold = 100): boolean {
  return hasMore && !loading && count - windowEnd < threshold;
}
