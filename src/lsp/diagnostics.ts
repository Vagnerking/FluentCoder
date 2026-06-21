import * as monaco from "monaco-editor";
import type { MonacoLanguageClient } from "monaco-languageclient";
import type { DocumentSelector } from "vscode-languageclient";
import type { Problem } from "../types";
import { lspLog } from "./debug";
import { setDiagnostics, clearServerDiagnostics } from "./diagnosticsStore";

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

const DEBOUNCE_MS = 400;

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

/** Converts an LSP diagnostic to a Problems-panel row (path mirrors Monaco's). */
function toProblem(d: LspDiagnostic, uri: string): Problem {
  const path = monaco.Uri.parse(uri).path;
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

export function installDiagnosticsBridge(
  client: MonacoLanguageClient,
  serverId: string,
  selector: DocumentSelector
): monaco.IDisposable[] {
  const disposables: monaco.IDisposable[] = [];
  const langs = selectorLanguages(selector);
  const matches = (model: monaco.editor.ITextModel): boolean =>
    model.uri.scheme === "file" && langs.has(model.getLanguageId());

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
  const diagnosticProvider =
    client.initializeResult?.capabilities.diagnosticProvider;
  if (diagnosticProvider) {
    // One semantic provider per language: drop the compatibility-shim pull
    // feature so it can't compete with our direct-to-markers pull. The client
    // already announced the `textDocument.diagnostic` capability at initialize.
    try {
      client.getFeature("textDocument/diagnostic")?.dispose();
    } catch {
      /* feature absent or not disposable — ignore */
    }

    const previousResultId = new Map<string, string>();
    const requestSeq = new Map<string, number>();
    const debounce = new Map<string, number>();
    const changeSubs = new Map<string, monaco.IDisposable>();

    const applyReport = (uri: string, report: DocumentDiagnosticReport): void => {
      if (report.kind === "unchanged") {
        if (report.resultId) previousResultId.set(uri, report.resultId);
        return; // markers stay as they were
      }
      if (report.resultId) previousResultId.set(uri, report.resultId);
      else previousResultId.delete(uri);
      recordDiagnostics(uri, serverId, report.items ?? []);
      // Some servers volunteer diagnostics for related documents in one report.
      if (report.relatedDocuments) {
        for (const [relUri, rel] of Object.entries(report.relatedDocuments)) {
          applyReport(relUri, rel);
        }
      }
    };

    const pull = async (model: monaco.editor.ITextModel): Promise<void> => {
      const uri = model.uri.toString();
      const seq = (requestSeq.get(uri) ?? 0) + 1;
      requestSeq.set(uri, seq);
      try {
        const report = await client.sendRequest<DocumentDiagnosticReport>(
          "textDocument/diagnostic",
          {
            textDocument: { uri },
            previousResultId: previousResultId.get(uri),
          }
        );
        // A newer pull for this doc started while we waited — drop the stale one.
        if (requestSeq.get(uri) !== seq) return;
        applyReport(uri, report);
      } catch (err) {
        lspLog("pull diagnostics failed for", serverId, String(err));
      }
    };

    const schedulePull = (model: monaco.editor.ITextModel): void => {
      const uri = model.uri.toString();
      const prev = debounce.get(uri);
      if (prev) window.clearTimeout(prev);
      debounce.set(
        uri,
        window.setTimeout(() => {
          debounce.delete(uri);
          void pull(model);
        }, DEBOUNCE_MS)
      );
    };

    const track = (model: monaco.editor.ITextModel): void => {
      if (!matches(model)) return;
      const uri = model.uri.toString();
      if (!changeSubs.has(uri)) {
        changeSubs.set(uri, model.onDidChangeContent(() => schedulePull(model)));
      }
      void pull(model); // initial pull for the freshly-tracked document
    };

    const untrack = (uri: string): void => {
      changeSubs.get(uri)?.dispose();
      changeSubs.delete(uri);
      previousResultId.delete(uri);
      requestSeq.delete(uri);
      const t = debounce.get(uri);
      if (t) window.clearTimeout(t);
      debounce.delete(uri);
    };

    for (const model of monaco.editor.getModels()) track(model);
    disposables.push(monaco.editor.onDidCreateModel((model) => track(model)));
    disposables.push(
      monaco.editor.onWillDisposeModel((model) => untrack(model.uri.toString()))
    );

    // The server asks the client to re-pull everything (e.g. after a build /
    // project load changes diagnostics it already reported).
    try {
      disposables.push(
        client.onRequest("workspace/diagnostic/refresh", () => {
          for (const model of monaco.editor.getModels()) {
            if (matches(model)) void pull(model);
          }
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
      },
    });

    lspLog("diagnostics bridge: pull enabled for", serverId);
  } else {
    lspLog("diagnostics bridge: push-only for", serverId);
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

  return disposables;
}
