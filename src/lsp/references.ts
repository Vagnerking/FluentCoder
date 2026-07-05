/**
 * "Find All References" / "Peek References" bridge for the LSP layer.
 *
 * The standalone `monaco-editor` ships the *peek references* widget contribution
 * and the `editor.action.showReferences` command, but nothing wires an LSP
 * server's `textDocument/references` into Monaco's reference provider. Without
 * this bridge:
 *
 *  - Shift+F12 / right-click → "Find All References" returns nothing, and
 *  - clicking a Roslyn CodeLens ("N references") does nothing, because Roslyn
 *    resolves that CodeLens to the CUSTOM command `roslyn.client.peekReferences`
 *    (not `editor.action.showReferences`), and nothing registers it — so the
 *    click hits an unregistered command and silently no-ops.
 *
 * This module registers a real Monaco reference provider (so the native peek
 * widget works) and command shims — for both `roslyn.client.peekReferences` and
 * the generic `editor.action.showReferences` — that recover uri+position from
 * whatever argument shape the server sent and open the built-in peek widget.
 *
 * Mirrors {@link installSemanticTokensBridge} in `client.ts`: the disposables
 * are returned so the manager can tear them down when the client stops.
 */
import * as monaco from "monaco-editor";
// VS Code service identifier. `editor.action.showReferences` / `peekLocations`
// are `CommandsRegistry` commands (NOT editor actions), so they can only be
// executed through the command service — there is no public
// `monaco.editor.executeCommand`. The command handler we register receives a
// service accessor, and resolving `ICommandService` from it is exactly how
// Monaco's own gotoSymbol handlers delegate (goToCommands.js).
//
// On the v10 stack the service identifier lives in
// `@codingame/monaco-vscode-api/services` (the old vanilla deep import
// `monaco-editor/esm/vs/platform/commands/common/commands.js` is NOT a valid
// specifier of `@codingame/monaco-vscode-editor-api`).
import { ICommandService } from "@codingame/monaco-vscode-api/services";
import type { MonacoLanguageClient } from "monaco-languageclient";
import type { DocumentSelector } from "vscode-languageclient";
import { lspLog } from "./debug";

/** The subset of Monaco's service accessor we use inside command handlers. */
interface ServicesAccessor {
  get<T>(id: T): { executeCommand(id: string, ...args: unknown[]): unknown };
}

/** Minimal command-service shape resolved from the accessor. */
interface CommandService {
  executeCommand(id: string, ...args: unknown[]): unknown;
}

/** Minimal shape of an LSP `Location` (and `LocationLink`) we consume. */
interface LspLocation {
  uri?: string;
  targetUri?: string;
  range?: LspRange;
  targetSelectionRange?: LspRange;
  targetRange?: LspRange;
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Converts an LSP 0-based range to a Monaco 1-based range. */
function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Normalizes either a plain LSP `Location` or a `LocationLink` into a Monaco
 * `Location`. Returns `null` if the entry has no usable uri/range so callers can
 * filter it out.
 */
function toMonacoLocation(loc: LspLocation): monaco.languages.Location | null {
  const uri = loc.uri ?? loc.targetUri;
  const range =
    loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
  if (!uri || !range) return null;
  return {
    uri: monaco.Uri.parse(uri),
    range: toMonacoRange(range),
  };
}

/**
 * Sends `textDocument/references` and maps the result to Monaco locations.
 * Shared by the reference provider and the CodeLens command shim.
 */
async function requestReferences(
  client: MonacoLanguageClient,
  uri: string,
  position: { line: number; character: number },
  includeDeclaration: boolean,
  cancel?: monaco.CancellationToken
): Promise<monaco.languages.Location[]> {
  const result = await client.sendRequest<LspLocation[] | null>(
    "textDocument/references",
    {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    },
    cancel
  );
  if (!result) return [];
  return result
    .map(toMonacoLocation)
    .filter((l): l is monaco.languages.Location => l !== null);
}

/**
 * Wires up "Find All References" / "Peek References" for a language client.
 *
 * 1. Registers a Monaco reference provider so the native Shift+F12 / context
 *    menu / peek widget resolve through `textDocument/references`.
 * 2. Registers `editor.action.showReferences` so a Roslyn (or any LSP) CodeLens
 *    "N references" click opens the peek widget. The CodeLens passes LSP
 *    `Location[]`; we convert them to Monaco locations and open the peek.
 *
 * Only registers if the server actually advertises `referencesProvider`.
 * Returns the disposables (provider + command), or an empty array if the
 * capability is absent. Caller owns disposal.
 */
export function installReferencesBridge(
  client: MonacoLanguageClient,
  serverId: string,
  selector: DocumentSelector
): monaco.IDisposable[] {
  const capability = client.initializeResult?.capabilities.referencesProvider;
  if (!capability) {
    lspLog("references unavailable for", serverId);
    return [];
  }

  const languageSelector = selector as unknown as monaco.languages.LanguageSelector;
  const disposables: monaco.IDisposable[] = [];

  disposables.push(
    monaco.languages.registerReferenceProvider(languageSelector, {
      provideReferences: async (model, position, context, token) =>
        requestReferences(
          client,
          model.uri.toString(),
          { line: position.lineNumber - 1, character: position.column - 1 },
          context.includeDeclaration,
          token
        ),
    })
  );

  // A references CodeLens click executes a command whose id depends on the
  // server:
  //   - Roslyn (`Microsoft.CodeAnalysis.LanguageServer`) resolves its
  //     "N references" CodeLens to the CUSTOM id `roslyn.client.peekReferences`
  //     with a single-object argument `[{ textDocument, position }]`. This id is
  //     not registered anywhere by default, so the click silently no-ops (the
  //     original symptom). This is the one that matters for C#.
  //   - Generic LSP servers use `editor.action.showReferences` with
  //     `[resourceUri, position, locations]` (raw LSP `Location[]`). Monaco's
  //     native handler for that id asserts Monaco-typed args and would throw on
  //     the raw payload.
  // We register BOTH so either server opens the peek. Each handler normalizes
  // whatever argument shape it receives and, when locations are absent or
  // unrecognized, falls back to a live `textDocument/references` request — so we
  // never depend on a server's exact location payload. registerCommand restores
  // any previous handler when the returned disposable is disposed.
  for (const commandId of [
    "roslyn.client.peekReferences",
    "editor.action.showReferences",
  ]) {
    disposables.push(
      monaco.editor.registerCommand(
        commandId,
        (accessor: ServicesAccessor, ...args: unknown[]) => {
          // The accessor is only valid synchronously, so resolve the command
          // service now and hand it to the async opener.
          lspLog("references CodeLens clicked", serverId, commandId, "argc=", args.length);
          const commandService = accessor.get(ICommandService) as CommandService;
          void openReferencesPeek(client, commandService, args);
        }
      )
    );
  }

  lspLog("references bridge registered for", serverId);
  return disposables;
}

/**
 * Resolves the arguments handed to a references-CodeLens command and opens the
 * peek widget on the active editor. Tolerates three shapes:
 *  - `[uri, position, locations]` (standard LSP CodeLens,
 *    `editor.action.showReferences`) — uses the supplied locations directly.
 *  - `[{ textDocument, position }]` (Roslyn `roslyn.client.peekReferences`) — a
 *    single positional object; locations are fetched live.
 *  - `[uri, position]` (or anything missing locations) — falls back to a live
 *    `textDocument/references` request at the position.
 */
async function openReferencesPeek(
  client: MonacoLanguageClient,
  commandService: CommandService,
  args: unknown[]
): Promise<void> {
  const editor =
    monaco.editor.getEditors().find((e) => e.hasTextFocus()) ??
    monaco.editor.getEditors()[0];

  // Roslyn passes a single object `{ textDocument: { uri }, position }`; the
  // generic shape is positional `[uri, position, locations]`. Detect the former
  // and unwrap it so the positional parsing below works for both.
  const wrapped = unwrapSingleObjectArg(args);
  const [rawUri, rawPosition, rawLocations] = wrapped ?? args;
  const uri = parseUriArg(rawUri) ?? editor?.getModel()?.uri ?? null;
  const position = parsePositionArg(rawPosition) ?? editor?.getPosition() ?? null;
  if (!uri || !position) {
    lspLog("showReferences: missing uri/position", { rawUri, rawPosition });
    return;
  }

  let locations = normalizeLocations(rawLocations);
  if (locations.length === 0) {
    // CodeLens didn't ship locations (or shipped an unrecognized shape) — ask
    // the server. `includeDeclaration: false` matches VS Code's "N references"
    // semantics (the declaration itself isn't counted as a reference).
    locations = await requestReferences(
      client,
      uri.toString(),
      { line: position.lineNumber - 1, character: position.column - 1 },
      false
    );
  }

  // `editor.action.peekLocations` (the command `showReferences` aliases to)
  // opens Monaco's peek widget at `position` showing `locations`. Passing
  // `"peek"` as the multiple-results behaviour forces the peek even for a single
  // result, matching VS Code's CodeLens click.
  try {
    await commandService.executeCommand(
      "editor.action.peekLocations",
      uri,
      position,
      locations,
      "peek"
    );
  } catch (err) {
    lspLog("showReferences: peekLocations failed", String(err));
  }
}

/**
 * Roslyn's `roslyn.client.peekReferences` is invoked with a single positional
 * object `{ textDocument: { uri }, position }` (occasionally `{ uri, position }`
 * or with a `locations` array). Detects that shape and re-projects it onto the
 * `[uri, position, locations]` tuple the positional parsers expect. Returns
 * `null` when `args` isn't a single-object payload, so the caller keeps using
 * `args` verbatim.
 */
function unwrapSingleObjectArg(args: unknown[]): unknown[] | null {
  if (args.length !== 1) return null;
  const only = args[0];
  if (!only || typeof only !== "object" || Array.isArray(only)) return null;
  const obj = only as Record<string, unknown>;
  // A Monaco Uri or a positional tuple element (has lineNumber/line) is NOT the
  // single-object wrapper — leave those to the positional path.
  if (only instanceof monaco.Uri) return null;
  if ("lineNumber" in obj || "line" in obj) return null;

  const td = obj.textDocument as Record<string, unknown> | undefined;
  const uri = obj.uri ?? td?.uri;
  const position = obj.position;
  const locations = obj.locations ?? obj.references;
  if (uri === undefined && position === undefined) return null;
  return [uri, position, locations];
}

/** Coerces the first command arg into a Monaco `Uri`, if possible. */
function parseUriArg(value: unknown): monaco.Uri | null {
  if (!value) return null;
  if (value instanceof monaco.Uri) return value;
  if (typeof value === "string") return monaco.Uri.parse(value);
  if (typeof value === "object" && "scheme" in (value as object)) {
    // A serialized UriComponents from the language-client shim.
    try {
      return monaco.Uri.from(value as monaco.UriComponents);
    } catch {
      return null;
    }
  }
  return null;
}

/** Coerces the second command arg into a Monaco `IPosition`, if possible. */
function parsePositionArg(value: unknown): monaco.IPosition | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // Monaco position (1-based) vs LSP position (0-based, line/character).
  if (typeof v.lineNumber === "number" && typeof v.column === "number") {
    return { lineNumber: v.lineNumber, column: v.column };
  }
  if (typeof v.line === "number" && typeof v.character === "number") {
    return { lineNumber: v.line + 1, column: v.character + 1 };
  }
  return null;
}

/**
 * Normalizes the `locations` command argument into Monaco locations. Accepts
 * already-Monaco locations or raw LSP `Location[]`/`LocationLink[]`.
 */
function normalizeLocations(value: unknown): monaco.languages.Location[] {
  if (!Array.isArray(value)) return [];
  const out: monaco.languages.Location[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // Already a Monaco location: a Uri instance + a 1-based IRange.
    if (
      obj.uri instanceof monaco.Uri &&
      obj.range &&
      typeof (obj.range as Record<string, unknown>).startLineNumber === "number"
    ) {
      out.push(item as monaco.languages.Location);
      continue;
    }
    const mapped = toMonacoLocation(item as LspLocation);
    if (mapped) out.push(mapped);
  }
  return out;
}
