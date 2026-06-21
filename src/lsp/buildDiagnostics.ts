import * as monaco from "monaco-editor";
import { csharpBuildDiagnostics } from "../api";
import { toFileUri } from "./uri";
import { setDiagnostics, clearServerDiagnostics } from "./diagnosticsStore";
import type { Problem } from "../types";

/**
 * Build-diagnostics bridge (issue #11): runs `dotnet build` and surfaces its
 * errors/warnings as editor markers (squiggles) + Problems-panel rows. This is
 * the pragmatic ground-truth path for C#/Razor diagnostics — the real compiler,
 * independent of the fragile LSP cohost. Owned by `OWNER` so it de-duplicates and
 * clears cleanly on each rebuild.
 */
const OWNER = "dotnet-build";

let running = false;
let queued = false;

/**
 * Runs a build and refreshes the build markers/Problems for the whole workspace.
 * Coalesces concurrent calls (one in flight, at most one queued) so rapid saves
 * don't pile up builds.
 */
export async function runBuildDiagnostics(rootPath: string): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    await build(rootPath);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void runBuildDiagnostics(rootPath);
    }
  }
}

async function build(rootPath: string): Promise<void> {
  let diags;
  try {
    diags = await csharpBuildDiagnostics(rootPath);
  } catch {
    // dotnet missing / not a .NET workspace — leave existing markers untouched.
    return;
  }

  // Group by file URI (matching how Monaco models are keyed).
  const byUri = new Map<string, Problem[]>();
  for (const d of diags) {
    const uri = toFileUri(d.path);
    const list = byUri.get(uri) ?? [];
    list.push({
      path: monaco.Uri.parse(uri).path,
      name: d.path.split(/[\\/]/).pop() || d.path,
      severity: d.severity === "error" ? "error" : "warning",
      message: `${d.message} (${d.code})`,
      line: d.line,
      column: d.column,
    });
    byUri.set(uri, list);
  }

  // Refresh the workspace store: drop the previous build's rows, set the new.
  clearServerDiagnostics(OWNER);
  for (const [uri, problems] of byUri) setDiagnostics(OWNER, uri, problems);

  // Squiggles on every open model (set, or clear when a file is now clean).
  for (const model of monaco.editor.getModels()) {
    const problems = byUri.get(model.uri.toString()) ?? [];
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      problems.map((p) => ({
        severity:
          p.severity === "error"
            ? monaco.MarkerSeverity.Error
            : monaco.MarkerSeverity.Warning,
        message: p.message,
        startLineNumber: p.line,
        startColumn: p.column,
        endLineNumber: p.line,
        endColumn: Math.max(p.column + 1, model.getLineMaxColumn(Math.min(p.line, model.getLineCount()))),
      }))
    );
  }
}

/** Clears all build markers + store rows (e.g. when the workspace closes). */
export function clearBuildDiagnostics(): void {
  clearServerDiagnostics(OWNER);
  for (const model of monaco.editor.getModels()) {
    monaco.editor.setModelMarkers(model, OWNER, []);
  }
}
