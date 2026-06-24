/**
 * Pure routing logic for the CSHTML projection broker (ADR 0002, brick 6).
 *
 * The projection client talks to the standalone Roslyn over the projected
 * `.g.cs`. Roslyn answers in **`.g.cs` coordinates** — measured, not assumed:
 * `tools/razor-lsp-probe/spike-b1d.mjs` showed the CS1061 pull-diagnostic for
 * `@Model.NonExistentProperty` lands at `.g.cs` line 160 (0-based), NOT the
 * `.cshtml` line 15, and hover carries a `.range` in `.g.cs` coordinates too.
 * Therefore every range coming back MUST be remapped generated→source via the
 * Rust `#line` map; ranges that don't map (synthetic compiler scaffolding) are
 * dropped so no squiggle/marker lands on Razor-internal code.
 *
 * This module is deliberately free of any `monaco-editor` import so it is unit
 * testable in isolation. Positions in/out:
 *   - LSP + the Rust remap commands are **0-based** (line, character).
 *   - Monaco markers/ranges are **1-based** (lineNumber, column).
 * The conversion happens here, at the boundary.
 */

/** A 0-based LSP position (matches the Rust `razor_remap_*` contract). */
export interface RemapPos {
  line: number;
  character: number;
}

/** A 0-based LSP range. */
export interface LspRange {
  start: RemapPos;
  end: RemapPos;
}

/** Subset of an LSP `Diagnostic` we route to a Monaco marker. */
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  message: string;
  source?: string;
  tags?: number[];
}

/** An LSP `Location` / `LocationLink` target (definition result). */
export interface LspLocationLike {
  uri?: string;
  targetUri?: string;
  range?: LspRange;
  targetSelectionRange?: LspRange;
  targetRange?: LspRange;
}

/** A 1-based Monaco range (`IRange` shape). */
export interface RoutedRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** A Monaco `IMarkerData`-shaped result (severity is the Monaco numeric enum). */
export interface RoutedMarker extends RoutedRange {
  severity: number;
  message: string;
  code?: string;
  source: string;
}

/** A routed definition target: Monaco uri string + 1-based range. */
export interface RoutedLocation {
  uri: string;
  range: RoutedRange;
}

/**
 * Remap a single 0-based position. Bound to one `.cshtml` by the caller; returns
 * null when the position is synthetic/unmapped. Mirrors `razorRemapToSource` /
 * `razorRemapToGenerated`.
 */
export type RemapFn = (line: number, character: number) => Promise<RemapPos | null>;

/**
 * Monaco `MarkerSeverity` numeric values (the enum is not imported to keep this
 * module monaco-free): Hint=1, Info=2, Warning=4, Error=8.
 */
const MONACO_SEVERITY = { hint: 1, info: 2, warning: 4, error: 8 } as const;

/** LSP `DiagnosticSeverity` (1=Error … 4=Hint) → Monaco `MarkerSeverity`. */
export function lspSeverityToMonaco(severity?: number): number {
  switch (severity) {
    case 2:
      return MONACO_SEVERITY.warning;
    case 3:
      return MONACO_SEVERITY.info;
    case 4:
      return MONACO_SEVERITY.hint;
    case 1:
    default:
      return MONACO_SEVERITY.error;
  }
}

/** Standard LSP `DiagnosticTag` values Monaco understands (others dropped). */
function standardTags(tags?: number[]): number[] | undefined {
  if (!tags) return undefined;
  const kept = tags.filter((t) => t === 1 /* Unnecessary */ || t === 2 /* Deprecated */);
  return kept.length ? kept : undefined;
}

/**
 * Remap a 0-based LSP range to a 1-based Monaco range via `remap`. Returns null
 * if either endpoint is unmappable (synthetic) — the caller drops it.
 */
export async function remapRangeToMonaco(
  range: LspRange,
  remap: RemapFn
): Promise<RoutedRange | null> {
  const start = await remap(range.start.line, range.start.character);
  if (!start) return null;
  const end = await remap(range.end.line, range.end.character);
  if (!end) return null;
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
  };
}

/**
 * A phantom CS0229 caused by the projection architecture, NOT the user's code.
 *
 * A `Microsoft.NET.Sdk.Web` user project loaded in the Roslyn workspace generates
 * its Razor page classes (`AspNetCoreGeneratedDocument.Views_*`) in its OWN
 * compilation, while the shadow project ALSO compiles the same class from the
 * projected `.g.cs`. The duplicate type makes every inherited `[RazorInject]`
 * member ambiguous *with itself* — Roslyn reports `CS0229 Ambiguity between
 * 'T.Member' and 'T.Member'` where BOTH sides are the SAME qualified name. That is
 * always a false positive here. A REAL ambiguity (two DIFFERENT members) keeps its
 * distinct names, so we only drop the self-ambiguous case.
 *
 * (The standalone Roslyn LSP offers no supported way to suppress the user
 * project's Razor generation per-workspace — `Directory.Solution.props` isn't
 * honored by its per-project MSBuild load, and a metadata reference still carries
 * the page classes — so we filter the phantom at the diagnostic boundary.)
 */
export function isPhantomSelfAmbiguity(d: LspDiagnostic): boolean {
  if (String(d.code) !== "CS0229") return false;
  // Match `... between '<a>' and '<b>'` and treat a==b as the phantom.
  const m = /between\s+'([^']+)'\s+and\s+'([^']+)'/i.exec(d.message);
  return m != null && m[1] === m[2];
}

/**
 * Route projected-`.g.cs` diagnostics to `.cshtml` Monaco markers: remap every
 * range generated→source and DROP any that doesn't map (synthetic C#). Also drops
 * the phantom self-ambiguity CS0229 from the duplicated Razor page class (see
 * {@link isPhantomSelfAmbiguity}). The returned `tags` (if any) use Monaco's
 * `MarkerTag` numbering, which matches LSP.
 */
export async function routeDiagnostics(
  items: readonly LspDiagnostic[],
  remapToSource: RemapFn
): Promise<RoutedMarker[]> {
  const markers: RoutedMarker[] = [];
  for (const d of items) {
    if (isPhantomSelfAmbiguity(d)) continue; // architecture artifact, not user code
    const range = await remapRangeToMonaco(d.range, remapToSource);
    if (!range) continue; // unmappable → synthetic scaffolding, not user code
    const tags = standardTags(d.tags);
    markers.push({
      ...range,
      severity: lspSeverityToMonaco(d.severity),
      message: d.message,
      code: d.code != null ? String(d.code) : undefined,
      source: d.source ?? "razor",
      ...(tags ? { tags } : {}),
    } as RoutedMarker);
  }
  return markers;
}

/** Normalize the various definition result shapes into a flat list. */
export function asLocationArray(result: unknown): LspLocationLike[] {
  if (!result) return [];
  return Array.isArray(result) ? (result as LspLocationLike[]) : [result as LspLocationLike];
}

/**
 * Route definition/declaration targets. A target inside the projected `.g.cs`
 * (its uri matches `projectedUriKey` under {@link uriKey}) is rewritten to the
 * `.cshtml` with its range remapped generated→source (dropped if unmappable). A
 * target in any other generated file is dropped (we have no map for it). Real
 * source files (`.cs`, etc.) pass through with a 1-based range.
 *
 * `uriKey` canonicalizes a uri for comparison (e.g. lowercases the Windows drive)
 * — pass {@link canonicalFileUriKey}.
 */
export async function routeDefinition(
  result: unknown,
  opts: {
    projectedUriKey: string;
    cshtmlUri: string;
    remapToSource: RemapFn;
    uriKey: (uri: string) => string;
  }
): Promise<RoutedLocation[]> {
  const { projectedUriKey, cshtmlUri, remapToSource, uriKey } = opts;
  const out: RoutedLocation[] = [];
  for (const loc of asLocationArray(result)) {
    const uri = loc.uri ?? loc.targetUri;
    const lspRange = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
    if (!uri || !lspRange) continue;

    if (uriKey(uri) === projectedUriKey) {
      const range = await remapRangeToMonaco(lspRange, remapToSource);
      if (!range) continue; // target is synthetic scaffolding — drop
      out.push({ uri: cshtmlUri, range });
      continue;
    }
    if (/\.g\.cs$/i.test(uri)) continue; // some other projection we can't map — drop
    out.push({ uri, range: lspRangeToMonaco(lspRange) });
  }
  return out;
}

/** Convert a 0-based LSP range to a 1-based Monaco range (no remap). */
export function lspRangeToMonaco(range: LspRange): RoutedRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Convert a 1-based Monaco position to the projected `.g.cs` 0-based LSP position
 * via `remapToGenerated`. Returns null if the `.cshtml` position has no
 * projection (e.g. inside pure markup with no C#) — the provider then bails.
 */
export async function monacoPosToGenerated(
  lineNumber: number,
  column: number,
  remapToGenerated: RemapFn
): Promise<RemapPos | null> {
  return remapToGenerated(lineNumber - 1, column - 1);
}

// ── Project/path resolution (pure; the starter does the I/O) ──────────────────

/** Directory portion of `path` (strips the last `/` or `\` segment). */
export function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

/** Path of `full` relative to ancestor `base`, OS separators preserved. */
export function relativize(base: string, full: string): string {
  const b = base.replace(/[\\/]+$/, "");
  return full.slice(b.length).replace(/^[\\/]+/, "");
}

/** Case/separator-insensitive test that `dir` is an ancestor of `path`. */
export function isAncestorDir(dir: string, path: string): boolean {
  const dirKey = dir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "") + "/";
  return path.replace(/\\/g, "/").toLowerCase().startsWith(dirKey);
}

/**
 * Of `csprojPaths`, the one whose directory is the **longest** ancestor of
 * `cshtmlPath` (the most specific containing project), or null if none contains
 * it (loose file). Windows-insensitive. Pure — `resolveProject` does the listing.
 */
export function pickProjectForCshtml(
  csprojPaths: readonly string[],
  cshtmlPath: string
): { projectDir: string; csprojPath: string } | null {
  let best: { projectDir: string; csprojPath: string; len: number } | null = null;
  for (const csprojPath of csprojPaths) {
    if (!/\.csproj$/i.test(csprojPath)) continue;
    const projectDir = dirname(csprojPath);
    if (isAncestorDir(projectDir, cshtmlPath) && (!best || projectDir.length > best.len)) {
      best = { projectDir, csprojPath, len: projectDir.length };
    }
  }
  return best ? { projectDir: best.projectDir, csprojPath: best.csprojPath } : null;
}
