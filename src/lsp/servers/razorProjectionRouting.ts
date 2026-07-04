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
 * Remap N 0-based ranges generated→source in ONE IPC (mirrors
 * `razorRemapRangesToSource`). Entry `i` of the result matches entry `i` of the
 * input; `null` = unmappable (synthetic C#). Replaces the per-endpoint position
 * remap for ranges — 2 IPCs per diagnostic per pull became 1 IPC per pull.
 */
export type RemapRangesFn = (ranges: LspRange[]) => Promise<(LspRange | null)[]>;

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
 * Remap a 0-based LSP range to a 1-based Monaco range via the batch remapper
 * (single-element batch = 1 IPC). Returns null if unmappable (synthetic).
 */
export async function remapRangeToMonaco(
  range: LspRange,
  remapRanges: RemapRangesFn
): Promise<RoutedRange | null> {
  const [mapped] = await remapRanges([range]);
  return mapped ? lspRangeToMonaco(mapped) : null;
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
 * As of the shadow-csproj fix (the `ProjectReference` now sets
 * `EnableDefaultRazorGenerateItems=false` etc. on the user project — see
 * `shadow.rs`), the duplication is eliminated at the source and this phantom no
 * longer appears for the common Web-SDK case. This filter is KEPT as a defensive
 * net: a project that still surfaces the duplicate type by another path (e.g. a
 * pre-built metadata reference carrying the page classes, or a custom Razor
 * target) would otherwise resurface the self-ambiguous CS0229. A REAL ambiguity
 * cites two DIFFERENT members, so dropping only the self-identical case is safe.
 *
 * LOCALE-AGNOSTIC: CS0229's message always cites the two ambiguous members in
 * single quotes (`'A' ... 'B'`), but the surrounding words ("Ambiguity between …
 * and …") are localized (pt-BR: "Ambiguidade entre … e …"). So we extract the
 * quoted symbols rather than matching an English word — phantom iff EXACTLY two
 * quoted symbols and they are identical.
 */
export function isPhantomSelfAmbiguity(d: LspDiagnostic): boolean {
  if (String(d.code) !== "CS0229") return false;
  const quoted = [...d.message.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  return quoted.length === 2 && quoted[0] === quoted[1];
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
  remapRanges: RemapRangesFn
): Promise<RoutedMarker[]> {
  const kept = items.filter((d) => !isPhantomSelfAmbiguity(d)); // arch artifact, not user code
  if (kept.length === 0) return [];
  // ONE IPC for the whole pull (was 2 position IPCs per diagnostic).
  const remapped = await remapRanges(kept.map((d) => d.range));
  const markers: RoutedMarker[] = [];
  kept.forEach((d, i) => {
    const mapped = remapped[i];
    if (!mapped) return; // unmappable → synthetic scaffolding, not user code
    const tags = standardTags(d.tags);
    markers.push({
      ...lspRangeToMonaco(mapped),
      severity: lspSeverityToMonaco(d.severity),
      message: d.message,
      code: d.code != null ? String(d.code) : undefined,
      source: d.source ?? "razor",
      ...(tags ? { tags } : {}),
    } as RoutedMarker);
  });
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
    remapRanges: RemapRangesFn;
    uriKey: (uri: string) => string;
  }
): Promise<RoutedLocation[]> {
  const { projectedUriKey, cshtmlUri, remapRanges, uriKey } = opts;
  const out: RoutedLocation[] = [];
  for (const loc of asLocationArray(result)) {
    const uri = loc.uri ?? loc.targetUri;
    const lspRange = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
    if (!uri || !lspRange) continue;

    if (uriKey(uri) === projectedUriKey) {
      const range = await remapRangeToMonaco(lspRange, remapRanges);
      if (!range) continue; // target is synthetic scaffolding — drop
      out.push({ uri: cshtmlUri, range });
      continue;
    }
    if (/\.g\.cs$/i.test(uri)) continue; // some other projection we can't map — drop
    out.push({ uri, range: lspRangeToMonaco(lspRange) });
  }
  return out;
}

// ── metadata → fonte real (workspace/symbol no cliente csharp principal) ─────

/** Subset de um LSP `SymbolInformation` (resposta de `workspace/symbol`). */
export interface WorkspaceSymbolLite {
  name: string;
  kind?: number;
  containerName?: string;
  location?: { uri?: string; range?: LspRange };
}

/** LSP `SymbolKind` de tipos (class/enum/interface/struct). */
const TYPE_SYMBOL_KINDS = new Set([5, 10, 11, 23]);

/**
 * Escolhe, entre os hits de `workspace/symbol`, o fonte REAL de um alvo de
 * definition que caiu em MetadataAsSource. O workspace shadow da projeção só
 * referencia os projetos irmãos como DLL, então símbolos da própria solution
 * viram decompilado; o cliente csharp principal (solution inteira) sabe o
 * fonte. Sinais usados:
 *   - `word`: o identificador clicado no `.cshtml`.
 *   - `containerHint`: o nome do arquivo de metadata (= tipo container).
 *   - `namespaceHint`: o namespace declarado no cabeçalho do decompilado.
 * Só devolve um hit com evidência (container/namespace batendo, ou hit único
 * inequívoco) — na dúvida devolve `null` e o caller mantém o metadata.
 */
export function pickWorkspaceSymbolForMetadata(
  symbols: readonly WorkspaceSymbolLite[],
  opts: { word: string; containerHint: string; namespaceHint?: string }
): WorkspaceSymbolLite | null {
  const { word, containerHint, namespaceHint } = opts;
  const clickedType = word === containerHint;

  const candidates = symbols.filter((s) => {
    const uri = s.location?.uri;
    if (!uri || !s.location?.range) return false;
    if (/\.g\.cs$/i.test(uri) || /MetadataAsSource/i.test(uri)) return false;
    // Roslyn nomeia métodos como `Nome(args)`; o resto é o identificador puro.
    return s.name === word || s.name.startsWith(`${word}(`);
  });
  if (candidates.length === 0) return null;

  const scored = candidates.map((s) => {
    const container = s.containerName ?? "";
    let score = 0;
    if (!clickedType && container.includes(containerHint)) score += 2;
    if (namespaceHint && container.includes(namespaceHint)) score += 2;
    if (clickedType && TYPE_SYMBOL_KINDS.has(s.kind ?? -1)) score += 1;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Evidência: ou o melhor hit pontuou, ou ele é o ÚNICO candidato possível.
  if (best.score === 0 && candidates.length > 1) return null;
  return best.s;
}

// ── code actions: WorkspaceEdit routing (Fase A2, csharp-ide-parity) ─────────

/** An LSP `TextEdit`. */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/** The subset of an LSP `WorkspaceEdit` we can route. */
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: unknown[];
}

/** A routed text edit: target uri + 1-based Monaco range + replacement text. */
export interface RoutedTextEdit {
  uri: string;
  range: RoutedRange;
  text: string;
}

/**
 * Route a code-action `WorkspaceEdit` back to user-visible documents.
 *
 * Edits on the projected `.g.cs` are remapped to the `.cshtml` with the STRICT
 * mapper; edits on real files pass through 1-based. Returns `null` — meaning
 * the WHOLE ACTION must be dropped — when anything can't be represented
 * faithfully: an unmappable projected range (synthetic C#: applying an
 * approximated span would corrupt the document), a resource operation
 * (create/rename/delete), an edit into a foreign `.g.cs`, or an unknown shape.
 * Partial application is never an option for an edit set.
 */
export async function routeWorkspaceEdit(
  edit: LspWorkspaceEdit,
  opts: {
    projectedUriKey: string;
    cshtmlUri: string;
    remapRangesStrict: RemapRangesFn;
    uriKey: (uri: string) => string;
  }
): Promise<RoutedTextEdit[] | null> {
  const { projectedUriKey, cshtmlUri, remapRangesStrict, uriKey } = opts;

  // Normalize `changes` + `documentChanges` into (uri, edits[]) pairs.
  const byUri: Array<{ uri: string; edits: LspTextEdit[] }> = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    byUri.push({ uri, edits: edits ?? [] });
  }
  for (const dc of edit.documentChanges ?? []) {
    const d = dc as {
      textDocument?: { uri?: string };
      edits?: LspTextEdit[];
      kind?: string;
    };
    if (typeof d.kind === "string") return null; // create/rename/delete — can't route
    const uri = d.textDocument?.uri;
    if (!uri || !Array.isArray(d.edits)) return null; // unknown shape — drop
    byUri.push({ uri, edits: d.edits });
  }

  const out: RoutedTextEdit[] = [];
  for (const { uri, edits } of byUri) {
    if (uriKey(uri) === projectedUriKey) {
      // ONE strict batch per projected doc; ANY miss kills the action.
      const remapped = await remapRangesStrict(edits.map((e) => e.range));
      for (let i = 0; i < edits.length; i++) {
        const r = remapped[i];
        if (!r) return null; // synthetic span — the action cannot apply safely
        out.push({ uri: cshtmlUri, range: lspRangeToMonaco(r), text: edits[i].newText });
      }
      continue;
    }
    if (/\.g\.cs$/i.test(uri)) return null; // another projection we can't map
    for (const e of edits) {
      out.push({ uri, range: lspRangeToMonaco(e.range), text: e.newText });
    }
  }
  return out;
}

/** Monaco `MarkerSeverity` → LSP `DiagnosticSeverity` (inverse of {@link lspSeverityToMonaco}). */
export function monacoSeverityToLsp(severity: number): number {
  if (severity >= 8) return 1; // Error
  if (severity >= 4) return 2; // Warning
  if (severity >= 2) return 3; // Info
  return 4; // Hint
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
