/**
 * Shared Roslyn startup choreography used by both the C# standalone server and
 * the Razor cohosting server. Both speak the same extended LSP dialect: they pull
 * `workspace/configuration`, emit `workspace/projectInitializationComplete`, and
 * need `solution/open` (or `project/open`) to load the workspace.
 *
 * Call {@link wireRoslynStartup} right after `createLanguageClient` returns.
 * The function registers handlers, fires the config nudge, opens the workspace,
 * and returns — all async work happens inside the handlers/promises.
 */

import type { MonacoLanguageClient } from "monaco-languageclient";
import * as monaco from "monaco-editor";
import {
  addClientContributions,
  enableLanguageClientSemanticTokens,
  stabilizeLanguageClientSemanticTokens,
  repullDiagnostics,
} from "../client";
import { canonicalFileUriKey, toFileUri } from "../uri";
import { lspLog } from "../debug";
import { listProjectFiles } from "../../api";
import {
  resolveConfigurationSections,
  type ConfigurationParams,
} from "./csharpConfiguration";
import type { ServerStartContext } from ".";

export interface WireRoslynStartupOptions {
  /** Server id reported in `onWorkspaceInfo` callbacks (e.g. `"csharp"`, `"razor"`). */
  serverId: string;
  /**
   * Monaco language ids whose open models should be re-sent to Roslyn after
   * project initialization (e.g. `["csharp"]` or `["aspnetcorerazor"]`).
   */
  reopenLanguages: string[];
  /** Workspace root (filesystem path, not URI). */
  rootPath: string;
  context?: ServerStartContext;
  /**
   * Explicit solution to `solution/open` (ADR 0002 projection: the broker's
   * shadow `.sln`). When set, the rootPath scan is skipped and this exact file is
   * opened — more robust than depending on scan order finding the right `.sln`.
   */
  solutionPath?: string;
  /**
   * Extra hook fired after the standard `projectInitializationComplete` handling
   * (reopen/enable/stabilize/repull). The projection starter uses it to `didOpen`
   * its `.g.cs` and pull diagnostics once the shadow workspace is loaded.
   */
  onProjectInitialized?: () => void;
}

/**
 * Registers all Roslyn-specific LSP handlers and kicks off workspace loading.
 *
 * Order (must match docs/context/editor.md):
 * 1. Register `workspace/configuration` handler + nudge with `didChangeConfiguration`.
 * 2. Register `workspace/projectInitializationComplete` handler (reopen, enable
 *    semantic tokens, stabilize, repull diagnostics).
 * 3. Fire `openRoslynWorkspace` (`solution/open` / `project/open`) — async, never
 *    throws into the caller.
 */
export function wireRoslynStartup(
  client: MonacoLanguageClient,
  opts: WireRoslynStartupOptions
): void {
  const { serverId, reopenLanguages, rootPath, context, solutionPath, onProjectInitialized } = opts;

  // 1. Configuration pull handler + nudge.
  client.onRequest("workspace/configuration", (params: ConfigurationParams) =>
    resolveConfigurationSections(params)
  );
  void client
    .sendNotification("workspace/didChangeConfiguration", { settings: {} })
    .catch((err) => lspLog("didChangeConfiguration notify failed", String(err)));

  // Once the workspace is loaded, any `.cs`/`.cshtml` model that appears LATER
  // (the classic case: a session-restore tab whose Monaco model is created after
  // the server already finished `solution/open`) must still be (re)bound to
  // Roslyn — otherwise the document is never `didOpen`ed, no diagnostics/semantic
  // tokens flow, and it only "wakes up" when the user focuses the tab (which
  // triggers the v10 client's own didOpen). Gate the late-bind on this flag so we
  // never push documents before the solution is ready.
  let workspaceInitialized = false;
  // Models created BEFORE init completes are parked here and rebound in the init
  // handler. This closes the race the simple `workspaceInitialized` guard left
  // open: a model created AFTER `reopenRoslynDocuments()` snapshotted `getModels()`
  // but BEFORE init finished would otherwise be covered by neither the batch nor
  // the late listener, and never get rebound (no diagnostics until refocus).
  const pendingPreInit = new Set<monaco.editor.ITextModel>();

  const rebindOne = (model: monaco.editor.ITextModel): void => {
    if (model.isDisposed()) return;
    void rebindRoslynDocument(client, model)
      .then(() => {
        enableLanguageClientSemanticTokens(client);
        stabilizeLanguageClientSemanticTokens(client);
        repullDiagnostics(client);
      })
      .catch((err) =>
        lspLog("late model rebind failed; re-pulling diagnostics", serverId, String(err))
      );
  };

  client.onNotification("workspace/projectInitializationComplete", () => {
    lspLog("Roslyn project initialization COMPLETE", serverId, rootPath);
    const workspace = roslynWorkspaces.get(client);
    if (workspace) {
      context?.onWorkspaceInfo?.({
        serverId,
        solutionPath: workspace.solutionPath,
        projectCount: workspace.projectCount,
        loaded: true,
      });
    }
    let reboundKeys = new Set<string>();
    void reopenRoslynDocuments(client, reopenLanguages)
      .then((keys) => {
        reboundKeys = keys;
        enableLanguageClientSemanticTokens(client);
        stabilizeLanguageClientSemanticTokens(client);
        repullDiagnostics(client);
      })
      .catch((err) => {
        lspLog("reopenRoslynDocuments failed; re-pulling diagnostics", String(err));
        repullDiagnostics(client);
      })
      .finally(() => {
        // Flip the flag FIRST so any model created from now on takes the direct
        // path, then drain those parked during startup — SKIPPING models the
        // batch reopen already covered. A second didClose+didOpen wave for the
        // same doc is NOT harmless: Roslyn treats a `didClose` for a document it
        // no longer tracks as a fatal `InvalidOperationException` and SHUTS ITS
        // REQUEST QUEUE DOWN ("Error processing queue, shutting down") — seen
        // live on a heavy workspace (ativus, 3 restored .cs tabs): the double
        // wave raced the client's own document sync and killed the csharp
        // server permanently (the v10 error handler is DoNotRestart).
        workspaceInitialized = true;
        const parked = [...pendingPreInit];
        pendingPreInit.clear();
        for (const model of parked) {
          if (reboundKeys.has(canonicalFileUriKey(model.uri.toString()))) continue;
          rebindOne(model);
        }
        onProjectInitialized?.();
      });
  });

  // Bind any matching model regardless of WHEN it appears. Only the shared C#
  // path uses this (`reopenLanguages` non-empty); the projection starter manages
  // its own `.g.cs` lifecycle (`reopenLanguages: []`), so it's a no-op there.
  // Pre-init creations are parked (drained by the init handler); post-init ones
  // rebind immediately.
  if (reopenLanguages.length > 0) {
    const onCreate = monaco.editor.onDidCreateModel((model) => {
      if (!reopenLanguages.includes(model.getLanguageId())) return;
      if (model.uri.scheme !== "file") return;
      if (!workspaceInitialized) {
        pendingPreInit.add(model);
        return;
      }
      rebindOne(model);
    });
    addClientContributions(client, [onCreate]);
  }

  // 3. Workspace loading (fire-and-forget).
  void openRoslynWorkspace(client, serverId, rootPath, context, solutionPath);
}

/** Tracks solution/project info per client so the init-complete handler can report it. */
const roslynWorkspaces = new WeakMap<
  MonacoLanguageClient,
  { solutionPath?: string; projectCount: number }
>();

/**
 * Rebinds every open model of `languages`; returns the canonical uri keys it
 * covered so the pre-init parked drain can SKIP them — a duplicate rebind wave
 * for the same doc is fatal to Roslyn (see the init-complete handler).
 */
async function reopenRoslynDocuments(
  client: MonacoLanguageClient,
  languages: string[]
): Promise<Set<string>> {
  const models = monaco.editor
    .getModels()
    .filter((model) => languages.includes(model.getLanguageId()));

  const keys = new Set<string>();
  for (const model of models) {
    await rebindRoslynDocument(client, model);
    keys.add(canonicalFileUriKey(model.uri.toString()));
  }
  return keys;
}

/**
 * Re-sends one model to Roslyn as a clean `didClose` + `didOpen`. Idempotent: if
 * the v10 client already auto-opened the model, the `didClose` first makes the
 * re-open a no-op delta rather than a duplicate. Used both by the post-init
 * batch reopen and by the late-model listener (boot/restore tabs).
 */
async function rebindRoslynDocument(
  client: MonacoLanguageClient,
  model: monaco.editor.ITextModel
): Promise<void> {
  if (model.isDisposed()) return;
  // MUST serialize the uri exactly like the client's own document-sync does
  // (`code2ProtocolConverter.asUri` percent-encodes the drive colon: `c%3A`).
  // A hand-rolled `model.uri.toString()` produced the RAW `c:` form — Roslyn
  // tracks documents by exact uri string, so the rebind's didClose targeted a
  // "different" document than the native didOpen had registered →
  // InvalidOperationException → "Error processing queue, shutting down" (the
  // csharp server died permanently on heavy workspaces with restored tabs).
  const uri = client.code2ProtocolConverter.asUri(
    model.uri as unknown as Parameters<typeof client.code2ProtocolConverter.asUri>[0]
  );
  await client.sendNotification("textDocument/didClose", {
    textDocument: { uri },
  });
  await client.sendNotification("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: model.getLanguageId(),
      version: model.getVersionId(),
      text: model.getValue(),
    },
  });
  lspLog("Roslyn document rebound", uri);
}

async function openRoslynWorkspace(
  client: MonacoLanguageClient,
  serverId: string,
  rootPath: string,
  context?: ServerStartContext,
  solutionPath?: string
): Promise<void> {
  // ADR 0002 projection: open the broker's exact shadow `.sln`, skipping the scan.
  if (solutionPath) {
    const uri = toFileUri(solutionPath);
    roslynWorkspaces.set(client, { solutionPath, projectCount: 2 });
    context?.onWorkspaceInfo?.({ serverId, solutionPath, projectCount: 2, loaded: false });
    lspLog("openRoslynWorkspace: solution/open explícito", uri);
    try {
      await client.sendNotification("solution/open", { solution: uri });
    } catch (err) {
      lspLog("openRoslynWorkspace: solution/open explícito FALHOU", String(err));
      // Same recovery as the scan-based paths below: without this, a rejected
      // solution/open leaves the client stuck with deferred semantic tokens
      // forever (the projection broker always goes through `solutionPath`).
      enableLanguageClientSemanticTokens(client);
    }
    return;
  }
  try {
    lspLog("openRoslynWorkspace: listando arquivos de", rootPath);
    const files = await listProjectFiles(rootPath);
    const slns = files.filter((f) => f.name.toLowerCase().endsWith(".sln"));
    const csprojs = files.filter((f) => f.name.toLowerCase().endsWith(".csproj"));
    lspLog("openRoslynWorkspace: encontrados", { slns: slns.length, csprojs: csprojs.length });

    if (slns.length > 0) {
      const sln = slns.sort(
        (a, b) => a.rel.split("/").length - b.rel.split("/").length
      )[0];
      const uri = toFileUri(sln.path);
      roslynWorkspaces.set(client, {
        solutionPath: sln.path,
        projectCount: csprojs.length,
      });
      context?.onWorkspaceInfo?.({
        serverId,
        solutionPath: sln.path,
        projectCount: csprojs.length,
        loaded: false,
      });
      lspLog("openRoslynWorkspace: enviando solution/open", uri);
      await client.sendNotification("solution/open", { solution: uri });
      lspLog("openRoslynWorkspace: solution/open ENVIADO");
    } else if (csprojs.length > 0) {
      roslynWorkspaces.set(client, { projectCount: csprojs.length });
      context?.onWorkspaceInfo?.({
        serverId,
        projectCount: csprojs.length,
        loaded: false,
      });
      lspLog("openRoslynWorkspace: enviando project/open", csprojs.length);
      await client.sendNotification("project/open", {
        projects: csprojs.map((p) => toFileUri(p.path)),
      });
      lspLog("openRoslynWorkspace: project/open ENVIADO");
    } else {
      lspLog("openRoslynWorkspace: NENHUM .sln/.csproj encontrado em", rootPath);
      enableLanguageClientSemanticTokens(client);
    }
  } catch (err) {
    lspLog("openRoslynWorkspace: FALHOU", String(err));
    enableLanguageClientSemanticTokens(client);
  }
}
