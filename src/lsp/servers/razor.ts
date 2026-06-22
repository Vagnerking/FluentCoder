/**
 * Razor language server wiring — Roslyn cohosting build.
 *
 * Uses the `Microsoft.CodeAnalysis.LanguageServer` from the C# extension VSIX,
 * started with `--extension Microsoft.VisualStudioCode.RazorExtension.dll`. This
 * cohosting build speaks the same extended Roslyn LSP dialect as the standalone
 * server (C#), so the startup choreography is shared via `wireRoslynStartup`.
 *
 * Why cohosting for Razor, standalone for C#:
 *   - The standalone 5.0.0 correctly emits `DocumentCompilerSemantic` diagnostics
 *     but does not include the Razor extension — C# squiggles work, Razor does not.
 *   - The cohosting build bundles the Razor extension and serves `.cshtml`/`.razor`,
 *     but always returns `items:[]` for `DocumentCompilerSemantic` — Razor works,
 *     C# squiggles do not.
 *   - Two separate servers, two separate LSP sessions keyed by `serverId`, gives us
 *     both without compromise.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import { ensureRazorServer, startLspServer } from "../../api";
import { getActiveRemote } from "../../remote/host";
import { createLanguageClient } from "../client";
import { toFileUri } from "../uri";
import { wireRoslynStartup } from "./roslynShared";
import { ROSLYN_INIT_OPTIONS } from "./csharp";
import type { ServerStartContext } from ".";

export const RAZOR_SERVER_ID = "razor";

/**
 * Brings up the Razor (Roslyn cohosting) language server for the given workspace.
 *
 * Semantic tokens are deferred until `projectInitializationComplete` (same as C#)
 * so provisional classifications never flash as the wrong color before the project
 * finishes loading.
 */
export async function startRazorServer(
  rootPath: string,
  context?: ServerStartContext
): Promise<MonacoLanguageClient> {
  if (getActiveRemote()) {
    throw new Error("Razor remoto ainda não é suportado.");
  }
  const command = await ensureRazorServer();
  const [program, ...args] = command.split("\n").filter((s) => s.length > 0);
  if (!program) {
    throw new Error("Razor server launch command was empty");
  }

  await startLspServer(RAZOR_SERVER_ID, program, args, rootPath);

  const client = await createLanguageClient({
    serverId: RAZOR_SERVER_ID,
    name: "Razor Language Server",
    documentSelector: [{ scheme: "file", language: "aspnetcorerazor" }],
    rootUri: toFileUri(rootPath),
    initializationOptions: ROSLYN_INIT_OPTIONS,
    diagnosticMode: "pull",
    diagnosticIdentifiers: ["syntax", "DocumentCompilerSemantic"],
    deferSemanticTokens: true,
  });

  wireRoslynStartup(client, {
    serverId: RAZOR_SERVER_ID,
    reopenLanguages: ["aspnetcorerazor"],
    rootPath,
    context,
  });

  return client;
}
