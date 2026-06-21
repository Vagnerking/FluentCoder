/**
 * Adapter for language servers that ship with the user's SDK/toolchain and are
 * launched straight from the PATH (no download): Dart, Go, …
 *
 * Backend `lsp_ensure_system_server` locates the SDK's server executable; this
 * wires it to the WS bridge and a `MonacoLanguageClient`. Adding a language is
 * one entry in `SYSTEM_SERVERS` (and the matching backend spec).
 */
import { ensureSystemLspServer, startLspServer } from "../../api";
import { createLanguageClient, type RunningClient } from "../client";
import type { ServerStarter } from "./index";

/** One SDK-provided server: its id, the languages it serves, and a name. */
export interface SystemServerConfig {
  /** Session id = backend spec id (kept equal to the primary language id). */
  serverId: string;
  name: string;
  languages: string[];
  initializationOptions?: unknown;
}

/** file:// URI for a workspace root, Windows-safe (`file:///C:/...`). */
function toFileUri(rootPath: string): string {
  let p = rootPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // drive paths -> /C:/...
  return "file://" + encodeURI(p);
}

/** Builds a {@link ServerStarter} for a PATH-resolved SDK server config. */
export function makeSystemServerStarter(config: SystemServerConfig): ServerStarter {
  return async function start(rootPath: string): Promise<RunningClient> {
    const { program, args } = await ensureSystemLspServer(config.serverId);
    await startLspServer(config.serverId, program, args, rootPath);

    return createLanguageClient({
      serverId: config.serverId,
      name: config.name,
      documentSelector: config.languages.map((language) => ({
        scheme: "file",
        language,
      })),
      rootUri: toFileUri(rootPath),
      initializationOptions: config.initializationOptions,
    });
  };
}

/**
 * SDK-provided servers we use from the PATH. Each maps to a backend spec in
 * `system_server.rs` with the same `serverId`. New language = one line here.
 */
export const SYSTEM_SERVERS: SystemServerConfig[] = [
  { serverId: "dart", name: "Dart Language Server", languages: ["dart"] },
  { serverId: "go", name: "gopls", languages: ["go"] },
];
