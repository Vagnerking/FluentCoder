/**
 * Lógica pura dos breadcrumbs do editor (testada em breadcrumbs.test.ts):
 * segmentação do caminho a partir da raiz certa (multi-root, SSH, Windows),
 * colapso de caminhos longos e o caminho de símbolos sob o cursor.
 */

/** Uma raiz do workspace (pasta local ou SSH). */
export interface BreadcrumbRoot {
  id: string;
  /** Nome exibido (nome da pasta no workspace). */
  name: string;
  path: string;
  /** Conexão SSH da raiz (pastas remotas em workspace multi-root). */
  connId?: string;
}

export type PathCrumbKind = "root" | "folder" | "file";

export interface PathCrumb {
  kind: PathCrumbKind;
  name: string;
  /** Caminho absoluto (separador nativo do arquivo). */
  path: string;
}

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

function trimEnd(path: string): string {
  if (path === "/" || /^[a-zA-Z]:\/$/.test(path)) return path;
  return path.replace(/\/+$/, "");
}

function comparable(path: string): string {
  const p = trimEnd(norm(path));
  return WINDOWS_ABS.test(path) ? p.toLocaleLowerCase("en-US") : p;
}

/** Caminhos virtuais (revisões/diffs Git, untitled) não têm pastas. */
export function isVirtualPath(path: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(path) && !WINDOWS_ABS.test(path);
}

/** Raiz que contém `filePath` (a mais específica), ou null. */
export function rootForPath(
  filePath: string,
  roots: readonly BreadcrumbRoot[],
  preferRootId?: string
): BreadcrumbRoot | null {
  if (preferRootId) {
    const preferred = roots.find((r) => r.id === preferRootId);
    if (preferred && isInside(filePath, preferred.path)) return preferred;
  }
  let best: BreadcrumbRoot | null = null;
  for (const root of roots) {
    if (!isInside(filePath, root.path)) continue;
    if (!best || comparable(root.path).length > comparable(best.path).length) best = root;
  }
  return best;
}

function isInside(filePath: string, rootPath: string): boolean {
  if (!rootPath) return false;
  const f = comparable(filePath);
  const r = comparable(rootPath);
  if (f === r) return true;
  return f.startsWith(r.endsWith("/") ? r : `${r}/`);
}

function joinNative(base: string, segment: string, sep: string): string {
  return base.endsWith("/") || base.endsWith("\\") ? `${base}${segment}` : `${base}${sep}${segment}`;
}

/**
 * Segmentos do caminho: `raiz › pasta › … › arquivo`. A raiz aparece sempre
 * que o arquivo pertence a uma (inclusive arquivos na raiz: `workspace ›
 * AGENTS.md`, nunca só um duplicado da aba). Fora de qualquer raiz, mostra o
 * caminho absoluto; caminhos virtuais mostram só o nome.
 */
export function pathCrumbs(
  filePath: string,
  roots: readonly BreadcrumbRoot[],
  opts: { preferRootId?: string; fileName?: string } = {}
): PathCrumb[] {
  const sep = filePath.includes("\\") ? "\\" : "/";
  const fileName = opts.fileName ?? norm(filePath).split("/").filter(Boolean).pop() ?? filePath;
  if (isVirtualPath(filePath)) return [{ kind: "file", name: fileName, path: filePath }];

  const root = rootForPath(filePath, roots, opts.preferRootId);
  if (root) {
    const rootNorm = trimEnd(norm(root.path));
    const rel = norm(filePath).slice(rootNorm.length).replace(/^\/+/, "");
    const parts = rel.split("/").filter(Boolean);
    const crumbs: PathCrumb[] = [{ kind: "root", name: root.name || rootNorm.split("/").pop() || rootNorm, path: root.path }];
    let acc = root.path.replace(/[\\/]+$/, "") || root.path;
    parts.forEach((part, i) => {
      acc = joinNative(acc, part, sep);
      crumbs.push({ kind: i === parts.length - 1 ? "file" : "folder", name: part, path: acc });
    });
    return crumbs;
  }

  // Fora das raízes: caminho absoluto completo (o colapso cuida do tamanho).
  const n = norm(filePath);
  const parts = n.split("/").filter(Boolean);
  const crumbs: PathCrumb[] = [];
  let acc = "";
  parts.forEach((part, i) => {
    if (i > 0) acc = joinNative(acc, part, sep);
    else if (/^[a-zA-Z]:$/.test(part)) acc = `${part}${sep}`;
    else acc = n.startsWith("/") ? `/${part}` : part;
    crumbs.push({ kind: i === parts.length - 1 ? "file" : "folder", name: part, path: acc });
  });
  return crumbs;
}

/** Item exibido: um crumb ou o "…" que guarda os crumbs escondidos. */
export type DisplayCrumb<T> = { kind: "crumb"; crumb: T; index: number } | { kind: "ellipsis"; hidden: T[] };

/**
 * Caminhos longos colapsam o meio em "…": mantém o primeiro (raiz) e os
 * últimos `max - 2` segmentos. `max` < 3 é tratado como 3.
 */
export function collapseCrumbs<T>(crumbs: readonly T[], max: number): DisplayCrumb<T>[] {
  const limit = Math.max(3, max);
  const all = crumbs.map((crumb, index) => ({ kind: "crumb" as const, crumb, index }));
  if (crumbs.length <= limit) return all;
  const tail = limit - 2;
  return [
    all[0],
    { kind: "ellipsis", hidden: crumbs.slice(1, crumbs.length - tail) },
    ...all.slice(crumbs.length - tail),
  ];
}

/** Largura média reservada a um segmento visível do breadcrumb (px). */
export const BREADCRUMB_SEGMENT_WIDTH = 80;

/**
 * Quantos segmentos de caminho cabem em `width` px (o resto colapsa em "…"),
 * descontando até 2 símbolos. Sempre ≥ 3 (raiz › … › arquivo) e ≤ `max`.
 * 0 = ainda não medido (usa `max`). Evita segmentos espremidos até virarem
 * só separadores num grupo estreito.
 */
export function breadcrumbPathBudget(width: number, symbolCount: number, max: number): number {
  if (!(width > 0)) return max;
  const room = width - Math.min(symbolCount, 2) * BREADCRUMB_SEGMENT_WIDTH;
  return Math.max(3, Math.min(max, Math.floor(room / BREADCRUMB_SEGMENT_WIDTH)));
}

/** Forma mínima de um DocumentSymbol do Monaco (1-based). */
export interface SymbolRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface SymbolNode {
  name: string;
  kind: number;
  range: SymbolRange;
  selectionRange: SymbolRange;
  children?: SymbolNode[];
}

function contains(r: SymbolRange, line: number, column: number): boolean {
  if (line < r.startLineNumber || line > r.endLineNumber) return false;
  if (line === r.startLineNumber && column < r.startColumn) return false;
  if (line === r.endLineNumber && column > r.endColumn) return false;
  return true;
}

/** Cadeia de símbolos (externo → interno) que contém a posição do cursor. */
export function symbolPathAt(symbols: readonly SymbolNode[], line: number, column: number): SymbolNode[] {
  const path: SymbolNode[] = [];
  let level: readonly SymbolNode[] | undefined = symbols;
  while (level && level.length) {
    // O mais interno vence; entre irmãos sobrepostos, o de menor alcance.
    let hit: SymbolNode | undefined;
    for (const s of level) {
      if (!contains(s.range, line, column)) continue;
      if (
        !hit ||
        s.range.endLineNumber - s.range.startLineNumber < hit.range.endLineNumber - hit.range.startLineNumber
      ) {
        hit = s;
      }
    }
    if (!hit) break;
    path.push(hit);
    level = hit.children;
  }
  return path;
}

/** Irmãos de um símbolo do caminho (o nível onde ele está). */
export function symbolSiblings(symbols: readonly SymbolNode[], chain: readonly SymbolNode[], depth: number): readonly SymbolNode[] {
  if (depth <= 0) return symbols;
  return chain[depth - 1]?.children ?? [];
}

/** Ícone (chave do codicon-map) para um `SymbolKind` do Monaco (0-based). */
export function symbolIcon(kind: number): string {
  const map: Record<number, string> = {
    0: "symbolFile",
    1: "symbolModule",
    2: "symbolNamespace",
    3: "symbolModule",
    4: "symbolClass",
    5: "symbolMethod",
    6: "symbolProperty",
    7: "symbolField",
    8: "symbolConstructor",
    9: "symbolEnum",
    10: "symbolInterface",
    11: "symbolFunction",
    12: "symbolVariable",
    13: "symbolConstant",
    14: "symbolString",
    15: "symbolConstant",
    16: "symbolConstant",
    17: "symbolConstant",
    18: "symbolKey",
    19: "symbolKey",
    20: "symbolKey",
    21: "symbolConstant",
    22: "symbolEnumMember",
    23: "symbolStruct",
    24: "symbolEvent",
    25: "symbolOperator",
    26: "symbolTypeParameter",
  };
  return map[kind] ?? "symbolMisc";
}

/** Ordena entradas de pasta como o Explorer: pastas primeiro, depois nome. */
export function sortDirEntries<T extends { name: string; isDir: boolean }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
  );
}

/** Pasta pai (separador nativo preservado); null na raiz do sistema. */
export function parentPath(path: string): string | null {
  const n = norm(path).replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  if (i < 0) return null;
  const sep = path.includes("\\") ? "\\" : "/";
  if (i === 0) return "/";
  const parent = n.slice(0, i);
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}${sep}`;
  return sep === "\\" ? parent.replace(/\//g, "\\") : parent;
}
