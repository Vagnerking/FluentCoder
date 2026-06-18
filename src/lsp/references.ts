/**
 * "Find All References" / "Peek References" bridge for the LSP layer.
 *
 * The standalone `monaco-editor` ships the *peek references* widget contribution
 * and the `editor.action.showReferences` command, but nothing wires an LSP
 * server's `textDocument/references` into Monaco's reference provider. Without
 * this bridge:
 *
 *  - Shift+F12 / right-click → "Find All References" returns nothing, and
 *  - clicking a Roslyn CodeLens ("N references") does nothing, because the
 *    CodeLens command (`editor.action.showReferences`) is invoked with raw LSP
 *    `Location[]` JSON that Monaco's command can't consume.
 *
 * This module registers a real Monaco reference provider (so the native peek
 * widget works) and a command shim that converts LSP locations to Monaco
 * locations before delegating to the built-in `editor.action.showReferences`.
 *
 * Mirrors {@link installSemanticTokensBridge} in `client.ts`: the disposables
 * are returned so the manager can tear them down when the client stops.
 */
import * as monaco from "monaco-editor";
// Internal Monaco service identifier. `editor.action.showReferences` /
// `peekLocations` are `CommandsRegistry` commands (NOT editor actions), so they
// can only be executed through the command service — there is no public
// `monaco.editor.executeCommand`. The command handler we register receives a
// service accessor, and resolving `ICommandService` from it is exactly how
// Monaco's own gotoSymbol handlers delegate (goToCommands.js). The path is
// stable across the 0.5x line; it's deep-imported deliberately.
import { ICommandService } from "monaco-editor/esm/vs/platform/commands/common/commands.js";
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

  // Roslyn's CodeLens fires `editor.action.showReferences` with arguments
  // `[resourceUri, position, locations]` where `locations` is raw LSP
  // `Location[]`. Monaco's native handler for this id asserts Monaco-typed args
  // and would throw on the raw payload, so we override it: normalize the args
  // and delegate to the underlying `editor.action.peekLocations` (which we do
  // NOT override) to open the peek widget. registerCommand restores the previous
  // handler when the returned disposable is disposed.
  disposables.push(
    monaco.editor.registerCommand(
      "editor.action.showReferences",
      (accessor: ServicesAccessor, ...args: unknown[]) => {
        // The accessor is only valid synchronously, so resolve the command
        // service now and hand it to the async opener.
        const commandService = accessor.get(ICommandService) as CommandService;
        void openReferencesPeek(client, commandService, args);
      }
    )
  );

  lspLog("references bridge registered for", serverId);
  return disposables;
}

/**
 * Resolves the arguments handed to `editor.action.showReferences` and opens the
 * peek widget on the active editor. Tolerates two shapes:
 *  - `[uri, position, locations]` (standard LSP CodeLens) — uses the supplied
 *    locations directly.
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

  const [rawUri, rawPosition, rawLocations] = args;
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
