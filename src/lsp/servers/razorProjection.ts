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
  razorForget,
  razorPrepare,
  razorRemapToGenerated,
  razorRemapToSource,
  readFile,
  startLspServer,
  type RazorProjectionInfo,
} from "../../api";
import { createLanguageClient, registerClientDisposables } from "../client";
import { lspLog } from "../debug";
import { canonicalFileUriKey, fromFileUri, toFileUri } from "../uri";
import { wireRoslynStartup } from "./roslynShared";
import { ROSLYN_INIT_OPTIONS } from "./csharp";
import {
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
/** Backoff for re-pulling diagnostics (Roslyn streams; first pulls can be empty). */
const DIAGNOSTIC_RETRY_MS = [600, 1500, 3000];

/** A `.cshtml` being served, paired with its projected `.g.cs`. */
interface ProjectionDoc {
  cshtmlPath: string; // absolute (key the razor_remap_* commands expect)
  cshtmlUri: string; // Monaco model uri
  gcsUri: string; // file:// uri of the projected `.g.cs` (Roslyn addresses this)
  gcsVersion: number; // didOpen/didChange version counter
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
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

/** Longest-prefix `.csproj` that contains `cshtmlPath`, or null (loose file). */
async function resolveProject(
  rootPath: string,
  cshtmlPath: string
): Promise<{ projectDir: string; csprojPath: string } | null> {
  const files = await listProjectFiles(rootPath);
  const target = cshtmlPath.replace(/\\/g, "/").toLowerCase();
  let best: { projectDir: string; csprojPath: string; len: number } | null = null;
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".csproj")) continue;
    const dir = f.path.replace(/[\\/][^\\/]+$/, ""); // dirname
    const dirKey = dir.replace(/\\/g, "/").toLowerCase() + "/";
    if (target.startsWith(dirKey) && (!best || dir.length > best.len)) {
      best = { projectDir: dir, csprojPath: f.path, len: dir.length };
    }
  }
  return best ? { projectDir: best.projectDir, csprojPath: best.csprojPath } : null;
}

/** Path of `full` relative to ancestor `base` (OS separators preserved). */
function relativize(base: string, full: string): string {
  const b = base.replace(/[\\/]+$/, "");
  return full.slice(b.length).replace(/^[\\/]+/, "");
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
  const models = openCshtmlModels();
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
  const disposables: monaco.IDisposable[] = [];
  const reprepareTimers = new Map<string, number>();
  let disposed = false;

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

  /** Register/refresh a doc from a prepared projection + didOpen its `.g.cs`. */
  const openProjection = async (info: RazorProjectionInfo): Promise<void> => {
    const model = inProjectModelFor(info.cshtmlPath);
    if (!model) return; // closed meanwhile
    const cshtmlUri = model.uri.toString();
    const key = canonicalFileUriKey(cshtmlUri);
    const gcsUri = toFileUri(info.generatedPath);
    const existing = docs.get(key);
    const doc: ProjectionDoc = {
      cshtmlPath: info.cshtmlPath,
      cshtmlUri,
      gcsUri,
      gcsVersion: (existing?.gcsVersion ?? 0) + 1,
    };
    docs.set(key, doc);
    let text = "";
    try {
      text = await readGenerated(info.generatedPath);
    } catch (err) {
      lspLog("razor projection: read .g.cs failed", info.generatedPath, String(err));
      return;
    }
    const method = existing ? "textDocument/didChange" : "textDocument/didOpen";
    try {
      if (existing) {
        await client.sendNotification("textDocument/didChange", {
          textDocument: { uri: gcsUri, version: doc.gcsVersion },
          contentChanges: [{ text }],
        });
      } else {
        await client.sendNotification("textDocument/didOpen", {
          textDocument: { uri: gcsUri, languageId: "csharp", version: doc.gcsVersion, text },
        });
      }
      lspLog("razor projection: sent", method, gcsUri.slice(-60));
    } catch (err) {
      lspLog("razor projection: didOpen/didChange failed", String(err));
    }
  };

  /** Pull diagnostics for one doc and publish remapped markers to the `.cshtml`. */
  const pullDiagnostics = async (doc: ProjectionDoc): Promise<void> => {
    if (disposed) return;
    let result: { items?: unknown[] } | null = null;
    try {
      result = await client.sendRequest<{ items?: unknown[] } | null>(
        "textDocument/diagnostic",
        { textDocument: { uri: doc.gcsUri } }
      );
    } catch (err) {
      lspLog("razor projection: diagnostic pull failed", String(err));
      return;
    }
    const items = (result?.items ?? []) as Parameters<typeof routeDiagnostics>[0];
    const markers = await routeDiagnostics(items, remapToSourceFor(doc.cshtmlPath));
    const model = monaco.editor.getModel(monaco.Uri.parse(doc.cshtmlUri));
    if (model && !model.isDisposed()) {
      monaco.editor.setModelMarkers(
        model,
        DIAGNOSTICS_OWNER,
        markers as unknown as monaco.editor.IMarkerData[]
      );
    }
  };

  /** Pull diagnostics for every doc, with a short backoff (streamed results). */
  const pullAllDiagnostics = (): void => {
    for (const doc of docs.values()) void pullDiagnostics(doc);
    DIAGNOSTIC_RETRY_MS.forEach((ms) => {
      const t = window.setTimeout(() => {
        if (disposed) return;
        for (const doc of docs.values()) void pullDiagnostics(doc);
      }, ms);
      disposables.push({ dispose: () => window.clearTimeout(t) });
    });
  };

  // 4. Monaco providers for `.cshtml` (forward to the `.g.cs`, remap results).
  const sel: monaco.languages.LanguageSelector = CSHTML_PROJECTION_LANGUAGE_ID;

  const docFor = (model: monaco.editor.ITextModel): ProjectionDoc | undefined =>
    docs.get(canonicalFileUriKey(model.uri.toString()));

  disposables.push(
    monaco.languages.registerHoverProvider(sel, {
      provideHover: async (model, position, token) => {
        const doc = docFor(model);
        if (!doc) return null;
        const gen = await razorRemapToGenerated(doc.cshtmlPath, position.lineNumber - 1, position.column - 1);
        if (!gen) return null;
        const res = await client.sendRequest<{ contents?: unknown; range?: LspRange } | null>(
          "textDocument/hover",
          { textDocument: { uri: doc.gcsUri }, position: { line: gen.line, character: gen.character } },
          token
        );
        if (!res || !res.contents || token.isCancellationRequested) return null;
        let range: monaco.IRange | undefined;
        if (res.range) {
          const r = await remapRangeToMonaco(res.range, remapToSourceFor(doc.cshtmlPath));
          range = r ?? undefined;
        }
        return { contents: toMarkdown(res.contents), range };
      },
    })
  );

  disposables.push(
    monaco.languages.registerDefinitionProvider(sel, {
      provideDefinition: async (model, position, token) => {
        const doc = docFor(model);
        if (!doc) return null;
        const gen = await razorRemapToGenerated(doc.cshtmlPath, position.lineNumber - 1, position.column - 1);
        if (!gen) return null;
        const res = await client.sendRequest<unknown>(
          "textDocument/definition",
          { textDocument: { uri: doc.gcsUri }, position: { line: gen.line, character: gen.character } },
          token
        );
        if (token.isCancellationRequested) return null;
        const routed = await routeDefinition(res, {
          projectedUriKey: canonicalFileUriKey(doc.gcsUri),
          cshtmlUri: doc.cshtmlUri,
          remapToSource: remapToSourceFor(doc.cshtmlPath),
          uriKey: canonicalFileUriKey,
        });
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
        const gen = await razorRemapToGenerated(doc.cshtmlPath, position.lineNumber - 1, position.column - 1);
        if (!gen) return { suggestions: [] };
        const res = await client.sendRequest<
          { items?: unknown[]; isIncomplete?: boolean } | unknown[] | null
        >(
          "textDocument/completion",
          { textDocument: { uri: doc.gcsUri }, position: { line: gen.line, character: gen.character } },
          token
        );
        if (token.isCancellationRequested || !res) return { suggestions: [] };
        const items = Array.isArray(res) ? res : res.items ?? [];
        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: items.map((it) => toCompletion(it as Record<string, unknown>, range)),
          incomplete: Array.isArray(res) ? false : Boolean(res.isIncomplete),
        };
      },
    })
  );

  // 5. Lifecycle: watch model open/close/change to (re)prepare and clean up.
  const forgetDoc = (key: string): void => {
    const doc = docs.get(key);
    if (!doc) return;
    docs.delete(key);
    void client.sendNotification("textDocument/didClose", { textDocument: { uri: doc.gcsUri } }).catch(() => {});
    void razorForget(doc.cshtmlPath).catch(() => {});
    const model = monaco.editor.getModel(monaco.Uri.parse(doc.cshtmlUri));
    if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, DIAGNOSTICS_OWNER, []);
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

  const attachModel = (model: monaco.editor.ITextModel): void => {
    if (model.getLanguageId() !== CSHTML_PROJECTION_LANGUAGE_ID || model.uri.scheme !== "file") return;
    if (!inThisProject(fromFileUri(model.uri.toString()))) return; // other project (V1)
    // A newly-opened `.cshtml` matches disk → safe to reprepare immediately.
    scheduleReprepare();
  };

  disposables.push(monaco.editor.onDidCreateModel(attachModel));
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
    },
  });

  // Final disposable: mark disposed + clear timers + forget all docs/markers.
  disposables.push({
    dispose: () => {
      disposed = true;
      for (const t of reprepareTimers.values()) window.clearTimeout(t);
      reprepareTimers.clear();
      for (const key of [...docs.keys()]) forgetDoc(key);
    },
  });

  registerClientDisposables(client, disposables);
  return client;
}

/** Read the projected `.g.cs` from disk via the app's FS command. */
async function readGenerated(path: string): Promise<string> {
  return readFile(path);
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
  const insertText =
    typeof it.insertText === "string" ? (it.insertText as string) : label;
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
  return (lsp != null && byLsp[lsp]) || K.Text;
}
