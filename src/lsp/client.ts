import * as monaco from "monaco-editor";
import { MonacoLanguageClient } from "monaco-languageclient";
import {
  CloseAction,
  ErrorAction,
  type DocumentSelector,
  type LanguageClientOptions,
} from "vscode-languageclient";
import { canonicalizeDriveInFileUri } from "./uri";
import { lspBridgeInfo } from "../api";
import { createTransport, type LspTransport } from "./transport";
import { installReferencesBridge } from "./references";
import { installDiagnosticsBridge } from "./diagnostics";
import { ensureVscodeServices } from "./vscodeServices";
import { disableNativeClientFeature } from "./nativeFeatures";
import type { DiagnosticMode } from "./diagnosticMode";
import {
  applySemanticTokenDecorations,
  clearSemanticTokenDecorations,
} from "./semanticColorizer";
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
  /** How diagnostics are delivered. C# explicitly uses pull because Roslyn
   * accepts `textDocument/diagnostic` without advertising the capability. */
  diagnosticMode?: DiagnosticMode;
  /** Optional diagnostic registrations to pull separately. Roslyn exposes
   * compiler categories this way, avoiding expensive analyzer aggregation. */
  diagnosticIdentifiers?: readonly string[];
  /**
   * When true, semantic tokens start disabled and are enabled only after
   * `projectInitializationComplete` (via {@link enableLanguageClientSemanticTokens}).
   * Both Roslyn servers (C# standalone and Razor cohosting) set this flag so
   * provisional classifications never flash before the project is fully loaded.
   */
  deferSemanticTokens?: boolean;
  /** Called when the underlying connection closes (propagated to the manager). */
  onClosed?: () => void;
  /**
   * Projection mode (ADR 0002): skip the generic semantic-tokens / references /
   * diagnostics bridges. Those auto-register Monaco providers for the client's
   * selector; a second Roslyn client over a `csharp` selector would then compete
   * with the real C# client on every `.cs` model. The CSHTML projection client
   * drives its requests manually via `sendRequest` instead, so it wants only the
   * transport — no global providers. See `servers/razorProjection.ts`.
   */
  suppressGenericBridges?: boolean;
}

/**
 * Alias kept for the per-language adapters. Every server adapter returns the
 * same concrete client type; this name exists only to read clearly at call
 * sites (the TS/JS and Razor epics referred to the client by this name).
 */
export type RunningClient = MonacoLanguageClient;

type ClientContributions = {
  disposables: monaco.IDisposable[];
  refreshSemanticTokens?: () => void;
  enableSemanticTokens?: () => void;
  /** Re-pull tokens on a backoff until Roslyn's classification stabilizes. */
  stabilizeSemanticTokens?: () => void;
  /** Invalidates cached result ids and re-pulls diagnostics for tracked models. */
  repullDiagnostics?: () => void;
};

const clientContributions = new WeakMap<
  MonacoLanguageClient,
  ClientContributions
>();

/**
 * Clientes vivos por serverId, para consultas CROSS-servidor: a projeção
 * Razor (workspace shadow, que só enxerga DLLs dos projetos irmãos) resolve
 * alvos de definition que caíram em MetadataAsSource perguntando ao cliente
 * `csharp` principal (que tem a solution inteira) via `workspace/symbol`.
 */
const runningClientsById = new Map<string, MonacoLanguageClient>();
const serverIdByClient = new WeakMap<MonacoLanguageClient, string>();

/** O cliente vivo de `serverId`, ou `undefined` se não está de pé. */
export function getRunningClient(
  serverId: string
): MonacoLanguageClient | undefined {
  return runningClientsById.get(serverId);
}

/**
 * Builds and starts a {@link MonacoLanguageClient} for the given config.
 *
 * Flow: boot the shared `@codingame/monaco-vscode-api` services (idempotent) →
 * resolve bridge `{ port, token }` from the backend (ISSUE-22) → open the WS
 * transport (ISSUE-21/23) → hand the reader/writer to the client through the
 * v10 `messageTransports` option → `start()`.
 */
export async function createLanguageClient(
  config: LspClientConfig
): Promise<MonacoLanguageClient> {
  // v10 replacement for v1.x's `MonacoServices.install(monaco)`: the VS Code
  // services must be running before any client is built. Idempotent + shared
  // with monaco-loader.ts, so the editor and the LSP layer boot ONE instance.
  await ensureVscodeServices();

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
      // ONE canonical wire form for file uris (raw drive colon, `file:///c:/…`).
      // The native document-sync features serialize through the extHost `Uri`
      // class, which percent-encodes the drive colon (`c%3A`) — a form our
      // `installWindowsFileUriSerialization` patch deliberately avoids (Roslyn
      // pushes `c%3A` docs into "Miscellaneous Files") and that MISMATCHES every
      // hand-rolled sender (rebind, pulls, projection), all of which produce the
      // raw form. Roslyn tracks docs by exact uri string: on ativus the native
      // didOpen (`c%3A`) + our rebind didClose (`c:`) triggered a fatal
      // InvalidOperationException ("Error processing queue, shutting down").
      // This converter is the single choke point every native feature uses.
      uriConverters: {
        code2Protocol: (uri) => canonicalizeDriveInFileUri(uri.toString()),
        protocol2Code: (value) =>
          monaco.Uri.parse(value) as unknown as ReturnType<
            NonNullable<
              NonNullable<LanguageClientOptions["uriConverters"]>["protocol2Code"]
            >
          >,
      },
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
      middleware: {
        // DIAG (Ctrl+. / quick fix): loga o textDocument/codeAction ANTES do
        // funil extHost→Monaco, para separar "o Roslyn não devolveu a action"
        // de "uma camada do editor descartou". A linha contém o serverId
        // (ex.: "csharp"), então o espelho para razor-diag.log (PIPELINE_RE em
        // debug.ts) captura mesmo em build empacotada.
        provideCodeActions: async (document, range, context, token, next) => {
          const startedAt = performance.now();
          lspLog("codeAction request", config.serverId, {
            uri: document.uri.toString().slice(-48),
            range: `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`,
            only: context.only?.value ?? null,
            trigger: context.triggerKind,
            ctxDiags: context.diagnostics.length,
          });
          const result = await next(document, range, context, token);
          try {
            const items = Array.isArray(result) ? result : [];
            lspLog("codeAction result", config.serverId, {
              ms: Math.round(performance.now() - startedAt),
              cancelled: token.isCancellationRequested,
              titles: items.map((a) => a.title),
            });
          } catch {
            /* diagnóstico é best-effort; nunca quebrar o quick fix por log */
          }
          return result;
        },
      },
    },
    // ─── THE KEY v10 CHANGE ───
    // v1.x: connectionProvider: { get: () => Promise.resolve({ reader, writer }) }
    // v10 : messageTransports: { reader, writer }
    // The WS bridge transport (src/lsp/transport.ts) is reused AS-IS; only the
    // way the reader/writer pair reaches the client changed.
    messageTransports: {
      reader: transport.reader,
      writer: transport.writer,
    },
  });

  // RECONCILIATION (#76): on the v10 stack the built-in client features now
  // auto-register real Monaco providers from the server capabilities. We keep
  // our hand-written bridges (which encode the C# token stabilization, owner
  // marker dedup and the references CodeLens override) and DISABLE the native
  // features so there is exactly one provider per feature/language. Must run
  // before start(). Projection clients (suppressGenericBridges) install no
  // bridges of their own and want transport-only behavior, so their native
  // features must be neutralized too: although their selector never matches a
  // real Monaco model, Roslyn still advertises semanticTokens/diagnostic/
  // references in `initialize`, and the native features attach per-client during
  // start() regardless of selector — leaving them live would register stray
  // providers that compete with the real C# client's bridges. `disableNative-
  // ClientFeature` patches only THIS client's feature instances, so neutralizing
  // here cannot disturb the real C# client. See nativeFeatures.ts and
  // servers/razorProjection.ts.
  disableNativeClientFeature(client, config.serverId, "textDocument/semanticTokens");
  disableNativeClientFeature(client, config.serverId, "textDocument/diagnostic");
  disableNativeClientFeature(client, config.serverId, "textDocument/references");

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

  runningClientsById.set(config.serverId, client);
  serverIdByClient.set(client, config.serverId);

  // Projection clients (ADR 0002) want only the transport: their `.g.cs` is not
  // a Monaco model and their results are remapped to the `.cshtml` manually, so
  // the generic bridges would only register colliding providers for `csharp`.
  if (config.suppressGenericBridges) {
    lspLog("generic bridges suppressed (projection mode) for", config.serverId);
  } else {
    installSemanticTokensBridge(
      client,
      config.serverId,
      config.documentSelector,
      config.deferSemanticTokens ?? false
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
    const diagnostics = installDiagnosticsBridge(
      client,
      config.serverId,
      config.documentSelector,
      config.diagnosticMode,
      config.diagnosticIdentifiers
    );
    addClientContributions(client, diagnostics.disposables);
    mergeClientContributions(client, {
      repullDiagnostics: diagnostics.repull,
    });
  }

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
  const serverId = serverIdByClient.get(client);
  if (serverId && runningClientsById.get(serverId) === client) {
    runningClientsById.delete(serverId);
  }
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
export function addClientContributions(
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

/**
 * Merges non-disposable contribution hooks (e.g. diagnostics re-pull)
 * into a client's entry without touching its disposables. Creates the entry with
 * an empty disposables list if no bridge has registered one yet.
 */
function mergeClientContributions(
  client: MonacoLanguageClient,
  extra: Partial<Omit<ClientContributions, "disposables">>
): void {
  const existing = clientContributions.get(client);
  if (existing) {
    Object.assign(existing, extra);
  } else {
    clientContributions.set(client, { disposables: [], ...extra });
  }
}

/**
 * Registers extra disposables under a client's contribution entry so
 * {@link disposeLanguageClientContributions} tears them down when the manager
 * stops the client. The CSHTML projection starter (ADR 0002) uses this to own
 * its Monaco providers, diagnostic timers, and `.g.cs` state — nothing leaks on
 * restart / "Resetar Servidores de Código" / workspace switch / StrictMode.
 */
export function registerClientDisposables(
  client: MonacoLanguageClient,
  disposables: monaco.IDisposable[]
): void {
  addClientContributions(client, disposables);
}

/** Requests Monaco to discard cached semantic tokens and ask Roslyn again. */
export function refreshLanguageClientSemanticTokens(
  client: MonacoLanguageClient
): void {
  clientContributions.get(client)?.refreshSemanticTokens?.();
}

/**
 * Re-pulls semantic tokens on a backoff until the server's classification
 * stops changing. Use after a workspace finishes loading (Roslyn streams
 * provisional classifications first and never signals when the correct ones are
 * ready), so colors converge without the user having to switch tabs.
 */
export function stabilizeLanguageClientSemanticTokens(
  client: MonacoLanguageClient
): void {
  clientContributions.get(client)?.stabilizeSemanticTokens?.();
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

/**
 * Invalidates cached diagnostic result ids and pulls every tracked model again.
 * C# calls this after rebinding documents to the fully loaded solution.
 */
export function repullDiagnostics(client: MonacoLanguageClient): void {
  clientContributions.get(client)?.repullDiagnostics?.();
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
  selector: DocumentSelector,
  deferSemanticTokens: boolean
): void {
  const capability = client.initializeResult?.capabilities.semanticTokensProvider;
  // DIAG: dump the exact capability Roslyn announced (full can be bool or
  // { delta }, range can be bool or {}). Tells us which request path is valid.
  lspLog("DIAG semanticTokensProvider capability", serverId, capability);
  if (!capability || typeof capability !== "object" || !capability.legend) {
    lspLog("semantic tokens unavailable for", serverId);
    return;
  }

  // The native SemanticTokensFeature was already neutralized before start()
  // (see createLanguageClient → disableNativeClientFeature), so registering our
  // provider below leaves exactly ONE semantic-tokens provider for this
  // client/language — the prerequisite for the C# provisional→definitive
  // stabilization to work without a competing native provider repainting tokens.

  const legend = capability.legend as SemanticTokensLegend;
  const contributions: monaco.IDisposable[] = [];
  const refresh = createVoidEvent();
  let semanticTokensEnabled = !deferSemanticTokens;
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

  // Fingerprint of the last token data returned per model, used to detect when
  // Roslyn's classification has stabilized. After projectInitializationComplete
  // Roslyn serves PROVISIONAL classifications (e.g. an enum typed as `variable`)
  // and only later returns the correct ones — without ever sending
  // workspace/semanticTokens/refresh. So we re-pull on a backoff until two
  // consecutive results match. See ISSUE: C# class/enum colors only paint after
  // a manual tab switch.
  const lastTokenHashByModel = new Map<string, string>();

  const hashTokens = (data: number[]): string => {
    // Cheap order-sensitive fold; good enough to tell two token streams apart.
    let h = 5381;
    for (let i = 0; i < data.length; i++) h = ((h << 5) + h + data[i]) | 0;
    return `${data.length}:${h}`;
  };

  // Fire the provider's onDidChange now and again on the next microtask. A bare
  // synchronous fire can land before the active tab's model is bound to the
  // editor (e.g. enable runs while the C# file is mid-open or on a hidden tab),
  // and Monaco only re-pulls tokens for the model bound to a visible editor.
  // The deferred fire catches the model once binding settles. See ISSUE: C#
  // class/enum colors not painting until a tab switch.
  const fireRefreshNowAndDeferred = (): void => {
    refresh.fire();
    queueMicrotask(() => refresh.fire());
  };

  // Re-pull tokens on a backoff until the visible models' classifications stop
  // changing (Roslyn streams provisional → correct tokens after project init,
  // with no refresh signal of its own). Each refresh re-pulls the visible model;
  // we stop early once a full pass sees no model's token hash change, or after
  // the schedule is exhausted. Guarded by a token so a later poll supersedes an
  // earlier one. Only meaningful while semanticTokensEnabled is true.
  const STABILIZE_DELAYS_MS = [250, 600, 1200, 2400, 4000];
  let stabilizePass = 0;
  const repaintUntilStable = (): void => {
    const myPass = ++stabilizePass;
    const snapshot = (): string =>
      monaco.editor
        .getModels()
        .filter((m) => servedLanguages.has(m.getLanguageId()))
        .map((m) => `${m.uri.toString()}=${lastTokenHashByModel.get(m.uri.toString()) ?? ""}`)
        .join("|");

    let before = snapshot();
    refresh.fire();

    const step = (i: number): void => {
      if (myPass !== stabilizePass || !semanticTokensEnabled) return;
      const delay = STABILIZE_DELAYS_MS[i];
      if (delay == null) return; // schedule exhausted
      setTimeout(() => {
        if (myPass !== stabilizePass || !semanticTokensEnabled) return;
        const after = snapshot();
        // A pass that changed nothing means tokens settled — stop early. We
        // still take one extra fire below to be safe against an in-flight pull.
        const settled = after === before && i > 0;
        before = after;
        refresh.fire();
        if (!settled) step(i + 1);
      }, delay);
    };
    step(0);
  };

  // Languages this client serves, lifted from the document selector. Used to
  // tell whether a model that just became visible belongs to this client.
  const servedLanguages = new Set(
    (Array.isArray(selector) ? selector : [selector])
      .map((s) => (typeof s === "string" ? s : s?.language))
      .filter((l): l is string => typeof l === "string")
  );

  // Re-pull semantic tokens the moment one of this client's models becomes the
  // active model of an editor. This deterministically reproduces the manual
  // "switch tabs and the colors appear" cure: enabling tokens after Roslyn's
  // project init fires a single global refresh, which is lost if the model
  // wasn't the visible one then. Binding-to-visible is the reliable trigger, so
  // we re-fire refresh here regardless of when enable happened.
  // TEMP: prove the provider is actually invoked (not just that refresh fired)
  // and whether the gate was open at call time. Pairs with the manual-test
  // checklist for the C# colors-not-painting fix; remove once confirmed.
  const logProviderCall = (model: monaco.editor.ITextModel, kind: string): void =>
    lspLog("provideDocumentSemanticTokens", serverId, kind, {
      enabled: semanticTokensEnabled,
      uri: model.uri.toString().slice(-60),
    });

  const watchModelBecomesVisible = (
    editor: monaco.editor.ICodeEditor
  ): monaco.IDisposable =>
    editor.onDidChangeModel((e) => {
      if (!e.newModelUrl || !semanticTokensEnabled) return;
      const model = monaco.editor.getModel(e.newModelUrl);
      if (model && servedLanguages.has(model.getLanguageId())) {
        void pullAndPaint(model);
      }
    });

  // Pull de tokens + pintura por DECORATIONS (semanticColorizer). O engine
  // nativo de semantic highlighting fica DESLIGADO no v10 (as cores dele vêm
  // do serviço de tema do VS Code, que este app não instala — ver EditorPane);
  // com isso um DocumentSemanticTokensProvider registrado jamais seria
  // invocado. Este pump substitui o provider: mesmos requests LSP, mas o
  // resultado vira decorations com a paleta própria, por cima do Monarch.
  const pullAndPaint = async (
    model: monaco.editor.ITextModel
  ): Promise<void> => {
    if (!semanticTokensEnabled || model.isDisposed()) return;
    logProviderCall(model, capability.full ? "full" : "range");
    const request = beginRequest(model);
    let result: SemanticTokensResult | null = null;
    try {
      if (capability.full) {
        result = await client.sendRequest<SemanticTokensResult | null>(
          "textDocument/semanticTokens/full",
          { textDocument: { uri: client.code2ProtocolConverter.asUri(model.uri as never) } }
        );
      } else {
        const lastLine = model.getLineCount();
        result = await client.sendRequest<SemanticTokensResult | null>(
          "textDocument/semanticTokens/range",
          {
            textDocument: { uri: client.code2ProtocolConverter.asUri(model.uri as never) },
            range: {
              start: { line: 0, character: 0 },
              end: {
                line: lastLine - 1,
                character: model.getLineMaxColumn(lastLine) - 1,
              },
            },
          }
        );
      }
    } catch (err) {
      lspLog("semantic tokens pull failed", serverId, String(err));
      return;
    }
    // Um pull mais novo já partiu para este model — descarta o resultado
    // velho em vez de pintar classificação obsoleta por cima da nova.
    if (!isLatestRequest(model, request) || model.isDisposed()) return;
    if (result) {
      lastTokenHashByModel.set(model.uri.toString(), hashTokens(result.data));
      logSemanticTokenSamples(serverId, model, result, legend);
      applySemanticTokenDecorations(model, result.data, legend);
    }
  };

  const pullAllServedModels = (): void => {
    for (const model of monaco.editor.getModels()) {
      if (servedLanguages.has(model.getLanguageId())) void pullAndPaint(model);
    }
  };

  if (capability.full || capability.range) {
    // O refresh event (server refresh, enable, stabilize) agora alimenta o
    // pump diretamente.
    contributions.push(refresh.event(pullAllServedModels));

    // Re-pull em edição: o engine nativo fazia isso sozinho; o pump precisa
    // do próprio debounce por model.
    const changeDebounce = new Map<string, number>();
    const watchModelEdits = (model: monaco.editor.ITextModel): void => {
      if (!servedLanguages.has(model.getLanguageId())) return;
      const key = model.uri.toString();
      const sub = model.onDidChangeContent(() => {
        window.clearTimeout(changeDebounce.get(key));
        changeDebounce.set(
          key,
          window.setTimeout(() => void pullAndPaint(model), 300)
        );
      });
      const disposal = model.onWillDispose(() => {
        window.clearTimeout(changeDebounce.get(key));
        changeDebounce.delete(key);
        clearSemanticTokenDecorations(model);
        sub.dispose();
        disposal.dispose();
      });
      contributions.push(sub, disposal);
    };
    monaco.editor.getModels().forEach(watchModelEdits);
    contributions.push(monaco.editor.onDidCreateModel(watchModelEdits));
  }

  if (contributions.length > 0) {
    // Watch every editor (current + future) so a served model becoming visible
    // re-pulls its tokens — the deterministic backstop for the enable/refresh
    // race that otherwise needs a manual tab switch.
    monaco.editor.getEditors().forEach((editor) => {
      contributions.push(watchModelBecomesVisible(editor));
    });
    contributions.push(
      monaco.editor.onDidCreateEditor((editor) => {
        contributions.push(watchModelBecomesVisible(editor));
      })
    );

    // Roslyn initially returns frozen/partial semantic classifications while
    // projects are loading. It later asks the client to invalidate semantic
    // tokens through this request. The native SemanticTokensFeature was
    // neutralized before start() (see disableNativeClientFeature), so route the
    // refresh to our direct Monaco provider — we are the only provider now.
    client.onRequest("workspace/semanticTokens/refresh", () => {
      lspLog("semantic tokens refresh requested by", serverId);
      fireRefreshNowAndDeferred();
      return null;
    });

    // DIAG: which token-refresh paths the server announced. On v10 the native
    // DiagnosticFeature is neutralized (the manual diagnostics bridge owns pull),
    // so we no longer observe its change emitter — the manual bridge's
    // `workspace/diagnostic/refresh` handler is the live signal for "refs likely
    // resolved", and `stabilizeSemanticTokens` already re-pulls tokens on a
    // backoff until classification settles.
    lspLog(
      "DIAG diagnosticProvider capability",
      serverId,
      client.initializeResult?.capabilities.diagnosticProvider
    );

    contributions.push({ dispose: refresh.dispose });
    clientContributions.set(client, {
      disposables: contributions,
      refreshSemanticTokens: fireRefreshNowAndDeferred,
      enableSemanticTokens: () => {
        if (semanticTokensEnabled) return;
        semanticTokensEnabled = true;
        lspLog("semantic tokens enabled for", serverId);
        fireRefreshNowAndDeferred();
      },
      stabilizeSemanticTokens: repaintUntilStable,
    });
    lspLog("semantic tokens bridge registered for", serverId, {
      full: Boolean(capability.full),
      range: Boolean(capability.range),
      tokenTypes: legend.tokenTypes.length,
    });
  }
}
