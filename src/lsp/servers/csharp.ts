import type { MonacoLanguageClient } from "monaco-languageclient";
import { ensureCsharpServer, startLspServer, listProjectFiles } from "../../api";
import {
  createLanguageClient,
  enableLanguageClientSemanticTokens,
  refreshLanguageClientSemanticTokens,
} from "../client";
import { toFileUri } from "../uri";
import { lspLog } from "../debug";
import type { ServerStartContext } from ".";

export const CSHARP_SERVER_ID = "csharp";

/**
 * Initialization options for the Roslyn language server
 * (`Microsoft.CodeAnalysis.LanguageServer`). These mirror the defaults the
 * C# Dev Kit / OmniSharp-vscode sends; tune as needed once validated against a
 * real `.csproj`.
 */
export const ROSLYN_INIT_OPTIONS = {
  "csharp|background_analysis": {
    "dotnet_analyzer_diagnostics_scope": "fullSolution",
    "dotnet_compiler_diagnostics_scope": "fullSolution",
  },
  "csharp|completion": {
    "dotnet_provide_regex_completions": true,
    "dotnet_show_completion_items_from_unimported_namespaces": true,
    "dotnet_show_name_completion_suggestions": true,
  },
  "csharp|symbol_search": {
    "dotnet_search_reference_assemblies": true,
  },
} as const;

/**
 * Brings up the C# (Roslyn) language server end-to-end for the given workspace:
 *
 * 1. {@link ensureCsharpServer} — download/cache Roslyn + detect `dotnet`
 *    (ISSUE-26). Resolves to the launch command (program + args, newline-joined).
 * 2. {@link startLspServer} — spawn the process and open the local WS bridge.
 * 3. {@link createLanguageClient} — wire `monaco-languageclient` to the bridge.
 *
 * Returns the live client so the manager can stop it later.
 */
export async function startCsharpServer(
  rootPath: string,
  context?: ServerStartContext
): Promise<MonacoLanguageClient> {
  const command = await ensureCsharpServer(rootPath);
  const [program, ...args] = command.split("\n").filter((s) => s.length > 0);
  if (!program) {
    throw new Error("C# server launch command was empty");
  }

  await startLspServer(CSHARP_SERVER_ID, program, args, rootPath);

  const client = await createLanguageClient({
    serverId: CSHARP_SERVER_ID,
    documentSelector: [{ scheme: "file", language: "csharp" }],
    rootUri: toFileUri(rootPath),
    initializationOptions: ROSLYN_INIT_OPTIONS,
  });

  // Roslyn emits this only after every project discovered through solution/open
  // or project/open has finished loading. This is the authoritative point at
  // which cross-project symbols and framework types should be fully classified.
  client.onNotification("workspace/projectInitializationComplete", () => {
    lspLog("Roslyn project initialization COMPLETE", rootPath);
    const workspace = csharpWorkspaces.get(client);
    if (workspace) {
      context?.onWorkspaceInfo?.({
        serverId: CSHARP_SERVER_ID,
        solutionPath: workspace.solutionPath,
        projectCount: workspace.projectCount,
        loaded: true,
      });
    }
    // The language client starts before `solution/open`, so existing Monaco
    // models are initially sent to Roslyn as miscellaneous files. Roslyn can
    // report the correct project context later while still serving semantic
    // classifications from that stale document snapshot. Reopen every C# model
    // after project initialization so the document is bound to the loaded
    // project before asking Monaco to refresh semantic tokens.
    void reopenCsharpDocuments(client).then(() => {
      enableLanguageClientSemanticTokens(client);
      refreshLanguageClientSemanticTokens(client);
      void logCurrentDocumentProjectContexts(client);
    });
  });

  // Roslyn does NOT load projects from `rootUri` alone — it needs its custom
  // `solution/open` (preferred) or `project/open` notification after the client
  // is running. Without this the server connects but produces zero diagnostics
  // and no completions. Fire-and-forget so a slow project scan doesn't block.
  void openRoslynWorkspace(client, rootPath, context);

  return client;
}

const csharpWorkspaces = new WeakMap<
  MonacoLanguageClient,
  { solutionPath?: string; projectCount: number }
>();

/**
 * Tells Roslyn which solution/projects to load. Prefers a single `.sln`; falls
 * back to opening every `.csproj` found under the root. Best-effort — logged,
 * never throws into the start flow.
 */
async function openRoslynWorkspace(
  client: MonacoLanguageClient,
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
      // Shallowest .sln wins (fewest path separators) when there are several.
      const sln = slns.sort(
        (a, b) => a.rel.split("/").length - b.rel.split("/").length
      )[0];
      const uri = toFileUri(sln.path);
      csharpWorkspaces.set(client, {
        solutionPath: sln.path,
        projectCount: csprojs.length,
      });
      context?.onWorkspaceInfo?.({
        serverId: CSHARP_SERVER_ID,
        solutionPath: sln.path,
        projectCount: csprojs.length,
        loaded: false,
      });
      lspLog("openRoslynWorkspace: enviando solution/open", uri);
      await client.sendNotification("solution/open", { solution: uri });
      lspLog("openRoslynWorkspace: solution/open ENVIADO");
    } else if (csprojs.length > 0) {
      csharpWorkspaces.set(client, { projectCount: csprojs.length });
      context?.onWorkspaceInfo?.({
        serverId: CSHARP_SERVER_ID,
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

async function reopenCsharpDocuments(
  client: MonacoLanguageClient
): Promise<void> {
  const monaco = await import("monaco-editor");
  const models = monaco.editor
    .getModels()
    .filter((model) => model.getLanguageId() === "csharp");

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

async function logCurrentDocumentProjectContexts(
  client: MonacoLanguageClient
): Promise<void> {
  const model = (
    await import("monaco-editor")
  ).editor.getModels().find((candidate) => candidate.getLanguageId() === "csharp");
  if (!model) return;

  try {
    const contexts = await client.sendRequest(
      "textDocument/_vs_getProjectContexts",
      {
        _vs_textDocument: {
          uri: model.uri.toString(),
        },
      }
    );
    lspLog("Roslyn project contexts for current document", contexts);
  } catch (err) {
    lspLog("Roslyn project contexts request failed", String(err));
  }
}
