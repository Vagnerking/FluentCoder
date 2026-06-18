import type { MonacoLanguageClient } from "monaco-languageclient";
import { stopLspServer } from "../api";
import { lspLog } from "./debug";
import {
  disposeLanguageClientContributions,
  type LspClientConfig,
} from "./client";
import { SERVER_REGISTRY, lspLanguageIds } from "./servers";
import type { LspWorkspaceInfo, ServerStarter } from "./servers";

export { lspLanguageIds };
export type { ServerStarter };

/**
 * Owns the lifecycle of every active LSP client. One instance per app. Decides
 * nothing about *when* to start servers — that is the hook's job (ISSUE-25) —
 * it only guarantees a single client per server id and clean teardown.
 */
export class LspManager {
  private clients = new Map<string, MonacoLanguageClient>();
  private starting = new Set<string>();

  /**
   * Starts the server for `language` rooted at `rootPath`. Idempotent: a no-op
   * if a client for that server is already running or starting.
   */
  async start(
    language: string,
    rootPath: string,
    onWorkspaceInfo?: (info: LspWorkspaceInfo) => void
  ): Promise<void> {
    const entry = SERVER_REGISTRY[language];
    if (!entry) return;
    const { serverId, start } = entry;
    if (this.clients.has(serverId) || this.starting.has(serverId)) {
      lspLog("manager.start SKIP (already running/starting)", serverId);
      return;
    }

    lspLog("manager.start BEGIN", { language, serverId });
    this.starting.add(serverId);
    try {
      const client = await start(rootPath, { onWorkspaceInfo });
      this.clients.set(serverId, client);
      lspLog("manager.start DONE", serverId);
    } catch (err) {
      lspLog("manager.start FAILED", serverId, String(err));
      throw err;
    } finally {
      this.starting.delete(serverId);
    }
  }

  /** Stops a single client and its backend process. */
  async stop(serverId: string): Promise<void> {
    lspLog("manager.stop CALLED", serverId, new Error().stack?.split("\n").slice(2, 5).join(" | "));
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (client) {
      disposeLanguageClientContributions(client);
      try {
        await client.stop();
      } catch {
        /* client may already be down */
      }
    }
    try {
      await stopLspServer(serverId);
    } catch {
      /* backend session may already be gone */
    }
  }

  /** Stops every client. Used on workspace change / app shutdown. */
  async stopAll(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** Server ids with a currently-live client. */
  activeServerIds(): string[] {
    return [...this.clients.keys()];
  }

  isActive(serverId: string): boolean {
    return this.clients.has(serverId);
  }
}

export type { LspClientConfig };
