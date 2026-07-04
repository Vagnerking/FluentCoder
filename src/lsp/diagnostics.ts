import * as monaco from "monaco-editor";
import type { MonacoLanguageClient } from "monaco-languageclient";
import type { DocumentSelector } from "vscode-languageclient";
import { CancellationTokenSource } from "vscode-jsonrpc";
import type { Problem } from "../types";
import { lspLog } from "./debug";
import {
  shouldUsePullDiagnostics,
  type DiagnosticMode,
} from "./diagnosticMode";
import { setDiagnostics, clearServerDiagnostics } from "./diagnosticsStore";
import { fromFileUri } from "./uri";

/**
 * Diagnostics bridge (issue #10).
 *
 * monaco-languageclient 1.x + the vanilla monaco build don't surface LSP
 * diagnostics as Monaco markers on their own (the same compatibility gap the
 * semantic-tokens and references bridges work around). Without this, Roslyn
 * computes the errors but nothing reaches the editor — no squiggle, no Problems
 * entry. So we bridge diagnostics straight to `monaco.editor.setModelMarkers`,
 * owned by `serverId` (which de-duplicates per server), covering both delivery
 * models:
 *
 * - PUSH (`textDocument/publishDiagnostics`): TS server, Razor/rzls, etc. — the
 *   server sends diagnostics unprompted; we apply them on arrival.
 * - PULL (`textDocument/diagnostic`): Roslyn — the client must request them. We
 *   pull on open, on content change (debounced), and when the server asks for a
 *   refresh, then apply the result.
 */

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspDiagnostic {
  range: LspRange;
  /** 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  /** 1=Unnecessary, 2=Deprecated. */
  tags?: number[];
}
interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}
/** A `textDocument/diagnostic` (pull) report — full list or "unchanged". */
type DocumentDiagnosticReport =
  | {
      kind: "full";
      resultId?: string;
      items: LspDiagnostic[];
      /** Diagnostics for *other* documents the server volunteered. */
      relatedDocuments?: Record<string, DocumentDiagnosticReport>;
    }
  | { kind: "unchanged"; resultId: string };

const DEBOUNCE_MS = 250;

function toMonacoSeverity(sev?: number): monaco.MarkerSeverity {
  switch (sev) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
}

function toMonacoTags(tags?: number[]): monaco.MarkerTag[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  const out: monaco.MarkerTag[] = [];
  for (const t of tags) {
    if (t === 1) out.push(monaco.MarkerTag.Unnecessary);
    else if (t === 2) out.push(monaco.MarkerTag.Deprecated);
  }
  return out.length ? out : undefined;
}

/** Converts an LSP `Diagnostic` (0-based ranges) to a Monaco marker (1-based). */
function toMarker(d: LspDiagnostic): monaco.editor.IMarkerData {
  return {
    severity: toMonacoSeverity(d.severity),
    message: d.message,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    tags: toMonacoTags(d.tags),
  };
}

/** Problems-panel severity (only error/warning/info; hint folds into info). */
function toProblemSeverity(sev?: number): Problem["severity"] {
  switch (sev) {
    case 1:
      return "error";
    case 2:
      return "warning";
    default:
      return "info";
  }
}

/** Converts an LSP diagnostic to a Problems-panel row. */
function toProblem(d: LspDiagnostic, uri: string): Problem {
  // Convert file URI to filesystem path so it matches the paths stored in
  // OpenFile.path (used by tabs and the explorer). Without this, `file:///c:/...`
  // (URI) never equals `C:\...` (filesystem path) and decorations never apply.
  const path = fromFileUri(uri);
  return {
    path,
    name: path.split(/[\\/]/).pop() || path,
    severity: toProblemSeverity(d.severity),
    message: d.message,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
  };
}

/**
 * Records diagnostics for `uri`: applies squiggles when the file is open (a
 * Monaco model exists) AND feeds the workspace-wide store (issue #6) so the
 * Problems panel sees them even for files that aren't open. An empty list clears
 * both. Owned by `serverId`.
 */
function recordDiagnostics(
  uri: string,
  serverId: string,
  diagnostics: LspDiagnostic[]
): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model) {
    monaco.editor.setModelMarkers(model, serverId, diagnostics.map(toMarker));
  }
  setDiagnostics(serverId, uri, diagnostics.map((d) => toProblem(d, uri)));
}

/** Pulls the languages this client serves out of its document selector. */
function selectorLanguages(selector: DocumentSelector): Set<string> {
  const langs = new Set<string>();
  const list = Array.isArray(selector) ? selector : [selector];
  for (const item of list) {
    if (typeof item === "string") langs.add(item);
    else if (item && typeof item === "object" && "language" in item && item.language) {
      langs.add(item.language);
    }
  }
  return langs;
}

/** What {@link installDiagnosticsBridge} returns: teardown disposables plus a
 * hook to invalidate cached result ids and pull every tracked document again. */
export interface DiagnosticsBridge {
  disposables: monaco.IDisposable[];
  repull(): void;
}

export function installDiagnosticsBridge(
  client: MonacoLanguageClient,
  serverId: string,
  selector: DocumentSelector,
  mode: DiagnosticMode = "auto",
  identifiers?: readonly string[]
): DiagnosticsBridge {
  const disposables: monaco.IDisposable[] = [];
  const langs = selectorLanguages(selector);
  const matches = (model: monaco.editor.ITextModel): boolean =>
    model.uri.scheme === "file" && langs.has(model.getLanguageId());
  let repull: (() => void) | undefined;

  // ---- PUSH: textDocument/publishDiagnostics ----
  // Replaces the built-in handler (which doesn't reach markers in this setup)
  // with one that applies markers directly. Wrapped defensively so a client that
  // doesn't accept a late handler can't break startup.
  try {
    disposables.push(
      client.onNotification(
        "textDocument/publishDiagnostics",
        (params: PublishDiagnosticsParams) => {
          recordDiagnostics(params.uri, serverId, params.diagnostics ?? []);
        }
      )
    );
  } catch (err) {
    lspLog("publishDiagnostics listener not installed for", serverId, String(err));
  }

  // ---- PULL: textDocument/diagnostic (Roslyn) ----
  // Roslyn accepts this request but omits `diagnosticProvider` from initialize.
  // Its adapter therefore opts into pull explicitly; `auto` remains capability-
  // based for other servers, while push-only servers install no change listeners.
  const hasStaticPullCapability = Boolean(
    client.initializeResult?.capabilities.diagnosticProvider
  );
  const usePull = shouldUsePullDiagnostics(mode, hasStaticPullCapability);
  if (usePull) {
    // The native DiagnosticFeature was already neutralized before start()
    // (see createLanguageClient → disableNativeClientFeature for
    // `textDocument/diagnostic`), so our direct-to-markers pull below is the
    // sole diagnostics source for this server — no duplicate markers, and the
    // per-`serverId` owner dedup stays intact.

    const pullIdentifiers: Array<string | undefined> =
      identifiers && identifiers.length > 0 ? [...identifiers] : [undefined];
    const resultKey = (uri: string, identifier?: string): string =>
      `${uri}\u0000${identifier ?? ""}`;
    const previousResultId = new Map<string, string>();
    const diagnosticsByIdentifier = new Map<
      string,
      Map<string, LspDiagnostic[]>
    >();
    const requestSeq = new Map<string, number>();
    const debounce = new Map<string, number>();
    const changeSubs = new Map<string, monaco.IDisposable>();
    interface PullState {
      model: monaco.editor.ITextModel;
      running: boolean;
      queued: boolean;
      stopped: boolean;
      cancellation?: CancellationTokenSource;
    }
    const pullStates = new Map<string, PullState>();

    const recordMergedDiagnostics = (uri: string): void => {
      const buckets = diagnosticsByIdentifier.get(uri);
      if (!buckets) {
        recordDiagnostics(uri, serverId, []);
        return;
      }

      const unique = new Map<string, LspDiagnostic>();
      for (const diagnostics of buckets.values()) {
        for (const diagnostic of diagnostics) {
          const { start, end } = diagnostic.range;
          const key = [
            diagnostic.code ?? "",
            diagnostic.message,
            start.line,
            start.character,
            end.line,
            end.character,
          ].join("\u0000");
          unique.set(key, diagnostic);
        }
      }
      recordDiagnostics(uri, serverId, [...unique.values()]);
    };

    const applyReport = (
      uri: string,
      identifier: string | undefined,
      report: DocumentDiagnosticReport
    ): void => {
      const key = resultKey(uri, identifier);
      if (report.kind === "unchanged") {
        if (report.resultId) previousResultId.set(key, report.resultId);
        return; // markers stay as they were
      }
      if (report.resultId) previousResultId.set(key, report.resultId);
      else previousResultId.delete(key);

      let buckets = diagnosticsByIdentifier.get(uri);
      if (!buckets) {
        buckets = new Map();
        diagnosticsByIdentifier.set(uri, buckets);
      }
      buckets.set(identifier ?? "", report.items ?? []);
      recordMergedDiagnostics(uri);

      // Some servers volunteer diagnostics for related documents in one report.
      if (report.relatedDocuments) {
        for (const [relUri, rel] of Object.entries(report.relatedDocuments)) {
          applyReport(relUri, identifier, rel);
        }
      }
    };

    const drainPulls = async (
      uri: string,
      state: PullState
    ): Promise<void> => {
      state.running = true;
      try {
        do {
          state.queued = false;
          if (state.stopped || state.model.isDisposed()) return;

          const cancellation = new CancellationTokenSource();
          state.cancellation = cancellation;
          const seq = (requestSeq.get(uri) ?? 0) + 1;
          requestSeq.set(uri, seq);

          try {
            for (const identifier of pullIdentifiers) {
              const startedAt = performance.now();
              const key = resultKey(uri, identifier);
              const report = await client.sendRequest<DocumentDiagnosticReport>(
                "textDocument/diagnostic",
                {
                  textDocument: { uri },
                  identifier,
                  previousResultId: previousResultId.get(key),
                },
                cancellation.token
              );
              // Canceled/stale reports belong to an older buffer snapshot.
              if (
                cancellation.token.isCancellationRequested ||
                requestSeq.get(uri) !== seq ||
                state.stopped
              ) {
                break;
              }
              applyReport(uri, identifier, report);

              const elapsedMs = Math.round(performance.now() - startedAt);
              if (elapsedMs >= 1_000) {
                lspLog("slow diagnostic pull", serverId, {
                  identifier: identifier ?? "all",
                  elapsedMs,
                  uri,
                });
              }
            }
          } catch (err) {
            if (!cancellation.token.isCancellationRequested && !state.stopped) {
              lspLog("pull diagnostics failed for", serverId, String(err));
            }
          } finally {
            if (state.cancellation === cancellation) {
              state.cancellation = undefined;
            }
            cancellation.dispose();
          }
        } while (state.queued && !state.stopped);
      } finally {
        state.running = false;
      }
    };

    const pull = (model: monaco.editor.ITextModel): void => {
      // Wire uri via o conversor do cliente: o sync nativo abre docs com o colon
      // do drive percent-encoded (c%3A); um toString() cru (c:) mira um doc que o
      // Roslyn não rastreia → pulls vazios/erros silenciosos.
      const uri = client.code2ProtocolConverter.asUri(model.uri as never);
      let state = pullStates.get(uri);
      if (!state) {
        state = {
          model,
          running: false,
          queued: false,
          stopped: false,
        };
        pullStates.set(uri, state);
      } else {
        state.model = model;
        state.stopped = false;
      }

      if (state.running) {
        // Roslyn may spend seconds on analyzers. Abort the obsolete snapshot and
        // keep exactly one follow-up pull for the newest document version.
        state.queued = true;
        state.cancellation?.cancel();
        return;
      }

      void drainPulls(uri, state);
    };

    const schedulePull = (model: monaco.editor.ITextModel): void => {
      // Wire uri via o conversor do cliente: o sync nativo abre docs com o colon
      // do drive percent-encoded (c%3A); um toString() cru (c:) mira um doc que o
      // Roslyn não rastreia → pulls vazios/erros silenciosos.
      const uri = client.code2ProtocolConverter.asUri(model.uri as never);
      const prev = debounce.get(uri);
      if (prev) window.clearTimeout(prev);
      debounce.set(
        uri,
        window.setTimeout(() => {
          debounce.delete(uri);
          pull(model);
        }, DEBOUNCE_MS)
      );
    };

    const track = (model: monaco.editor.ITextModel): void => {
      if (!matches(model)) return;
      // Wire uri via o conversor do cliente: o sync nativo abre docs com o colon
      // do drive percent-encoded (c%3A); um toString() cru (c:) mira um doc que o
      // Roslyn não rastreia → pulls vazios/erros silenciosos.
      const uri = client.code2ProtocolConverter.asUri(model.uri as never);
      if (!changeSubs.has(uri)) {
        changeSubs.set(uri, model.onDidChangeContent(() => schedulePull(model)));
      }
      pull(model); // initial pull for the freshly-tracked document
    };

    const untrack = (uri: string): void => {
      changeSubs.get(uri)?.dispose();
      changeSubs.delete(uri);
      for (const identifier of pullIdentifiers) {
        previousResultId.delete(resultKey(uri, identifier));
      }
      diagnosticsByIdentifier.delete(uri);
      requestSeq.delete(uri);
      const state = pullStates.get(uri);
      if (state) {
        state.stopped = true;
        state.queued = false;
        state.cancellation?.cancel();
        pullStates.delete(uri);
      }
      const t = debounce.get(uri);
      if (t) window.clearTimeout(t);
      debounce.delete(uri);
    };

    for (const model of monaco.editor.getModels()) track(model);
    disposables.push(monaco.editor.onDidCreateModel((model) => track(model)));
    disposables.push(
      monaco.editor.onWillDisposeModel((model) => untrack(model.uri.toString()))
    );

    const pullAll = (resetPreviousResults: boolean): void => {
      if (resetPreviousResults) previousResultId.clear();
      for (const model of monaco.editor.getModels()) {
        if (matches(model)) pull(model);
      }
    };

    // The server asks the client to re-pull everything (e.g. after a build or
    // project load changes diagnostics it already reported).
    try {
      disposables.push(
        client.onRequest("workspace/diagnostic/refresh", () => {
          pullAll(false);
          return null;
        })
      );
    } catch (err) {
      lspLog("diagnostic refresh handler not installed for", serverId, String(err));
    }

    // Tear down per-model subscriptions and pending timers on client dispose.
    disposables.push({
      dispose: () => {
        changeSubs.forEach((s) => s.dispose());
        changeSubs.clear();
        debounce.forEach((t) => window.clearTimeout(t));
        debounce.clear();
        pullStates.forEach((state) => {
          state.stopped = true;
          state.queued = false;
          state.cancellation?.cancel();
        });
        pullStates.clear();
      },
    });

    // A document rebind changes the Roslyn project context. Discard result ids
    // from the old snapshot before asking again, and let request sequencing drop
    // any older response that is still in flight.
    repull = () => pullAll(true);

    lspLog("diagnostics bridge: pull enabled for", serverId, {
      mode,
      staticCapability: hasStaticPullCapability,
    });
  } else {
    lspLog("diagnostics bridge: push-only for", serverId, { mode });
  }

  // On teardown (restart / workspace switch), drop this server's diagnostics from
  // the workspace store AND clear its editor markers, so neither the Problems
  // panel nor the squiggles keep stale rows (CodeRabbit).
  disposables.push({
    dispose: () => {
      clearServerDiagnostics(serverId);
      for (const model of monaco.editor.getModels()) {
        monaco.editor.setModelMarkers(model, serverId, []);
      }
    },
  });

  return {
    disposables,
    repull: () => repull?.(),
  };
}
