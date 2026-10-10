/**
 * Workspace-symbol search helpers (milestone #5 — "Ir para Símbolo no Projeto",
 * VS Code's Ctrl+T). Pure — no Monaco/LSP imports, so it unit-tests under
 * `node --test`. The UI (`SymbolSearch.tsx`) queries `workspace/symbol` on the
 * running C# client and renders these ranked results.
 *
 * Roslyn answers `workspace/symbol` with LSP `SymbolInformation[]` (confirmed by
 * the probe — real `.cs` symbols resolve, only source-generated docs don't; see
 * `tools/razor-lsp-probe/FINDINGS-fase0.md`). Roslyn already fuzzy-filters by the
 * query it receives, so we DON'T re-filter here — we only normalize, rank ties
 * for a stable order, and cap the list.
 */

/** LSP `SymbolKind`. Only the members we label/icon are named. */
export const SYMBOL_KIND = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  Struct: 23,
  EnumMember: 22,
} as const;

/** A `SymbolInformation` from `workspace/symbol`, narrowed to what we render. */
export interface LspSymbolInformation {
  name: string;
  kind?: number;
  containerName?: string;
  location?: {
    uri?: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
}

/** A symbol ready to render + navigate. `path` is a filesystem path (decoded). */
export interface SymbolHit {
  name: string;
  containerName: string;
  kind: number;
  /** Filesystem path of the defining file. */
  path: string;
  /** 1-based line/column for revealing (Monaco coordinates). */
  line: number;
  column: number;
}

/** Short label for a symbol kind, shown as a dim tag in the list. */
export function symbolKindLabel(kind: number | undefined): string {
  switch (kind) {
    case SYMBOL_KIND.Class:
      return "class";
    case SYMBOL_KIND.Interface:
      return "interface";
    case SYMBOL_KIND.Enum:
      return "enum";
    case SYMBOL_KIND.Struct:
      return "struct";
    case SYMBOL_KIND.Method:
    case SYMBOL_KIND.Function:
      return "method";
    case SYMBOL_KIND.Constructor:
      return "ctor";
    case SYMBOL_KIND.Property:
      return "property";
    case SYMBOL_KIND.Field:
      return "field";
    case SYMBOL_KIND.Constant:
      return "const";
    case SYMBOL_KIND.EnumMember:
      return "enum member";
    case SYMBOL_KIND.Namespace:
    case SYMBOL_KIND.Module:
      return "namespace";
    default:
      return "symbol";
  }
}

/**
 * Decodes an LSP file URI (`file:///c:/a/b.cs`) to a filesystem path. Mirrors the
 * raw-drive-colon convention used across the app; handles percent-encoding and
 * the Windows leading-slash. Returns null for non-file URIs.
 */
export function fileUriToPath(uri: string | undefined): string | null {
  if (!uri || !uri.startsWith("file://")) return null;
  let p = uri.slice("file://".length);
  // A leading `/c:/…` (Windows) — drop the slash before the drive letter.
  p = decodeURIComponent(p);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

/**
 * Converts raw `workspace/symbol` results into rankable hits: decodes the file
 * path, converts 0-based LSP positions to 1-based Monaco coordinates, and drops
 * entries without a resolvable file location. Preserves input order (Roslyn's
 * relevance) — {@link rankSymbolHits} applies only the stable tie-breaks.
 */
export function toSymbolHits(
  symbols: readonly LspSymbolInformation[]
): SymbolHit[] {
  const hits: SymbolHit[] = [];
  for (const s of symbols) {
    const path = fileUriToPath(s.location?.uri);
    if (!path || !s.name) continue;
    const start = s.location?.range?.start;
    hits.push({
      name: s.name,
      containerName: s.containerName ?? "",
      kind: s.kind ?? 0,
      path,
      line: (start?.line ?? 0) + 1,
      column: (start?.character ?? 0) + 1,
    });
  }
  return hits;
}

/**
 * Ranks hits for a query, keeping Roslyn's relevance order but promoting exact
 * and prefix name matches to the top (case-insensitive) — the behavior users
 * expect from Ctrl+T. Stable: equal-rank items keep their incoming order. Caps
 * the result at `limit`.
 */
export function rankSymbolHits(
  query: string,
  hits: readonly SymbolHit[],
  limit = 100
): SymbolHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return hits.slice(0, limit);
  const scored = hits.map((hit, index) => {
    const name = hit.name.toLowerCase();
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else score = 3; // Roslyn matched it (e.g. camel-hump); keep it, rank last.
    return { hit, score, index, length: name.length };
  });
  // Rank by match class, then prefer the shorter name (closer to an exact hit),
  // then fall back to Roslyn's incoming order for a stable result.
  scored.sort(
    (a, b) => a.score - b.score || a.length - b.length || a.index - b.index
  );
  return scored.slice(0, limit).map((s) => s.hit);
}
