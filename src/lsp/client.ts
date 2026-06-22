import * as monaco from "monaco-editor";
import {
  MonacoLanguageClient,
  MonacoServices,
} from "monaco-languageclient";
import {
  CloseAction,
  ErrorAction,
  type DocumentSelector,
  type MessageTransports,
} from "vscode-languageclient";
// Resolves (via the Vite "vscode" alias) to the exact same monaco-languageclient
// VS Code compatibility shim that vscode-languageclient itself `require("vscode")`s
// — i.e. the live singleton — so patching it here affects the language client too.
import * as vscodeShim from "vscode";
import { lspBridgeInfo } from "../api";
import { createTransport, type LspTransport } from "./transport";
import { installReferencesBridge } from "./references";
import { installDiagnosticsBridge } from "./diagnostics";
import { lspLog } from "./debug";

/** Configuration for a single LSP client. Server-agnostic. */
export interface LspClientConfig {
  /** Stable id matching the backend session id, e.g. `"csharp"`. */
  serverId: string;
  /** Human-readable client name (defaults to `"<serverId> Language Client"`). */
  name?: string;
  /** Languages this client serves, e.g. `[{ scheme: "file", language: "csharp" }]`. */
  documentSelector: DocumentSelector;
  /** Workspace root as a `file:///...` URI. */
  rootUri: string;
  /** Server-specific `initialize` options (e.g. Roslyn extension options). */
  initializationOptions?: unknown;
  /** Called when the underlying connection closes (propagated to the manager). */
  onClosed?: () => void;
}

/**
 * Alias kept for the per-language adapters. Every server adapter returns the
 * same concrete client type; this name exists only to read clearly at call
 * sites (the TS/JS and Razor epics referred to the client by this name).
 */
export type RunningClient = MonacoLanguageClient;

let servicesInstalled = false;
type ClientContributions = {
  disposables: monaco.IDisposable[];
  refreshSemanticTokens?: () => void;
  enableSemanticTokens?: () => void;
};

const clientContributions = new WeakMap<
  MonacoLanguageClient,
  ClientContributions
>();

/**
 * Installs the `monaco-languageclient` services exactly once. v1.x bridges the
 * vanilla `monaco-editor` distribution to the language-client runtime via
 * `MonacoServices.install` — no `@codingame/monaco-vscode-api` needed (see
 * `COMPAT.md`).
 */
export function ensureMonacoServices(): void {
  if (servicesInstalled) return;
  MonacoServices.install(monaco);
  defuseUnsupportedProviderRegistrations();
  servicesInstalled = true;
}

/**
 * Makes the monaco-languageclient 1.x VS Code shim degrade gracefully instead of
 * crashing `client.start()`.
 *
 * The shim implements most `languages.register*Provider` methods as a safe no-op
 * (return an empty disposable when the underlying Monaco service is absent), but a
 * handful are hard-coded as `() => { throw new Error('unsupported') }`. When a
 * server advertises one of those capabilities *statically* in its `initialize`
 * result, the matching `vscode-languageclient` feature self-registers during
 * `start()` and the throw bubbles up — `doInitialize` then tears the server down
 * and `start()` rejects with "unsupported". The TypeScript server triggers this
 * via `linkedEditingRangeProvider`; other servers/capabilities could hit the
 * siblings below. None of these providers are features we rely on, so we replace
 * them with the same empty-disposable no-op the shim already uses elsewhere.
 *
 * (The pull-diagnostics crash is handled separately — see
 * {@link neutralizeBuiltinDiagnosticFeature} — because there we must avoid
 * competing with our own diagnostics bridge, not merely avoid a throw.)
 */
function defuseUnsupportedProviderRegistrations(): void {
  try {
    const languages = (vscodeShim as unknown as {
      languages?: Record<string, unknown>;
    }).languages;
    if (!languages) return;
    const noop = (): monaco.IDisposable => ({ dispose() {} });
    for (const method of [
      "registerLinkedEditingRangeProvider",
      "registerTypeHierarchyProvider",
      "registerEvaluatableExpressionProvider",
      "registerInlineValuesProvider",
    ]) {
      if (typeof languages[method] === "function") {
        languages[method] = noop;
      }
    }
  } catch (err) {
    lspLog("could not defuse unsupported provider registrations", String(err));
  }
}

/**
 * Defuses the built-in pull-diagnostics feature **before** `start()`.
 *
 * `vscode-languageclient`'s `DiagnosticFeature` builds a `Tabs` helper the moment
 * a server advertises pull diagnostics (`diagnosticProvider`) *statically* in its
 * `initialize` result — which `typescript-language-server` and the JSON server
 * both do. That `Tabs` constructor reads `vscode.window.tabGroups`, and the
 * monaco-languageclient 1.x VS Code shim implements `tabGroups` (and
 * `activeTextEditor`, `onDidChangeActiveTextEditor`, …) as `() => throw
 * Error('unsupported')`. The throw happens *inside* `client.start()`, so
 * `doInitialize` stops the connection and `start()` rejects with "unsupported" —
 * the server never comes up. (Roslyn dodges this only because it registers
 * diagnostics *dynamically*, after start, where the same throw is swallowed as a
 * request-error response instead of failing startup.)
 *
 * We run our own diagnostics bridge — push + manual pull, see
 * {@link installDiagnosticsBridge} — and that bridge already disposes this same
 * built-in feature once the client is running. So the feature is pure dead weight
 * that only crashes startup. Here we no-op its `initialize` (the static
 * self-registration path) while leaving `fillClientCapabilities` untouched, so the
 * client still advertises pull support, the server still offers pull diagnostics,
 * and our bridge drives them directly.
 */
function neutralizeBuiltinDiagnosticFeature(
  client: MonacoLanguageClient,
  serverId: string
): void {
  try {
    const feature = client.getFeature("textDocument/diagnostic") as
      | { initialize?: (...args: unknown[]) => void }
      | undefined;
    if (feature && typeof feature.initialize === "function") {
      feature.initialize = () => {};
      lspLog("built-in pull-diagnostics feature neutralized for", serverId);
    }
  } catch (err) {
    // Never let this guard itself break startup.
    lspLog("could not neutralize diagnostics feature for", serverId, String(err));
  }
}

/**
 * Builds and starts a {@link MonacoLanguageClient} for the given config.
 *
 * Flow: resolve bridge `{ port, token }` from the backend (ISSUE-22) →
 * open the WS transport (ISSUE-21/23) → wire it as the client's connection
 * provider → `start()`.
 */
export async function createLanguageClient(
  config: LspClientConfig
): Promise<MonacoLanguageClient> {
  ensureMonacoServices();

  lspLog("createLanguageClient: requesting bridge info for", config.serverId);
  const { port, token } = await lspBridgeInfo(config.serverId);
  lspLog("bridge info:", { serverId: config.serverId, port });

  // Resolve the transport eagerly so a connection failure surfaces here rather
  // than inside the client's internal connection provider.
  const transport: LspTransport = await createTransport(port, token);
  lspLog("transport open for", config.serverId);

  const client = new MonacoLanguageClient({
    name: config.name ?? `${config.serverId} Language Client`,
    id: config.serverId,
    clientOptions: {
      // Diagnostics surface as Monaco markers owned by `serverId`; the markers
      // listener (ISSUE-24) deduplicates by owner. `rootUri` reaches the server
      // through the `initialize` request derived from the installed services.
      documentSelector: config.documentSelector,
      // BaseLanguageClient derives initialize.rootUri/workspaceFolders from
      // this field. Keeping rootUri only in our own config object meant Roslyn
      // initialized without a workspace and had to infer project ownership
      // later from solution/open, which is too late for some language features.
      workspaceFolder: {
        uri: monaco.Uri.parse(config.rootUri),
        name: workspaceName(config.rootUri),
        index: 0,
      },
      initializationOptions: config.initializationOptions,
      errorHandler: {
        error: (err, msg, count) => {
          lspLog("client ERROR", config.serverId, String(err), msg?.jsonrpc ?? "", count ?? "");
          return { action: ErrorAction.Continue };
        },
        closed: () => {
          lspLog("client CLOSED handler fired for", config.serverId, "(DoNotRestart)");
          config.onClosed?.();
          return { action: CloseAction.DoNotRestart };
        },
      },
    },
    connectionProvider: {
      get: (): Promise<MessageTransports> =>
        Promise.resolve({
          reader: transport.reader,
          writer: transport.writer,
        }),
    },
  });

  neutralizeBuiltinDiagnosticFeature(client, config.serverId);

  lspLog("calling client.start() for", config.serverId);
  try {
    await client.start();
  } catch (err) {
    // The error message alone ("unsupported") has no location; log the stack so
    // we can see which monaco-languageclient compat shim threw it.
    lspLog(
      "client.start() THREW for",
      config.serverId,
      String(err),
      "\n",
      (err as Error)?.stack ?? "(no stack)"
    );
    throw err;
  }
  lspLog("client.start() RESOLVED for", config.serverId, "state=", client.state);

  installSemanticTokensBridge(
    client,
    config.serverId,
    config.documentSelector
  );

  // "Find All References" / "Peek References" (Shift+F12, context menu, and the
  // Roslyn "N references" CodeLens). Registered after semantic tokens so the two
  // sets of disposables are merged under the same client entry.
  addClientContributions(
    client,
    installReferencesBridge(client, config.serverId, config.documentSelector)
  );

  // Diagnostics → Monaco markers (issue #10): pull for Roslyn
  // (`textDocument/diagnostic`), push for TS/Razor (`publishDiagnostics`). Owned
  // by serverId so markers de-duplicate per server, and feed the Problems panel.
  addClientContributions(
    client,
    installDiagnosticsBridge(client, config.serverId, config.documentSelector)
  );

  // Diagnostic: what models exist and what are their scheme/language? The client
  // only sends didOpen for models whose URI scheme + languageId match the
  // documentSelector. A mismatch here = no didOpen = no IntelliSense.
  try {
    const models = monaco.editor.getModels();
    lspLog(
      "models at start:",
      models.map((m) => ({
        scheme: m.uri.scheme,
        lang: m.getLanguageId(),
        uri: m.uri.toString().slice(0, 80),
      }))
    );
  } catch (e) {
    lspLog("could not enumerate models", String(e));
  }

  return client;
}

/**
 * Disposes Monaco registrations owned by a client before its transport stops.
 * Language providers are global in Monaco, so leaving one behind would make a
 * restarted server compete with a provider that still points at the old client.
 */
export function disposeLanguageClientContributions(
  client: MonacoLanguageClient
): void {
  const contributions = clientContributions.get(client);
  clientContributions.delete(client);
  contributions?.disposables.forEach((contribution) => contribution.dispose());
}

/**
 * Merges additional disposables into a client's contribution entry, creating it
 * if no bridge has registered one yet. Lets independent bridges (semantic
 * tokens, references, …) each contribute disposables without clobbering one
 * another, so {@link disposeLanguageClientContributions} tears them all down.
 */
function addClientContributions(
  client: MonacoLanguageClient,
  disposables: monaco.IDisposable[]
): void {
  if (disposables.length === 0) return;
  const existing = clientContributions.get(client);
  if (existing) {
    existing.disposables.push(...disposables);
  } else {
    clientContributions.set(client, { disposables });
  }
}

/** Requests Monaco to discard cached semantic tokens and ask Roslyn again. */
export function refreshLanguageClientSemanticTokens(
  client: MonacoLanguageClient
): void {
  clientContributions.get(client)?.refreshSemanticTokens?.();
}

/**
 * Enables a semantic-token provider that was intentionally deferred while its
 * workspace loaded. C# uses this to avoid applying Roslyn's miscellaneous-file
 * classifications before `solution/open` finishes.
 */
export function enableLanguageClientSemanticTokens(
  client: MonacoLanguageClient
): void {
  clientContributions.get(client)?.enableSemanticTokens?.();
}

function workspaceName(rootUri: string): string {
  const path = decodeURIComponent(rootUri).replace(/\/+$/, "");
  return path.split("/").pop() || "workspace";
}

type SemanticTokensLegend = {
  tokenTypes: string[];
  tokenModifiers: string[];
};

type SemanticTokensResult = {
  data: number[];
  resultId?: string;
};

function logSemanticTokenSamples(
  serverId: string,
  model: monaco.editor.ITextModel,
  result: SemanticTokensResult,
  legend: SemanticTokensLegend
): void {
  const wanted = new Set([
    "DateTime",
    "AggregateRoot",
    "StatusTituloEnum",
    "Titulo",
  ]);
  const samples: Array<{
    text: string;
    line: number;
    type: string;
  }> = [];
  let line = 0;
  let character = 0;

  for (let i = 0; i + 4 < result.data.length; i += 5) {
    const deltaLine = result.data[i];
    const deltaCharacter = result.data[i + 1];
    const length = result.data[i + 2];
    const typeIndex = result.data[i + 3];
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;

    if (line >= model.getLineCount()) continue;
    const text = model
      .getLineContent(line + 1)
      .slice(character, character + length);
    if (wanted.has(text)) {
      samples.push({
        text,
        line: line + 1,
        type: legend.tokenTypes[typeIndex] ?? `#${typeIndex}`,
      });
    }
  }

  if (samples.length > 0) {
    lspLog("semantic token samples", serverId, samples);
  }
}

function createVoidEvent(): {
  event: monaco.IEvent<void>;
  fire: () => void;
  dispose: () => void;
} {
  const listeners = new Set<(event: void) => unknown>();
  return {
    event: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: () => listeners.forEach((listener) => listener()),
    dispose: () => listeners.clear(),
  };
}

/**
 * monaco-languageclient 1.x predates the Monaco version used by this app. Most
 * LSP features still bridge correctly, but semantic-token registration is
 * fragile because it crosses the package's VS Code compatibility shim twice.
 * Register the provider directly against Monaco using the capability/legend
 * announced by the server, while still sending standard LSP requests.
 */
function installSemanticTokensBridge(
  client: MonacoLanguageClient,
  serverId: string,
  selector: DocumentSelector
): void {
  const capability = client.initializeResult?.capabilities.semanticTokensProvider;
  if (!capability || typeof capability !== "object" || !capability.legend) {
    lspLog("semantic tokens unavailable for", serverId);
    return;
  }

  // Remove the compatibility-shim registration created by SemanticTokensFeature
  // so there is exactly one semantic provider for this client/language.
  const builtInFeature = client.getFeature("textDocument/semanticTokens");
  builtInFeature?.dispose();

  const legend = capability.legend as SemanticTokensLegend;
  const languageSelector =
    selector as unknown as monaco.languages.LanguageSelector;
  const contributions: monaco.IDisposable[] = [];
  const refresh = createVoidEvent();
  let semanticTokensEnabled = serverId !== "csharp";
  const latestRequestByModel = new Map<string, number>();

  const beginRequest = (model: monaco.editor.ITextModel): number => {
    const key = model.uri.toString();
    const request = (latestRequestByModel.get(key) ?? 0) + 1;
    latestRequestByModel.set(key, request);
    return request;
  };

  const isLatestRequest = (
    model: monaco.editor.ITextModel,
    request: number
  ): boolean => latestRequestByModel.get(model.uri.toString()) === request;

  if (capability.full) {
    contributions.push(
      monaco.languages.registerDocumentSemanticTokensProvider(languageSelector, {
        getLegend: () => legend,
        onDidChange: refresh.event,
        provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
          if (!semanticTokensEnabled) return null;
          const request = beginRequest(model);
          const result = await client.sendRequest<SemanticTokensResult | null>(
            "textDocument/semanticTokens/full",
            { textDocument: { uri: model.uri.toString() } },
            token
          );
          if (token.isCancellationRequested || !isLatestRequest(model, request)) {
            return null;
          }
          if (result) {
            logSemanticTokenSamples(serverId, model, result, legend);
          }
          return result
            ? {
                data: Uint32Array.from(result.data),
                resultId: result.resultId,
              }
            : null;
        },
        releaseDocumentSemanticTokens: () => {},
      })
    );
  } else if (capability.range) {
    contributions.push(
      // Monaco's range-provider API has no onDidChange event. Expose Roslyn's
      // range-only capability as a full-document provider so workspace refresh
      // notifications can invalidate cached tokens after project loading.
      monaco.languages.registerDocumentSemanticTokensProvider(languageSelector, {
        getLegend: () => legend,
        onDidChange: refresh.event,
        provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
          if (!semanticTokensEnabled) return null;
          const request = beginRequest(model);
          const lastLine = model.getLineCount();
          const result = await client.sendRequest<SemanticTokensResult | null>(
            "textDocument/semanticTokens/range",
            {
              textDocument: { uri: model.uri.toString() },
              range: {
                start: { line: 0, character: 0 },
                end: {
                  line: lastLine - 1,
                  character: model.getLineMaxColumn(lastLine) - 1,
                },
              },
            },
            token
          );
          if (token.isCancellationRequested || !isLatestRequest(model, request)) {
            return null;
          }
          if (result) {
            logSemanticTokenSamples(serverId, model, result, legend);
          }
          return result
            ? {
                data: Uint32Array.from(result.data),
                resultId: result.resultId,
              }
            : null;
        },
        releaseDocumentSemanticTokens: () => {},
      })
    );
  }

  if (contributions.length > 0) {
    // Roslyn initially returns frozen/partial semantic classifications while
    // projects are loading. It later asks the client to invalidate semantic
    // tokens through this request. The compatibility feature's provider was
    // disposed above, so route the refresh to our direct Monaco provider.
    client.onRequest("workspace/semanticTokens/refresh", () => {
      lspLog("semantic tokens refresh requested by", serverId);
      refresh.fire();
      return null;
    });

    contributions.push({ dispose: refresh.dispose });
    clientContributions.set(client, {
      disposables: contributions,
      refreshSemanticTokens: refresh.fire,
      enableSemanticTokens: () => {
        if (semanticTokensEnabled) return;
        semanticTokensEnabled = true;
        lspLog("semantic tokens enabled for", serverId);
        refresh.fire();
      },
    });
    lspLog("semantic tokens bridge registered for", serverId, {
      full: Boolean(capability.full),
      range: Boolean(capability.range),
      tokenTypes: legend.tokenTypes.length,
    });
  }
}
