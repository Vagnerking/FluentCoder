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
import { toFileUri } from "../uri";
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
    void reopenRoslynDocuments(client, reopenLanguages)
      .then(() => {
        enableLanguageClientSemanticTokens(client);
        stabilizeLanguageClientSemanticTokens(client);
        repullDiagnostics(client);
      })
      .catch((err) => {
        lspLog("reopenRoslynDocuments failed; re-pulling diagnostics", String(err));
        repullDiagnostics(client);
      })
      .finally(() => {
        workspaceInitialized = true;
        onProjectInitialized?.();
      });
  });

  // Late-arriving models: bind any matching model created AFTER init. Only the
  // shared C# path uses this (`reopenLanguages` non-empty); the projection
  // starter manages its own `.g.cs` lifecycle (`reopenLanguages: []`), so the
  // listener is a no-op there.
  if (reopenLanguages.length > 0) {
    const onCreate = monaco.editor.onDidCreateModel((model) => {
      if (!workspaceInitialized) return; // init's own reopen will cover it
      if (!reopenLanguages.includes(model.getLanguageId())) return;
      if (model.uri.scheme !== "file") return;
      void rebindRoslynDocument(client, model)
        .then(() => {
          enableLanguageClientSemanticTokens(client);
          stabilizeLanguageClientSemanticTokens(client);
          repullDiagnostics(client);
        })
        .catch((err) =>
          lspLog("late model rebind failed; re-pulling diagnostics", serverId, String(err))
        );
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

async function reopenRoslynDocuments(
  client: MonacoLanguageClient,
  languages: string[]
): Promise<void> {
  const models = monaco.editor
    .getModels()
    .filter((model) => languages.includes(model.getLanguageId()));

  for (const model of models) {
    await rebindRoslynDocument(client, model);
  }
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
  const uri = model.uri.toString();
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
