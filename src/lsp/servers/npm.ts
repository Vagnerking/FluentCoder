/**
 * Generic adapter for npm-distributed language servers.
 *
 * Backend `lsp_ensure_npm_server` installs the server into the app cache on first
 * use; this wires the resulting `node <entry> <args>` command to the WS bridge
 * and a `MonacoLanguageClient`. Adding a language is one entry in `NPM_SERVERS`
 * (and the matching backend spec) — no new adapter module.
 */
import { ensureNpmLspServer, startLspServer } from "../../api";
import { createLanguageClient, type RunningClient } from "../client";
import type { ServerStarter } from "./index";

/** One npm-based server: its id, the languages it serves, and a display name. */
export interface NpmServerConfig {
  /** Session id = backend spec id (kept equal to the primary language id). */
  serverId: string;
  /** Friendly client name. */
  name: string;
  /** Monaco language ids this server handles (drives the document selector). */
  languages: string[];
  /** Optional server-specific `initialize` options. */
  initializationOptions?: unknown;
}

/** file:// URI for a workspace root, Windows-safe (`file:///C:/...`). */
function toFileUri(rootPath: string): string {
  let p = rootPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // drive paths -> /C:/...
  return "file://" + encodeURI(p);
}

/** Builds a {@link ServerStarter} for an npm-based server config. */
export function makeNpmServerStarter(config: NpmServerConfig): ServerStarter {
  return async function start(rootPath: string): Promise<RunningClient> {
    const { program, args } = await ensureNpmLspServer(config.serverId);
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
 * The npm-based servers we support out of the box. Each maps to a backend spec
 * in `npm_server.rs` with the same `serverId`. New language = one line here.
 */
export const NPM_SERVERS: NpmServerConfig[] = [
  { serverId: "python", name: "Pyright", languages: ["python"] },
  { serverId: "yaml", name: "YAML Language Server", languages: ["yaml"] },
  { serverId: "json", name: "JSON Language Server", languages: ["json"] },
  { serverId: "html", name: "HTML Language Server", languages: ["html"] },
  {
    serverId: "css",
    name: "CSS Language Server",
    languages: ["css", "scss", "less"],
  },
  { serverId: "shell", name: "Bash Language Server", languages: ["shell"] },
  {
    serverId: "dockerfile",
    name: "Dockerfile Language Server",
    languages: ["dockerfile"],
  },
];
