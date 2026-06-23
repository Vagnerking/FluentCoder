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
  // Per-server operation chain: start/stop for the same server id run strictly in
  // order. A start queued after a stop waits for that stop; a fresh start during
  // a slow in-flight start (e.g. the projection broker's `dotnet build`, up to
  // ~180s) waits it out, so a workspace switch / "Resetar Servidores" never ends
  // up with a stale client or a skipped restart. See razorProjection.ts.
  private chains = new Map<string, Promise<unknown>>();
  // Per-server generation. Bumped on every stop / stopAll so an in-flight start
  // that finishes AFTER its session was torn down detects the supersession and
  // discards its client instead of registering it over the new session.
  private generations = new Map<string, number>();

  private bump(serverId: string): void {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
  }

  /** Serializes `op` after any pending start/stop for `serverId` (runs regardless of its outcome). */
  private enqueue<T>(serverId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(serverId) ?? Promise.resolve();
    const next = prev.then(op, op);
    // Keep the chain alive even if this op rejects, but hand the real promise
    // (with its rejection) back to the caller.
    this.chains.set(serverId, next.then(
      () => undefined,
      () => undefined
    ));
    return next;
  }

  /**
   * Starts the server for `language` rooted at `rootPath`. Idempotent: a no-op
   * if a client for that server is already running. Serialized per server id, so
   * it cleanly follows any in-flight start/stop for the same server.
   */
  async start(
    language: string,
    rootPath: string,
    onWorkspaceInfo?: (info: LspWorkspaceInfo) => void
  ): Promise<void> {
    const entry = SERVER_REGISTRY[language];
    if (!entry) return;
    const { serverId, start } = entry;
    await this.enqueue(serverId, async () => {
      if (this.clients.has(serverId)) {
        lspLog("manager.start SKIP (already running)", serverId);
        return;
      }
      lspLog("manager.start BEGIN", { language, serverId });
      const startGen = this.generations.get(serverId) ?? 0;
      let client: MonacoLanguageClient;
      try {
        client = await start(rootPath, { onWorkspaceInfo });
      } catch (err) {
        lspLog("manager.start FAILED", serverId, String(err));
        throw err;
      }
      // A stop/stopAll raced this start to completion (workspace switch / reset
      // during a long `razorPrepare`). Discard the orphaned client instead of
      // registering it over the torn-down session.
      if ((this.generations.get(serverId) ?? 0) !== startGen) {
        lspLog("manager.start STALE (superseded by stop); discarding", serverId);
        disposeLanguageClientContributions(client);
        await client.stop().catch(() => {});
        await stopLspServer(serverId).catch(() => {});
        return;
      }
      this.clients.set(serverId, client);
      lspLog("manager.start DONE", serverId);
    });
  }

  /** Stops a single client and its backend process. */
  async stop(serverId: string): Promise<void> {
    lspLog("manager.stop CALLED", serverId, new Error().stack?.split("\n").slice(2, 5).join(" | "));
    this.bump(serverId); // invalidate any in-flight start synchronously
    await this.enqueue(serverId, async () => {
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
    });
  }

  /** Stops every client. Used on workspace change / app shutdown. */
  async stopAll(): Promise<void> {
    // Union of live clients and servers with a pending start/stop, so a slow
    // in-flight start (not yet in `clients`) is invalidated and torn down too.
    const ids = new Set<string>([...this.clients.keys(), ...this.chains.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
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
