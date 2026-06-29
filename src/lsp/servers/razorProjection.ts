/**
 * CSHTML projection language server (ADR 0002, brick 6) — feature-flagged.
 *
 * The Roslyn cohost cannot serve `.cshtml` headless (the Razor source generator
 * never runs OOP — see `tools/razor-lsp-probe/FINDINGS-fase0.md`). This starter
 * implements the proven alternative: the Rust broker emits a projected `.g.cs`
 * (with `#line` maps) inside a "shadow" project, the **standalone** Roslyn (the
 * same one that serves `.cs`) analyzes it, and this module forwards Monaco
 * requests to the projected C# and remaps results back to the `.cshtml`.
 *
 * Design decisions, each forced by a MEASURED fact (not assumed):
 *  - **Projection client mode** (`suppressGenericBridges`): a second client over
 *    a `csharp` selector would register competing providers for every real `.cs`
 *    model. We drive requests manually via `sendRequest` instead (Codex fix #1).
 *  - **Remap every result range**: `spike-b1d` proved diagnostics/hover come back
 *    in `.g.cs` coordinates, so each range is remapped generated→source and
 *    dropped if synthetic (`razorProjectionRouting`).
 *  - **Diagnostics owner `fluent-cshtml`**: the normative owner reserved for
 *    `.cshtml` in `docs/context/cshtml-language-service.md` (Codex fix #5).
 *  - **LspManager-owned lifecycle**: every provider/timer/`.g.cs` open is a
 *    session disposable registered on the client, so "Resetar Servidores de
 *    Código" / workspace switch / StrictMode tear it all down (Codex fix #7).
 */
import * as monaco from "monaco-editor";
import type { MonacoLanguageClient } from "monaco-languageclient";
import {
  ensureCsharpServer,
  listProjectFiles,
  razorCommitLiveMap,
  razorEmitLive,
  razorEnsureSidecar,
  razorForget,
  razorPrepare,
  razorRemapToGenerated,
  razorRemapToSource,
  razorWarm,
  readFile,
  startLspServer,
  type RazorProjectionInfo,
} from "../../api";
import { createLanguageClient, registerClientDisposables } from "../client";
import { lspLog } from "../debug";
import { canonicalFileUriKey, fromFileUri, toFileUri } from "../uri";
import { setDiagnostics, clearServerDiagnostics } from "../diagnosticsStore";
import type { Problem } from "../../types";
import {
  htmlComplete,
  htmlHover,
  htmlTagComplete,
  htmlRegionAt,
  forgetHtmlVirtual,
  forgetAllHtmlVirtual,
} from "./cshtmlHtmlService";
import { wireRoslynStartup } from "./roslynShared";
import { ROSLYN_INIT_OPTIONS } from "./csharp";
import {
  pickProjectForCshtml,
  relativize,
  remapRangeToMonaco,
  routeDefinition,
  routeDiagnostics,
  type RemapFn,
} from "./razorProjectionRouting";
import type { ServerStartContext } from ".";

export const RAZOR_PROJECTION_SERVER_ID = "razor-projection";
/** Monaco language id `.cshtml` gets when the projection flag is ON. */
export const CSHTML_PROJECTION_LANGUAGE_ID = "cshtml";
/** Marker owner reserved for `.cshtml` (docs/context/cshtml-language-service.md). */
const DIAGNOSTICS_OWNER = "fluent-cshtml";
/** Build configuration the broker emits/locates the projection under. */
const CONFIG = "Debug";
/**
 * Re-prepare debounce. The broker regenerates from DISK (`dotnet build`), so we
 * reprepare on save / open — never on dirty in-memory edits, which would rebuild
 * stale content. The debounce only coalesces bursts (e.g. "Save all"). V1 thus
 * surfaces semantics "as of last save", like build-based diagnostics.
 */
const REPREPARE_DEBOUNCE_MS = 500;
/**
 * Backoff for re-pulling diagnostics. The shadow's Roslyn returns empty until its
 * background compilation finishes (seconds after `projectInitializationComplete`),
 * so the schedule must outlast that warmup — early-only retries miss the result
 * and the squiggle never appears. Each pull re-publishes, so a late non-empty
 * result corrects an earlier empty one.
 */
const DIAGNOSTIC_RETRY_MS = [800, 2000, 4000, 7000, 11000, 16000, 22000];

/** A `.cshtml` being served, paired with its projected `.g.cs`. */
interface ProjectionDoc {
  cshtmlPath: string; // absolute (key the razor_remap_* commands expect)
  cshtmlUri: string; // Monaco model uri
  gcsUri: string; // file:// uri of the projected `.g.cs` (Roslyn addresses this)
  gcsVersion: number; // didOpen/didChange version counter
  // The Monaco model version that the CURRENTLY committed map + open `.g.cs`
  // reflect. -1 = unknown (just opened from disk). Providers compare this to the
  // live model version to detect a stale projection and refresh before querying,
  // so the map / open `.g.cs` / buffer are always one consistent snapshot.
  committedSourceVersion: number;
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Monaco `MarkerSeverity` (8=Error, 4=Warning, else info) → `Problem.severity`. */
function severityFromMonaco(sev: number): Problem["severity"] {
  if (sev >= 8) return "error";
  if (sev >= 4) return "warning";
  return "info";
}

/** Convert routed `.cshtml` markers to workspace-store `Problem`s for one file. */
function markersToProblems(
  cshtmlPath: string,
  markers: readonly { severity: number; message: string; startLineNumber: number; startColumn: number }[]
): Problem[] {
  const name = cshtmlPath.split(/[\\/]/).pop() || cshtmlPath;
  return markers.map((m) => ({
    path: cshtmlPath,
    name,
    severity: severityFromMonaco(m.severity),
    message: m.message,
    line: m.startLineNumber,
    column: m.startColumn,
  }));
}

/** Minimal subset of the open `.cshtml` we need to (re)prepare a project. */
function openCshtmlModels(): monaco.editor.ITextModel[] {
  return monaco.editor
    .getModels()
    .filter(
      (m) =>
        !m.isDisposed() &&
        m.getLanguageId() === CSHTML_PROJECTION_LANGUAGE_ID &&
        m.uri.scheme === "file"
    );
}

/** How long the projection start waits for the first `.cshtml` model to appear
 * before giving up — covers the boot/session-restore race where the manager
 * starts the server before Monaco has created the restored tab's model. */
const CSHTML_MODEL_WAIT_MS = 15_000;

/**
 * Resolves with the open `.cshtml` models, waiting up to {@link CSHTML_MODEL_WAIT_MS}
 * for the first one if none exist yet. On boot the LspManager may start this
 * server (driven by `openedLanguages`) before the restored `.cshtml` tab's Monaco
 * model is created; throwing "no .cshtml open" there would leave the server in an
 * error state that never recovers without re-focusing the tab. Waiting closes
 * that race so the projection comes up on the first boot, not the second visit.
 */
async function awaitCshtmlModels(): Promise<monaco.editor.ITextModel[]> {
  const present = openCshtmlModels();
  if (present.length > 0) return present;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      sub.dispose();
      clearTimeout(timer);
      resolve(openCshtmlModels());
    };
    const sub = monaco.editor.onDidCreateModel((m) => {
      if (
        m.getLanguageId() === CSHTML_PROJECTION_LANGUAGE_ID &&
        m.uri.scheme === "file"
      ) {
        finish();
      }
    });
    const timer = setTimeout(finish, CSHTML_MODEL_WAIT_MS);
  });
}

/** Longest-prefix `.csproj` that contains `cshtmlPath`, or null (loose file). */
async function resolveProject(
  rootPath: string,
  cshtmlPath: string
): Promise<{ projectDir: string; csprojPath: string } | null> {
  const files = await listProjectFiles(rootPath);
  return pickProjectForCshtml(
    files.filter((f) => f.name.toLowerCase().endsWith(".csproj")).map((f) => f.path),
    cshtmlPath
  );
}

/**
 * Brings up the CSHTML projection server for `rootPath`. Returns a live client
 * the {@link LspManager} owns; all Monaco providers, watchers and timers are
 * registered as the client's disposables so they tear down with it.
 */
export async function startRazorProjectionServer(
  rootPath: string,
  context?: ServerStartContext
): Promise<MonacoLanguageClient> {
  // 1. Resolve the project from the first open `.cshtml` and prepare its peers.
  // Wait briefly for the model on boot: the manager can start us (from
  // `openedLanguages`) before Monaco has created the restored tab's model.
  const models = await awaitCshtmlModels();
  if (models.length === 0) {
    throw new Error("razor projection: no .cshtml open to serve");
  }
  const firstPath = fromFileUri(models[0].uri.toString());
  const project = await resolveProject(rootPath, firstPath);
  if (!project) {
    throw new Error(
      "razor projection: no .csproj found for the open .cshtml (open a project, not a loose file)"
    );
  }
  const { projectDir, csprojPath } = project;
  const projectDirKey = projectDir.replace(/\\/g, "/").toLowerCase() + "/";
  const inThisProject = (path: string): boolean =>
    path.replace(/\\/g, "/").toLowerCase().startsWith(projectDirKey);

  // Only serve `.cshtml` that belong to this project (V1 = single project/solution).
  const inProject = models.filter((m) => inThisProject(fromFileUri(m.uri.toString())));
  const cshtmlRels = inProject.map((m) => relativize(projectDir, fromFileUri(m.uri.toString())));

  lspLog("razor projection: preparing", { projectDir, count: cshtmlRels.length });
  const prepared = await razorPrepare({
    workspaceDir: rootPath,
    userProjectDir: projectDir,
    userCsprojPath: csprojPath,
    config: CONFIG,
    cshtmlRels,
  });
  lspLog("razor projection: prepared", {
    solutionPath: prepared.solutionPath,
    available: prepared.available.length,
    missing: prepared.missing.length,
  });

  // 2. Launch the standalone Roslyn (pure C# over the shadow) + the client.
  const command = await ensureCsharpServer(rootPath);
  const [program, ...args] = command.split("\n").filter((s) => s.length > 0);
  if (!program) throw new Error("razor projection: C# server launch command was empty");
  await startLspServer(RAZOR_PROJECTION_SERVER_ID, program, args, rootPath);

  const client = await createLanguageClient({
    serverId: RAZOR_PROJECTION_SERVER_ID,
    name: "Razor Projection Language Client",
    // Non-matching selector: the base client must not attach built-in providers
    // to any real Monaco model. We drive every request manually via sendRequest.
    documentSelector: [{ scheme: "file", language: "__razor_projection_never__" }],
    rootUri: toFileUri(rootPath),
    initializationOptions: ROSLYN_INIT_OPTIONS,
    suppressGenericBridges: true,
  });

  // 3. Session state + disposables (all torn down on manager.stop).
  const docs = new Map<string, ProjectionDoc>(); // key: canonicalFileUriKey(cshtmlUri)
  const sentText = new Map<string, string>(); // gcsUri -> text CURRENTLY open in Roslyn
  const disposables: monaco.IDisposable[] = [];
  const reprepareTimers = new Map<string, number>();
  let disposed = false;

  // Per-`.g.cs` mutation queue. EVERY close/open of a generated doc — the normal
  // sync (openProjection) AND the provisional-completion swap — runs through here,
  // serialized per gcsUri, so the two never interleave and `sentText` always
  // reflects exactly what Roslyn has open. didChange crashes this Roslyn, so all
  // content changes are close+open.
  const genChain = new Map<string, Promise<unknown>>();
  const mutateGenerated = <T>(gcsUri: string, op: () => Promise<T>): Promise<T> => {
    const prev = genChain.get(gcsUri) ?? Promise.resolve();
    const next = prev.then(op, op);
    genChain.set(gcsUri, next.then(() => undefined, () => undefined));
    return next;
  };

  // Per-DOC snapshot queue (keyed by canonicalFileUriKey(cshtmlUri)): serializes
  // EVERY op that changes the doc's snapshot (map + open `.g.cs` + committed
  // version) — the live sync, the provider-triggered ensureFresh sync, AND the
  // authoritative open/save reprepare (openProjection). So no two ever leave the
  // snapshot half-applied, and a provider never reasons about freshness mid-swap.
  const syncChains = new Map<string, Promise<unknown>>();
  const enqueueSync = <T>(key: string, op: () => Promise<T>): Promise<T> => {
    const prev = syncChains.get(key) ?? Promise.resolve();
    const next = prev.then(op, op);
    syncChains.set(key, next.then(() => undefined, () => undefined));
    return next;
  };

  /**
   * Make Roslyn's open copy of `gcsUri` exactly `text` (close+open). Idempotent by
   * the `sentText` shortcut, EXCEPT when `force` — save/reprepare forces a real
   * close+open even if `sentText` claims it matches, so a half-applied provisional
   * swap or a desynced restore can never leave Roslyn on stale text (recovery
   * boundary).
   */
  const setGeneratedText = (gcsUri: string, text: string, force = false): Promise<void> =>
    mutateGenerated(gcsUri, async () => {
      if (disposed) return;
      if (!force && sentText.get(gcsUri) === text) return; // already in sync
      const wasOpen = sentText.has(gcsUri);
      // While the close/open is in flight `sentText` is unknown; clear it so a
      // mid-way `didOpen` rejection can't leave it claiming the wrong text (the
      // next op then re-opens from scratch). Set it true only after didOpen lands.
      sentText.delete(gcsUri);
      if (wasOpen) {
        await client.sendNotification("textDocument/didClose", { textDocument: { uri: gcsUri } });
      }
      await client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: gcsUri, languageId: "csharp", version: 1, text },
      });
      sentText.set(gcsUri, text);
    });

  const remapToSourceFor =
    (cshtmlPath: string): RemapFn =>
    (line, character) =>
      razorRemapToSource(cshtmlPath, line, character);

  const inProjectModelFor = (cshtmlPath: string): monaco.editor.ITextModel | null => {
    const wantKey = canonicalFileUriKey(toFileUri(cshtmlPath));
    return (
      openCshtmlModels().find((m) => canonicalFileUriKey(m.uri.toString()) === wantKey) ?? null
    );
  };

  /**
   * Sync a prepared projection's `.g.cs` into the Roslyn client and cache its
   * source map binding. The standalone Roslyn throws an NRE and shuts its request
   * queue down when it receives a `textDocument/didChange` for the projected file
   * (observed live), so we NEVER send didChange: a first sync is a `didOpen`, and
   * any later content change is a clean `didClose` + `didOpen`. Identical content
   * is a no-op — so a duplicate `projectInitializationComplete` (Roslyn can send
   * it more than once) doesn't re-sync and churn the server.
   */
  const openProjection = async (info: RazorProjectionInfo): Promise<void> => {
    const model = inProjectModelFor(info.cshtmlPath);
    if (!model) return; // closed meanwhile
    const cshtmlUri = model.uri.toString();
    const key = canonicalFileUriKey(cshtmlUri);
    const gcsUri = toFileUri(info.generatedPath);
    // The version this disk projection represents: prepare ran on open/save when
    // buffer == disk, so the model version captured BEFORE any await is the disk
    // version. If the user edits before the reopen finishes, we DON'T stamp it
    // fresh (leave -1) so ensureFresh re-syncs to the new buffer.
    const prepVersion = model.getVersionId();
    let text = "";
    try {
      text = await readGenerated(info.generatedPath);
    } catch (err) {
      lspLog("razor projection: read .g.cs failed", info.generatedPath, String(err));
      return;
    }
    // Which `.g.cs` (and how big) is being opened in Roslyn — the source map is
    // built from THIS file, so its line count must match the positions Roslyn
    // later reports. A mismatch (e.g. build vs sidecar layout) shows up as the
    // diagnostics landing outside every region (mapped=0).
    lspLog("razor projection: openProjection .g.cs", {
      path: info.generatedPath,
      lines: text.split("\n").length,
    });

    // Run through the per-doc snapshot queue so this authoritative reopen can't
    // interleave with a live sync / provider ensureFresh for the same doc.
    await enqueueSync(key, async () => {
      if (disposed) return;
      const existing = docs.get(key);
      const doc: ProjectionDoc = {
        cshtmlPath: info.cshtmlPath,
        cshtmlUri,
        gcsUri,
        gcsVersion: (existing?.gcsVersion ?? 0) + 1,
        // -1 until the forced reopen completes — providers treat the doc as stale
        // (ensureFresh re-syncs) during the open; never publish fresh before Roslyn
        // actually has the disk text.
        committedSourceVersion: -1,
      };
      docs.set(key, doc);

      // FORCE a real close+open even if `sentText` claims a match — this is the
      // hard recovery boundary after any live/provisional desync (never didChange:
      // it crashes Roslyn). After it, Roslyn definitely has the disk text.
      try {
        await setGeneratedText(gcsUri, text, true);
        // Mark fresh ONLY if the model is STILL at the version this disk projection
        // represents. If the user typed since (model moved past prepVersion), leave
        // it stale (-1) so ensureFresh re-syncs to the new buffer — never stamp a
        // newer buffer version as matching a disk-text projection.
        if (docs.get(key) === doc && model.getVersionId() === prepVersion) {
          doc.committedSourceVersion = prepVersion;
        }
      } catch (err) {
        lspLog("razor projection: didOpen/didClose failed", String(err));
      }
    });
  };

  /** Pull diagnostics for one doc and publish remapped markers to the `.cshtml`. */
  const pullDiagnostics = async (doc: ProjectionDoc): Promise<void> => {
    if (disposed) return;
    let result: { items?: unknown[] } | null = null;
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    try {
      // Serialize against the provisional-completion swap so diagnostics aren't
      // pulled from a temporarily-injected `.g.cs`.
      result = await mutateGenerated(doc.gcsUri, () =>
        client.sendRequest<{ items?: unknown[] } | null>(
          "textDocument/diagnostic",
          { textDocument: { uri: doc.gcsUri } }
        )
      );
    } catch (err) {
      lspLog("razor projection: diagnostic pull failed", String(err));
      return;
    }
    const items = (result?.items ?? []) as Parameters<typeof routeDiagnostics>[0];
    const markers = await routeDiagnostics(items, remapToSourceFor(doc.cshtmlPath));
    // Visibility into the exact point where diagnostics tend to vanish: how many
    // Roslyn returned for the `.g.cs` vs how many survived the `#line` remap onto
    // the `.cshtml`. `pulled>0, mapped=0` ⇒ remap dropped them (source-map/range
    // bug); `pulled=0` ⇒ Roslyn classified nothing (project not loaded / wrong
    // .g.cs / shadow unrestored). Both previously looked identical (silent).
    // `ms` is the Roslyn pull round-trip — surfaces a slow/degraded server.
    const pullMs =
      startedAt > 0 ? Math.round(performance.now() - startedAt) : undefined;
    lspLog("razor projection: diagnostics", {
      cshtml: doc.cshtmlPath,
      pulled: items.length,
      mapped: markers.length,
      ...(pullMs !== undefined ? { ms: pullMs } : {}),
    });
    // Staleness guard: the awaits above (server pull + range remap) yield, so the
    // doc may have been closed (forgetDoc) or replaced (reprepare/reopen) while we
    // were waiting. If so, forgetDoc already cleared this file's markers + store;
    // publishing now would resurrect stale diagnostics on a closed/superseded
    // `.cshtml`. Only publish when this exact doc is still the current entry.
    if (disposed || docs.get(canonicalFileUriKey(doc.cshtmlUri)) !== doc) return;
    const model = monaco.editor.getModel(monaco.Uri.parse(doc.cshtmlUri));
    if (model && !model.isDisposed()) {
      monaco.editor.setModelMarkers(
        model,
        DIAGNOSTICS_OWNER,
        markers as unknown as monaco.editor.IMarkerData[]
      );
    }
    // Also feed the workspace diagnostics store, keyed by the SOURCE `.cshtml`
    // path. This is what drives the Problems panel for non-active files AND the
    // explorer/tab error color (App merges it into `allProblems`). We can't rely
    // on the Monaco-markers→`onProblemsChange` path alone for the file color: the
    // marker carries the model URI, whose path can differ in shape from the git/
    // tree path; the store uses `cshtmlPath`, the same absolute path everything
    // else keys on, so the decoration lookup lines up.
    setDiagnostics(RAZOR_PROJECTION_SERVER_ID, doc.cshtmlPath, markersToProblems(doc.cshtmlPath, markers));
  };

  /** Pull diagnostics for every open doc once. */
  const pullAllOnce = (): void => {
    for (const doc of docs.values()) void pullDiagnostics(doc);
  };

  /** Pull now, then on a backoff that outlasts the shadow's compilation warmup. */
  const pullAllDiagnostics = (): void => {
    pullAllOnce();
    DIAGNOSTIC_RETRY_MS.forEach((ms) => {
      const t = window.setTimeout(() => {
        if (disposed) return;
        pullAllOnce();
      }, ms);
      disposables.push({ dispose: () => window.clearTimeout(t) });
    });
  };

  // Roslyn requests `workspace/diagnostic/refresh` the instant its background
  // compilation completes — the exact moment to re-pull, so the squiggle appears
  // as soon as it's ready instead of waiting on a timed retry. The generic
  // diagnostics bridge is suppressed here, so nothing else owns this handler.
  disposables.push(
    client.onRequest("workspace/diagnostic/refresh", () => {
      pullAllOnce();
      return null;
    })
  );

  // 4. Monaco providers for `.cshtml` (forward to the `.g.cs`, remap results).
  const sel: monaco.languages.LanguageSelector = CSHTML_PROJECTION_LANGUAGE_ID;

  const docFor = (model: monaco.editor.ITextModel): ProjectionDoc | undefined =>
    docs.get(canonicalFileUriKey(model.uri.toString()));

  // 0-based (line,character) → absolute offset in `text` (UTF-16 units).
  const offsetOf = (text: string, line: number, character: number): number => {
    let off = 0;
    for (let l = 0; l < line; l++) {
      const nl = text.indexOf("\n", off);
      if (nl < 0) return text.length;
      off = nl + 1;
    }
    return Math.min(off + character, text.length);
  };

  /**
   * Member completion right after a `.` in a Razor C# expression. Returns the raw
   * LSP items, or null when this isn't a member-completion position (caller falls
   * back to the normal path). See the big comment at the call site.
   */
  const provisionalDotCompletion = async (
    doc: ProjectionDoc,
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
    token: monaco.CancellationToken
  ): Promise<unknown[] | null> => {
    // Trigger only when the char immediately left of the caret is `.` (member
    // access). `@Model.Ci|` (`.` further left) goes through the normal path once
    // the projection already has `Model.Ci`; we target the bare-dot case.
    if (position.column < 2) return null;
    const before = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column - 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    if (before !== ".") return null;

    const gcsUri = doc.gcsUri;
    // The whole remap→swap→complete→restore is ONE queued op, so it can't
    // interleave with a live sync / openProjection / forgetDoc on this gcsUri. We
    // compute `gen` (the expression-end position) INSIDE the op — against the SAME
    // committed map/text that `original` reflects — so the injected dot lands at
    // the right offset even if a live emit committed a new generation just before.
    return mutateGenerated(gcsUri, async (): Promise<unknown[] | null> => {
      if (token.isCancellationRequested || disposed) return null;
      const original = sentText.get(gcsUri);
      if (original == null) return null; // not open — caller falls back

      // Map the expression END (the char just before the `.`) into the `.g.cs`.
      const gen = await razorRemapToGenerated(
        doc.cshtmlPath,
        position.lineNumber - 1,
        position.column - 2
      );
      if (!gen || token.isCancellationRequested || disposed) return null;

      const insertAt = offsetOf(original, gen.line, gen.character);
      // Insertion-point guard: only inject after a plausible expression end (ident
      // char, `)`, `]`, `>`) so we never split a token or inject into junk.
      const prevChar = original[insertAt - 1] ?? "";
      if (!/[A-Za-z0-9_)\]>]/.test(prevChar)) return null;
      const nextChar = original[insertAt] ?? "";
      const provisional =
        nextChar === "."
          ? original
          : original.slice(0, insertAt) + "." + original.slice(insertAt);
      const changed = provisional !== original;
      // Complete just after the (existing or injected) dot.
      const dotEnd = insertAt + 1;
      const head = provisional.slice(0, dotEnd);
      const compLine = head.match(/\n/g)?.length ?? 0;
      const compChar = dotEnd - (head.lastIndexOf("\n") + 1);

      try {
        if (changed) {
          sentText.delete(gcsUri); // unknown during the swap (see setGeneratedText)
          await client.sendNotification("textDocument/didClose", { textDocument: { uri: gcsUri } });
          await client.sendNotification("textDocument/didOpen", {
            textDocument: { uri: gcsUri, languageId: "csharp", version: 1, text: provisional },
          });
          sentText.set(gcsUri, provisional); // keep the invariant truthful
        }
        const res = await client.sendRequest<
          { items?: unknown[]; isIncomplete?: boolean } | unknown[] | null
        >("textDocument/completion", {
          textDocument: { uri: gcsUri },
          position: { line: compLine, character: compChar },
          context: { triggerKind: 2, triggerCharacter: "." },
        });
        if (token.isCancellationRequested) return null; // canceled mid-flight
        return !res ? [] : Array.isArray(res) ? res : res.items ?? [];
      } catch (err) {
        lspLog("razor projection: provisional completion failed", String(err));
        return null;
      } finally {
        // Restore the real generated text so diagnostics/hover see disk again.
        // We're still inside the queued op, so nothing else touched this gcsUri.
        // Restore whenever we changed it and aren't already back at `original`.
        if (changed && !disposed && sentText.get(gcsUri) !== original) {
          try {
            sentText.delete(gcsUri);
            await client.sendNotification("textDocument/didClose", { textDocument: { uri: gcsUri } });
            await client.sendNotification("textDocument/didOpen", {
              textDocument: { uri: gcsUri, languageId: "csharp", version: 1, text: original },
            });
            sentText.set(gcsUri, original);
          } catch {
            /* best-effort restore */
          }
        }
      }
    });
  };

  disposables.push(
    monaco.languages.registerHoverProvider(sel, {
      provideHover: async (model, position, token) => {
        const doc = docFor(model);
        if (!doc) return null;
        // Region-gated, mutually exclusive: in an HTML region we answer from the
        // HTML service and RETURN (even if it has no hover → null), so C# is never
        // queried for an HTML position. Only a Razor/C# region falls through to
        // the .g.cs projection. (Gating on `htmlHover` truthiness alone would let
        // C# run when HTML simply had no hover for that tag.)
        if (htmlRegionAt(model, position) === "html") {
          return htmlHover(model, position);
        }
        // Sync the projection to the current buffer FIRST, so the map + open
        // `.g.cs` match what the user sees (no remap against a stale projection).
        if (token.isCancellationRequested || !(await ensureFresh(doc, model))) return null;
        const snap = doc.committedSourceVersion;
        const reqVersion = model.getVersionId();
        if (token.isCancellationRequested || docFor(model) !== doc) return null;
        const gen = await razorRemapToGenerated(doc.cshtmlPath, position.lineNumber - 1, position.column - 1);
        if (!gen) return null;
        // Serialize through the per-gcsUri queue so the request can't run while a
        // provisional-completion swap has a DIFFERENT `.g.cs` text temporarily open
        // (it would answer against the injected-dot buffer).
        const res = await mutateGenerated(doc.gcsUri, () =>
          client.sendRequest<{ contents?: unknown; range?: LspRange } | null>(
            "textDocument/hover",
            { textDocument: { uri: doc.gcsUri }, position: { line: gen.line, character: gen.character } },
            token
          )
        );
        if (!res || !res.contents || token.isCancellationRequested) return null;
        if (!snapshotStable(doc, model, snap, reqVersion)) return null; // superseded
        let range: monaco.IRange | undefined;
        if (res.range) {
          const r = await remapRangeToMonaco(res.range, remapToSourceFor(doc.cshtmlPath));
          range = r ?? undefined;
        }
        // Re-check AFTER the async remap: a live sync may have committed a newer
        // map mid-remap, which would land the range in the wrong place.
        if (!snapshotStable(doc, model, snap, reqVersion)) return null;
        return { contents: toMarkdown(res.contents), range };
      },
    })
  );

  disposables.push(
    monaco.languages.registerDefinitionProvider(sel, {
      provideDefinition: async (model, position, token) => {
        const doc = docFor(model);
        if (!doc) return null;
        if (token.isCancellationRequested || !(await ensureFresh(doc, model))) return null;
        const snap = doc.committedSourceVersion;
        const reqVersion = model.getVersionId();
        if (token.isCancellationRequested || docFor(model) !== doc) return null;
        const gen = await razorRemapToGenerated(doc.cshtmlPath, position.lineNumber - 1, position.column - 1);
        if (!gen) return null;
        // Serialize against the provisional-completion swap (see hover).
        const res = await mutateGenerated(doc.gcsUri, () =>
          client.sendRequest<unknown>(
            "textDocument/definition",
            { textDocument: { uri: doc.gcsUri }, position: { line: gen.line, character: gen.character } },
            token
          )
        );
        if (token.isCancellationRequested || !snapshotStable(doc, model, snap, reqVersion)) return null;
        const routed = await routeDefinition(res, {
          projectedUriKey: canonicalFileUriKey(doc.gcsUri),
          cshtmlUri: doc.cshtmlUri,
          remapToSource: remapToSourceFor(doc.cshtmlPath),
          uriKey: canonicalFileUriKey,
        });
        // Re-check AFTER the async route/remap (see hover).
        if (!snapshotStable(doc, model, snap, reqVersion)) return null;
        return routed.map((r) => ({ uri: monaco.Uri.parse(r.uri), range: r.range }));
      },
    })
  );

  disposables.push(
    monaco.languages.registerCompletionItemProvider(sel, {
      triggerCharacters: [".", "@", "(", "<", " "],
      provideCompletionItems: async (model, position, _context, token) => {
        const doc = docFor(model);
        if (!doc) return { suggestions: [] };
        // Region-gated, mutually exclusive (same discipline as hover): an HTML
        // region is answered by the HTML service and RETURNS; only a Razor/C#
        // region falls through to the .g.cs projection. No double suggestions.
        if (htmlRegionAt(model, position) === "html") {
          return htmlComplete(monaco, model, position) ?? { suggestions: [] };
        }
        // Sync the projection to the buffer BEFORE provisional/normal completion so
        // both work against the current `.g.cs` (the "delete → completion bugs"
        // fix: provisional must not inject against a stale projection).
        if (token.isCancellationRequested || !(await ensureFresh(doc, model))) {
          return { suggestions: [] };
        }
        const snap = doc.committedSourceVersion;
        const reqVersion = model.getVersionId();
        if (token.isCancellationRequested || docFor(model) !== doc) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        // MEMBER COMPLETION after a `.` ("provisional completion"): the real Razor
        // compiler projects an INCOMPLETE expression `@Model.` as bare `Model` —
        // it drops the trailing dot — so Roslyn sees no member access and returns
        // nothing. We rebind the .g.cs in-memory with the dot injected at the
        // expression end, complete there, then restore. didChange crashes this
        // Roslyn, so we use the same didClose+didOpen lifecycle as openProjection.
        const dotItems = await provisionalDotCompletion(doc, model, position, token);
        if (dotItems) {
          if (!snapshotStable(doc, model, snap, reqVersion)) return { suggestions: [] };
          return {
            suggestions: dotItems.map((it) => toCompletion(it as Record<string, unknown>, range)),
            incomplete: true,
          };
        }

        const gen = await razorRemapToGenerated(doc.cshtmlPath, position.lineNumber - 1, position.column - 1);
        if (!gen) return { suggestions: [] };
        // Serialize against the provisional-completion swap (see hover).
        const res = await mutateGenerated(doc.gcsUri, () =>
          client.sendRequest<
            { items?: unknown[]; isIncomplete?: boolean } | unknown[] | null
          >(
            "textDocument/completion",
            { textDocument: { uri: doc.gcsUri }, position: { line: gen.line, character: gen.character } },
            token
          )
        );
        if (token.isCancellationRequested || !res) return { suggestions: [] };
        if (!snapshotStable(doc, model, snap, reqVersion)) return { suggestions: [] };
        const items = Array.isArray(res) ? res : res.items ?? [];
        return {
          suggestions: items.map((it) => toCompletion(it as Record<string, unknown>, range)),
          incomplete: Array.isArray(res) ? false : Boolean(res.isIncomplete),
        };
      },
    })
  );

  // Auto-close HTML tags: when the user types `>` or `/` in an HTML region of a
  // `.cshtml`, insert the matching close tag (e.g. `<div>` → `</div>`), mirroring
  // VS Code's `html.autoClosingTags`. The HTML service computes the snippet from
  // the virtual HTML; we insert it via snippetController2 so the caret lands at
  // `$0`. Attached per editor (the content event + caret live on the instance).
  const attachAutoClose = (ed: monaco.editor.ICodeEditor): void => {
    const sub = ed.onDidChangeModelContent((e) => {
      if (disposed || e.isFlush || e.changes.length !== 1) return;
      const ch = e.changes[0];
      if (ch.text !== ">" && ch.text !== "/") return;
      const model = ed.getModel();
      if (!model || model.getLanguageId() !== CSHTML_PROJECTION_LANGUAGE_ID) return;
      const pos = ed.getPosition();
      if (!pos || !docFor(model)) return;
      const snippet = htmlTagComplete(model, pos);
      if (!snippet) return;
      // Defer a tick so the snippet insert doesn't fight the in-progress edit.
      const contrib = ed.getContribution("snippetController2") as
        | (monaco.editor.IEditorContribution & { insert?: (t: string) => void })
        | null;
      const uri = model.uri.toString();
      const version = model.getVersionId();
      window.setTimeout(() => {
        // Guard against the user switching tab/model/caret within the tick — only
        // insert if everything is still exactly as it was when `>`/`/` was typed.
        if (disposed || model.isDisposed()) return;
        if (ed.getModel() !== model || model.uri.toString() !== uri) return;
        if (model.getVersionId() !== version) return;
        const now = ed.getPosition();
        if (!now || now.lineNumber !== pos.lineNumber || now.column !== pos.column) return;
        contrib?.insert?.(snippet);
      }, 0);
    });
    disposables.push(sub);
  };
  for (const ed of monaco.editor.getEditors()) attachAutoClose(ed);
  disposables.push(monaco.editor.onDidCreateEditor(attachAutoClose));

  // 5. Lifecycle: watch model open/close/change to (re)prepare and clean up.
  const forgetDoc = (key: string): void => {
    const doc = docs.get(key);
    if (!doc) return;
    docs.delete(key);
    // Close through the per-gcsUri queue so it can't interleave with a sync or a
    // provisional swap; clearing sentText inside keeps the invariant truthful.
    // (genChain keeps one entry per distinct .g.cs ever opened — bounded by the
    // file count, so no unbounded growth; cleared wholesale on dispose.)
    const closingUri = doc.gcsUri;
    void mutateGenerated(closingUri, async () => {
      if (sentText.has(closingUri)) {
        await client.sendNotification("textDocument/didClose", { textDocument: { uri: closingUri } }).catch(() => {});
        sentText.delete(closingUri);
      }
    });
    void razorForget(doc.cshtmlPath).catch(() => {});
    const model = monaco.editor.getModel(monaco.Uri.parse(doc.cshtmlUri));
    if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, DIAGNOSTICS_OWNER, []);
    // Drop this file's store entry too, so a closed `.cshtml` stops coloring the
    // explorer (empty list clears the key).
    setDiagnostics(RAZOR_PROJECTION_SERVER_ID, doc.cshtmlPath, []);
    forgetHtmlVirtual(doc.cshtmlUri); // release the cached virtual HTML doc
    // Drop live-emit bookkeeping for this file.
    const t = liveTimers.get(key);
    if (t) window.clearTimeout(t);
    liveTimers.delete(key);
    syncChains.delete(key);
    liveBroken.delete(key);
  };

  const scheduleReprepare = (): void => {
    const k = "all";
    const prev = reprepareTimers.get(k);
    if (prev) window.clearTimeout(prev);
    reprepareTimers.set(
      k,
      window.setTimeout(() => {
        reprepareTimers.delete(k);
        void reprepare();
      }, REPREPARE_DEBOUNCE_MS)
    );
  };

  /** Re-run the broker for the project's open `.cshtml` and refresh everything. */
  const reprepare = async (): Promise<void> => {
    if (disposed) return;
    const current = openCshtmlModels().filter((m) => inThisProject(fromFileUri(m.uri.toString())));
    if (current.length === 0) return;
    const rels = current.map((m) => relativize(projectDir, fromFileUri(m.uri.toString())));
    try {
      const re = await razorPrepare({
        workspaceDir: rootPath,
        userProjectDir: projectDir,
        userCsprojPath: csprojPath,
        config: CONFIG,
        cshtmlRels: rels,
      });
      for (const info of re.available) await openProjection(info);
      pullAllDiagnostics();
    } catch (err) {
      lspLog("razor projection: reprepare failed", String(err));
    }
  };

  // ── LIVE on-change emit + snapshot consistency (Etapa 3, hardened) ─────────
  // The broker's `dotnet build` reads disk → only fresh on save. The sidecar
  // re-emits the `.g.cs` from the IN-MEMORY buffer in ~ms. The hard part is
  // CONSISTENCY: the source map, the `.g.cs` Roslyn has open, and the buffer must
  // be ONE snapshot, or hover/def/completion remap against a stale projection
  // (the "delete NonExistentProperty → everything bugs" report). So:
  //   • Each `.g.cs` sync (emit→didOpen→commit map→stamp committedSourceVersion)
  //     is ONE op serialized per doc (`syncChains`), atomic vs other syncs.
  //   • Providers call `ensureFresh(doc, model)` first: if the buffer moved past
  //     the committed snapshot, it runs a sync and waits, so the provider always
  //     queries a snapshot that matches the buffer.
  //   • Editing just schedules a debounced background sync (keeps diagnostics
  //     fresh without a provider call); providers also force-sync on demand.
  const LIVE_DEBOUNCE_MS = 150;
  const liveTimers = new Map<string, number>(); // key → debounce timer
  // PER-DOC "live broken" flag: a sidecar failure on ONE `.cshtml` must not relax
  // freshness checks for healthy tabs (which would let them serve hover/def against
  // a stale projection). Keyed by the same canonical doc key as `docs`/`liveTimers`.
  const liveBroken = new Map<string, boolean>(); // key → sidecar broke for this doc

  /**
   * Re-emit + open + commit the projection for `doc` at the buffer's CURRENT
   * content, atomically. After it resolves, the map + open `.g.cs` +
   * `committedSourceVersion` all reflect that exact buffer version. Returns true
   * if it ended fresh (or was already fresh). Serialized per doc.
   */
  const syncLive = (key: string, model: monaco.editor.ITextModel): Promise<boolean> =>
    enqueueSync(key, async (): Promise<boolean> => {
      if (disposed || model.isDisposed()) return false;
      const doc = docs.get(key);
      if (!doc) return false;
      const version = model.getVersionId();
      if (doc.committedSourceVersion === version) return true; // already fresh
      const text = model.getValue();
      let res;
      try {
        res = await razorEmitLive(doc.cshtmlPath, text);
      } catch (err) {
        lspLog("razor projection: live emit failed", String(err));
        liveBroken.set(key, true);
        scheduleReprepare();
        return false;
      }
      if (disposed || model.isDisposed() || docs.get(key) !== doc) return false;
      if (!res.ok) {
        // An empty `.g.cs` (transient ungeneratable buffer) is NOT a broken
        // sidecar: keep the last good projection, don't latch/reprepare — the next
        // valid keystroke re-emits. A real failure (sidecar down / no context)
        // degrades to the on-save path.
        if (res.error === "sidecar produced empty .g.cs") return false;
        liveBroken.set(key, true);
        scheduleReprepare();
        return false;
      }
      liveBroken.set(key, false);
      // Open the fresh `.g.cs` in Roslyn, THEN commit its map — both inside this
      // serialized op, so nothing observes a half-applied snapshot.
      await setGeneratedText(doc.gcsUri, res.generatedText);
      if (disposed || model.isDisposed() || docs.get(key) !== doc) return false;
      await razorCommitLiveMap(doc.cshtmlPath, res.generation);
      doc.gcsVersion += 1;
      // Stamp the version the buffer was at WHEN WE READ IT — if the user typed
      // more meanwhile, we're still stale and a later sync will catch up.
      doc.committedSourceVersion = version;
      void pullDiagnostics(doc);
      return model.getVersionId() === version;
    });

  /**
   * Ensure the projection matches the buffer before a provider queries it. If the
   * buffer moved past the committed snapshot, run a sync and wait. Returns true
   * when the snapshot is consistent with the buffer (false ⇒ provider should bail
   * or, when live is broken, fall through to whatever the on-save state gives).
   */
  const ensureFresh = async (
    doc: ProjectionDoc,
    model: monaco.editor.ITextModel
  ): Promise<boolean> => {
    const key = canonicalFileUriKey(model.uri.toString());
    if (model.getVersionId() === doc.committedSourceVersion) return true;
    // Attempt a sync even when this doc is `liveBroken` — the sidecar may have
    // recovered, and this lets a provider call self-heal (syncLive clears the flag
    // for this doc on success). If it still can't sync (returns false), degrade to
    // the last on-save projection for THIS doc rather than blocking the provider.
    const fresh = await syncLive(key, model);
    return fresh || Boolean(liveBroken.get(key));
  };

  /**
   * After a provider's async request resolves, confirm the snapshot it computed
   * against is STILL valid. `reqVersion` is the model version at request start.
   * ALWAYS require the same doc and an unchanged buffer (so an edit during the
   * request never lets a now-stale result publish — even in degraded mode). In the
   * healthy path additionally require the committed snapshot to still be `snap`
   * (a newer live sync superseded the `.g.cs` the result was interpreted against);
   * in degraded mode (`liveBroken`) we can't track committed gens, so the
   * doc+buffer-unchanged check is the guarantee.
   */
  const snapshotStable = (
    doc: ProjectionDoc,
    model: monaco.editor.ITextModel,
    snap: number,
    reqVersion: number
  ): boolean => {
    if (docFor(model) !== doc || model.getVersionId() !== reqVersion) return false;
    const key = canonicalFileUriKey(model.uri.toString());
    return Boolean(liveBroken.get(key)) || doc.committedSourceVersion === snap;
  };

  const scheduleLiveEmit = (model: monaco.editor.ITextModel): void => {
    const key = canonicalFileUriKey(model.uri.toString());
    const prev = liveTimers.get(key);
    if (prev) window.clearTimeout(prev);
    liveTimers.set(
      key,
      window.setTimeout(() => {
        liveTimers.delete(key);
        if (!disposed && !model.isDisposed()) void syncLive(key, model);
      }, LIVE_DEBOUNCE_MS)
    );
  };

  const attachModel = (model: monaco.editor.ITextModel, initial = false): void => {
    if (model.getLanguageId() !== CSHTML_PROJECTION_LANGUAGE_ID || model.uri.scheme !== "file") return;
    if (!inThisProject(fromFileUri(model.uri.toString()))) return; // other project (V1)
    // Reprepare ONLY for models that appear AFTER startup. The models already
    // open at start are covered by the initial `prepared`/`openProjection` in
    // `onProjectInitialized`; firing a reprepare for them here would run a second
    // `razorPrepare` (emit + materialize) that races the `.g.cs` Roslyn just
    // opened — observed as `reprepare failed: os error 32` (file lock) and a
    // desynced map, so every diagnostic dropped (`pulled>0, mapped=0`). A
    // genuinely new tab, by contrast, has no projection yet and must reprepare.
    if (!initial) scheduleReprepare();
    // Live re-emit on every (debounced) edit, so detection follows the buffer.
    const sub = model.onDidChangeContent(() => {
      if (disposed) return;
      scheduleLiveEmit(model);
    });
    disposables.push(sub);
  };

  disposables.push(monaco.editor.onDidCreateModel((m) => attachModel(m)));
  // Attach to any `.cshtml` already open when the server starts — `initial` so we
  // don't double-prepare what the startup `prepared` already projected.
  for (const m of openCshtmlModels()) attachModel(m, true);
  disposables.push(
    monaco.editor.onWillDisposeModel((model) => forgetDoc(canonicalFileUriKey(model.uri.toString())))
  );

  // Reprepare on SAVE (App dispatches `fluent:file-saved` after `write_file`).
  // The broker reads disk, so saving is the only moment the on-disk `.cshtml`
  // matches the buffer — keystroke-driven reprepare would rebuild stale content.
  const onSaved = (e: Event): void => {
    const path = (e as CustomEvent<{ path?: string }>).detail?.path;
    if (path && /\.cshtml$/i.test(path) && inThisProject(path)) scheduleReprepare();
  };
  window.addEventListener("fluent:file-saved", onSaved);
  disposables.push({ dispose: () => window.removeEventListener("fluent:file-saved", onSaved) });

  // 6. Wire Roslyn startup against the EXACT shadow solution; on init, open the
  //    projected `.g.cs` and pull diagnostics.
  wireRoslynStartup(client, {
    serverId: RAZOR_PROJECTION_SERVER_ID,
    reopenLanguages: [], // the `.g.cs` are not Monaco models; we manage them
    rootPath,
    context,
    solutionPath: prepared.solutionPath,
    onProjectInitialized: () => {
      void (async () => {
        for (const info of prepared.available) await openProjection(info);
        pullAllDiagnostics();
      })();
      // Build + warm the live-emit sidecar in the background so the first
      // keystroke hits the fast (~ms) path. Best-effort: if the build/warm fails,
      // the on-change emit soft-fails and we fall back to the on-save reprepare.
      void (async () => {
        try {
          const built = await razorEnsureSidecar();
          if (!built || disposed) return;
          for (const info of prepared.available) {
            await razorWarm(info.cshtmlPath);
          }
          lspLog("razor projection: live sidecar warmed", prepared.available.length);
        } catch (err) {
          lspLog("razor projection: sidecar warm failed", String(err));
        }
      })();
    },
  });

  // Final disposable: mark disposed + clear timers + forget all docs/markers.
  disposables.push({
    dispose: () => {
      disposed = true;
      for (const t of reprepareTimers.values()) window.clearTimeout(t);
      reprepareTimers.clear();
      for (const t of liveTimers.values()) window.clearTimeout(t);
      liveTimers.clear();
      for (const key of [...docs.keys()]) forgetDoc(key);
      genChain.clear(); // drop the per-gcsUri mutation queues
      syncChains.clear(); // drop the per-doc live-sync queues
      sentText.clear();
      forgetAllHtmlVirtual(); // drop any leftover virtual-HTML cache on stop
      // Belt-and-suspenders: drop EVERY store entry this server owns, in case a
      // doc lifecycle edge was missed or the docs map was incomplete at stop —
      // server stop/reset must clear this owner's diagnostics (CSHTML lifecycle
      // contract). forgetDoc already cleared the known docs above.
      clearServerDiagnostics(RAZOR_PROJECTION_SERVER_ID);
    },
  });

  registerClientDisposables(client, disposables);
  return client;
}

/** Read the projected `.g.cs` from disk via the app's FS command. */
async function readGenerated(path: string): Promise<string> {
  return (await readFile(path)).content;
}

/** LSP hover contents → Monaco markdown. */
function toMarkdown(contents: unknown): monaco.IMarkdownString[] {
  if (typeof contents === "string") return [{ value: contents }];
  if (Array.isArray(contents)) {
    return contents.map((c) =>
      typeof c === "string" ? { value: c } : { value: markedToString(c) }
    );
  }
  if (contents && typeof contents === "object") {
    const c = contents as { value?: string; language?: string };
    if (typeof c.value === "string") {
      return [{ value: c.language ? "```" + c.language + "\n" + c.value + "\n```" : c.value }];
    }
  }
  return [];
}

function markedToString(c: unknown): string {
  if (c && typeof c === "object") {
    const v = c as { value?: string; language?: string };
    if (typeof v.value === "string") {
      return v.language ? "```" + v.language + "\n" + v.value + "\n```" : v.value;
    }
  }
  return "";
}

/** LSP CompletionItem → Monaco CompletionItem (V1: no textEdit, insert at word). */
function toCompletion(
  it: Record<string, unknown>,
  range: monaco.IRange
): monaco.languages.CompletionItem {
  const label = typeof it.label === "string" ? it.label : String(it.label ?? "");
  // Roslyn returns `textEditText` (+ itemDefaults.editRange) rather than
  // `insertText`, and the `label` carries display-only generics decoration
  // (`First<>`). Prefer the real insertion text so we don't type `First<>` into
  // the buffer; fall back to the label with the trailing `<>` stripped.
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const insertText =
    str(it.textEditText) ?? str(it.insertText) ?? label.replace(/<>$/, "");
  return {
    label,
    kind: completionKind(typeof it.kind === "number" ? (it.kind as number) : undefined),
    insertText,
    detail: typeof it.detail === "string" ? (it.detail as string) : undefined,
    documentation: docToString(it.documentation),
    sortText: typeof it.sortText === "string" ? (it.sortText as string) : undefined,
    filterText: typeof it.filterText === "string" ? (it.filterText as string) : undefined,
    range,
  };
}

function docToString(doc: unknown): string | monaco.IMarkdownString | undefined {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc === "object") {
    const d = doc as { value?: string };
    if (typeof d.value === "string") return { value: d.value };
  }
  return undefined;
}

/** Map LSP CompletionItemKind → Monaco using Monaco's own enum (stable names). */
function completionKind(lsp?: number): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  // LSP CompletionItemKind numbering (1=Text … 25=TypeParameter).
  const byLsp: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
    6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
    11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
    16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
    21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
  };
  // NB: must NOT use `|| K.Text` — Monaco's `Method` enum value is 0 (falsy), so
  // `(... && byLsp[lsp]) || K.Text` would map every Method to Text (the `abc`
  // icon). Methods are the common case after `@Model.`, so check explicitly.
  if (lsp == null) return K.Text;
  const mapped = byLsp[lsp];
  return mapped === undefined ? K.Text : mapped;
}
