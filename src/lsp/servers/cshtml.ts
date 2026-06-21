/**
 * CSHTML language service stub (issue #32).
 *
 * This module defines the server id for the standalone CSHTML engine and
 * exports a `startCshtmlServer` function. The server id `fluent-cshtml` is
 * intentionally distinct from `razor` (Roslyn cohosting) and `csharp`
 * (standalone Roslyn) so the LSP manager can lifecycle them independently.
 *
 * The actual engine (parser, linter, LSP process) will be wired in issues
 * #33–#38. Until then, this stub throws so the manager surfaces a clear
 * "not implemented" error instead of silently launching rzls or Roslyn for
 * .cshtml files.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import type { ServerStartContext } from ".";

export const CSHTML_SERVER_ID = "fluent-cshtml";

/**
 * Start the standalone CSHTML language server.
 *
 * Placeholder: to be implemented in issue #38 (cshtml-lsp). Until the engine
 * is ready, opening a `.cshtml` file relies on the Monarch tokenizer and the
 * razorHtmlLint marker pass — no LSP client is created.
 */
export async function startCshtmlServer(
  _rootPath: string,
  _context?: ServerStartContext
): Promise<MonacoLanguageClient> {
  throw new Error(
    "[fluent-cshtml] engine não implementada ainda (issue #38). " +
      "Abrindo .cshtml sem LSP — tokenizer e lint estático ativos."
  );
}
