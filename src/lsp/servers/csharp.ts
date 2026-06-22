import type { MonacoLanguageClient } from "monaco-languageclient";
import { ensureCsharpServer, startLspServer } from "../../api";
import { getActiveRemote } from "../../remote/host";
import { createLanguageClient } from "../client";
import { toFileUri } from "../uri";
import { wireRoslynStartup } from "./roslynShared";
import type { ServerStartContext } from ".";

export const CSHARP_SERVER_ID = "csharp";

/**
 * Initialization options for the Roslyn language server
 * (`Microsoft.CodeAnalysis.LanguageServer`). These mirror the defaults the
 * C# Dev Kit / OmniSharp-vscode sends.
 *
 * NOTE: Roslyn does NOT honor these analysis settings from `initialize`; it pulls
 * them at runtime via `workspace/configuration` (answered in
 * {@link ./csharpConfiguration}). They are kept here as a harmless redundancy and
 * for servers that do read `initializationOptions`. The pull handler is what
 * actually turns open-file diagnostics on.
 */
export const ROSLYN_INIT_OPTIONS = {
  "csharp|background_analysis": {
    "dotnet_analyzer_diagnostics_scope": "openFiles",
    "dotnet_compiler_diagnostics_scope": "openFiles",
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
 * Brings up the C# (Roslyn standalone) language server for the given workspace.
 *
 * Uses the standalone `Microsoft.CodeAnalysis.LanguageServer` 5.0.0 which
 * correctly emits `DocumentCompilerSemantic` diagnostics (the cohosting build
 * from the C# extension VSIX always returns `items:[]` for that category).
 * Razor (`.cshtml`/`.razor`) is handled by a separate cohosting instance
 * started via `startRazorServer`.
 */
export async function startCsharpServer(
  rootPath: string,
  context?: ServerStartContext
): Promise<MonacoLanguageClient> {
  if (getActiveRemote()) {
    // Roslyn runs locally; a remote workspace would need it on the host (and
    // remote `solution/open` paths). Not wired yet — surface a clear status.
    throw new Error(
      "C# (Roslyn) remoto ainda não é suportado — use o terminal remoto para builds. TS/JS já funciona no host."
    );
  }
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
    diagnosticMode: "pull",
    diagnosticIdentifiers: ["syntax", "DocumentCompilerSemantic"],
    deferSemanticTokens: true,
  });

  wireRoslynStartup(client, {
    serverId: CSHARP_SERVER_ID,
    reopenLanguages: ["csharp"],
    rootPath,
    context,
  });

  return client;
}
