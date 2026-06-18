/**
 * ISSUE-19 — "hello LSP" spike.
 *
 * Minimal, self-contained check that the pinned `monaco-languageclient@1.x`
 * stack wires up against the vanilla `monaco-editor` distribution without
 * pulling `@codingame/monaco-vscode-api`. Not wired into the app UI; call
 * {@link helloLsp} from a dev console / temporary button to validate end-to-end
 * once a bridge is running.
 *
 * See `COMPAT.md` for the version rationale.
 */
import { ensureMonacoServices, createLanguageClient } from "./client";

/**
 * Connects a throwaway client to whatever LSP session is registered under
 * `serverId` and logs the negotiated server capabilities. Confirms the
 * JSON-RPC handshake over the WS transport works without runtime errors.
 */
export async function helloLsp(serverId = "csharp"): Promise<void> {
  ensureMonacoServices();
  const client = await createLanguageClient({
    serverId,
    documentSelector: [{ scheme: "file", language: serverId }],
    rootUri: "file:///",
  });
  // `initializeResult` is populated after a successful `initialize` round-trip.
  // eslint-disable-next-line no-console
  console.log("[hello-lsp] capabilities:", client.initializeResult?.capabilities);
  await client.stop();
}
