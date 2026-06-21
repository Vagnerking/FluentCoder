/**
 * Adapter for the built-in `fluent-cshtml-lsp` language server.
 *
 * The server is a Rust binary compiled alongside the Tauri app (Cargo [[bin]]
 * entry in src-tauri). It implements LSP 3.17 textDocument sync + push
 * diagnostics for `.cshtml` files using the `CshtmlEngine` and `CshtmlLinter`.
 *
 * Unlike the Roslyn adapters, no download is needed — the binary is resolved
 * synchronously from the app directory via `lsp_ensure_fluent_cshtml_server`.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import { ensureFluentCshtmlServer, startLspServer } from "../../api";
import { createLanguageClient } from "../client";
import { toFileUri } from "../uri";
import type { ServerStartContext } from ".";

export const CSHTML_SERVER_ID = "fluent-cshtml";

/**
 * Brings up the `fluent-cshtml-lsp` server for the given workspace.
 *
 * Flow:
 * 1. `lsp_ensure_fluent_cshtml_server` → binary path (sync, no download).
 * 2. `lsp_start_server` → spawns the process, opens WS bridge.
 * 3. `createLanguageClient` → Monaco client over the bridge.
 *
 * Push diagnostics: the server sends `textDocument/publishDiagnostics`
 * after every didOpen/didChange — no pull capability needed.
 */
export async function startCshtmlServer(
  rootPath: string,
  _context?: ServerStartContext
): Promise<MonacoLanguageClient> {
  const command = await ensureFluentCshtmlServer();
  const [program, ...args] = command.split("\n").filter((s) => s.length > 0);
  if (!program) {
    throw new Error(
      "fluent-cshtml-lsp launch command was empty. " +
        "Em desenvolvimento, execute: cargo build --bin fluent-cshtml-lsp"
    );
  }

  await startLspServer(CSHTML_SERVER_ID, program, args, rootPath);

  return createLanguageClient({
    serverId: CSHTML_SERVER_ID,
    name: "Fluent CSHTML Language Client",
    documentSelector: [{ scheme: "file", language: "cshtml" }],
    rootUri: toFileUri(rootPath),
    // No initializationOptions: the built-in server needs none.
    // Diagnostics are push-only (publishDiagnostics), so no diagnosticMode.
  });
}
