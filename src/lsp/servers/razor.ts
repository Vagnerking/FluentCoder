/**
 * Razor (`rzls`) server wiring (ISSUE-31).
 *
 * Best-effort per the ISSUE-32 spike (see `../RAZOR-SPIKE.md`): this starts rzls
 * via the SAME generic bridge + client factory the C#/TS servers use, and enables
 * exactly the LSP features that work over the *plain* protocol. Document-projection
 * features (synthetic C#/HTML buffers with request forwarding) are OUT OF SCOPE.
 *
 * What this delivers:
 *   - Syntax highlight (ISSUE-29 tokenizer in `../monacoSetup`; independent of rzls).
 *   - rzls process lifecycle (acquisition, bridge, initialize).
 *   - Diagnostics -> Problems panel + editor markers, IF rzls publishes them over
 *     plain LSP (the spike flags this as the most likely working feature).
 *
 * What is NOT enabled (requires projection — future milestone):
 *   - Completions / hover / go-to-definition inside markup-projected C# regions.
 *
 * NOTE: rzls acquisition is currently stubbed on the Rust side; on a fresh
 * machine `ensureRazorServer` rejects and the manager surfaces an error status
 * rather than crashing.
 */
import type { MonacoLanguageClient } from "monaco-languageclient";
import { ensureRazorServer, startLspServer } from "../../api";
import { createLanguageClient } from "../client";

export const RAZOR_SERVER_ID = "razor";

/** file:// URI for a workspace root, Windows-safe (`file:///C:/...`). */
function toFileUri(rootPath: string): string {
  let p = rootPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // drive paths -> /C:/...
  return "file://" + encodeURI(p);
}

/**
 * Acquires rzls, spawns it through the Rust bridge, and connects a language
 * client scoped to `language: razor`.
 */
export async function startRazorServer(
  rootPath: string
): Promise<MonacoLanguageClient> {
  // 1. Resolve the rzls executable (errors if not cached — download is stubbed).
  const program = await ensureRazorServer();

  // 2. Spawn rzls + bridge. Args are best-effort (see razor.rs / RAZOR-SPIKE.md);
  //    rzls speaks LSP over stdio.
  await startLspServer(RAZOR_SERVER_ID, program, ["--logLevel", "Information"], rootPath);

  // 3. Connect the generic client. initializationOptions are conservative; the
  //    spike documents which (if any) rzls actually honors over plain LSP.
  return createLanguageClient({
    serverId: RAZOR_SERVER_ID,
    name: "Razor Language Server",
    documentSelector: [{ scheme: "file", language: "razor" }],
    rootUri: toFileUri(rootPath),
    initializationOptions: {
      "razor.format.enable": true,
      "razor.completion.commitElementsWithSpace": false,
    },
  });
}
