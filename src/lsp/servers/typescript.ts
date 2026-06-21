/**
 * TypeScript / JavaScript language server wiring.
 *
 * Locates `typescript-language-server` (Rust side), starts it behind the WS
 * bridge, and connects a `MonacoLanguageClient` covering all four TS/JS dialects
 * — including the React ids `typescriptreact` / `javascriptreact` (ISSUE-36).
 *
 * tsconfig/jsconfig, path aliases, `node_modules` and `@types` are resolved by
 * the server itself from `rootUri` — no extra config needed (ISSUE-35).
 */
import { ensureTsServer, startLspServer, sshLspStart } from "../../api";
import { getActiveRemote } from "../../remote/host";
import { createLanguageClient, type RunningClient } from "../client";

export const TS_SERVER_ID = "typescript";

/**
 * Remote launch command (issue #8, Phase 6): run the server ON THE HOST. Prefer a
 * globally-installed `typescript-language-server`; fall back to `npx` (needs npm).
 * `exec` replaces the shell so a channel close kills the server.
 */
const TS_REMOTE_COMMAND =
  "if command -v typescript-language-server >/dev/null 2>&1; then " +
  "exec typescript-language-server --stdio; " +
  "else exec npx --yes typescript-language-server --stdio; fi";

/** file:// URI for a workspace root, Windows-safe (`file:///C:/...`). */
function toFileUri(rootPath: string): string {
  let p = rootPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // drive paths -> /C:/...
  return "file://" + encodeURI(p);
}

/**
 * Starts the TS/JS server for `rootPath` and returns the running client.
 * Rejects with a descriptive message if Node or the server isn't installed.
 */
export async function startTypescriptServer(
  rootPath: string
): Promise<RunningClient> {
  const remote = getActiveRemote();
  if (remote) {
    // Run the server on the host; the local WS bridge is identical to local.
    await sshLspStart(remote.connId, TS_SERVER_ID, TS_REMOTE_COMMAND, rootPath);
  } else {
    const { program, args } = await ensureTsServer(rootPath);
    await startLspServer(TS_SERVER_ID, program, args, rootPath);
  }

  return createLanguageClient({
    serverId: TS_SERVER_ID,
    name: "TypeScript Language Server",
    documentSelector: [
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "typescriptreact" },
      { scheme: "file", language: "javascriptreact" },
    ],
    rootUri: toFileUri(rootPath),
    initializationOptions: {
      hostInfo: "fluent-coder",
      preferences: {
        includeInlayParameterNameHints: "none",
        importModuleSpecifierPreference: "shortest",
        allowIncompleteCompletions: true,
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
      },
    },
  });
}
