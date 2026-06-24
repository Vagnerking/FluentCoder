/**
 * Persistence of the last remote (SSH) target — issue #8, Phase 1 acceptance:
 * "remember the connection and last remote folder across restarts".
 *
 * Only NON-secret fields are stored (host/port/user/keyPath/remotePath); the
 * password and key passphrase are never persisted. On the next launch the
 * connect dialog is prefilled from this, so reconnecting only needs the secret.
 */

const STORAGE_KEY = "ssh.lastTarget";

/** The reconnect-able shape of a remote target (no secrets). */
export interface RemoteTarget {
  host: string;
  port: number;
  user: string;
  /** Private-key path, when key auth was used (no passphrase stored). */
  keyPath?: string;
  /** The remote folder that was open. */
  remotePath: string;
}

/** Reads the last remote target, or null if none/invalid. */
export function loadLastRemoteTarget(): RemoteTarget | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RemoteTarget>;
    if (!parsed.host || !parsed.user) return null;
    return {
      host: parsed.host,
      port: typeof parsed.port === "number" ? parsed.port : 22,
      user: parsed.user,
      keyPath: parsed.keyPath,
      remotePath: parsed.remotePath ?? ".",
    };
  } catch {
    return null;
  }
}

/** Stores the last remote target (secrets stripped). */
export function saveLastRemoteTarget(target: RemoteTarget): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}
