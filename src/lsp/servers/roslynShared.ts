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
import {
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
  const { serverId, reopenLanguages, rootPath, context } = opts;

  // 1. Configuration pull handler + nudge.
  client.onRequest("workspace/configuration", (params: ConfigurationParams) =>
    resolveConfigurationSections(params)
  );
  void client
    .sendNotification("workspace/didChangeConfiguration", { settings: {} })
    .catch((err) => lspLog("didChangeConfiguration notify failed", String(err)));

  // 2. Project initialization complete.
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
      });
  });

  // 3. Workspace loading (fire-and-forget).
  void openRoslynWorkspace(client, serverId, rootPath, context);
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
  const monaco = await import("monaco-editor");
  const models = monaco.editor
    .getModels()
    .filter((model) => languages.includes(model.getLanguageId()));

  for (const model of models) {
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
    lspLog("Roslyn document rebound after project load", uri);
  }
}

async function openRoslynWorkspace(
  client: MonacoLanguageClient,
  serverId: string,
  rootPath: string,
  context?: ServerStartContext
): Promise<void> {
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
