/**
 * Active remote (SSH) host — issue #8, Phase 1.
 *
 * VS Code's Remote-SSH attaches a *window* to one host: while attached, the
 * explorer, open files and (later) terminal/search/git all target the remote.
 * We mirror that with a single ambient "active remote session". The plain
 * `readDir`/`readFile` helpers in {@link ../api} consult it and transparently
 * route to the SFTP-backed Tauri commands when a session is active, so the
 * explorer and editor need no per-call host parameter.
 *
 * The store is a module singleton (not React state) because those FS helpers are
 * called from many non-component code paths; `App` keeps a React copy in sync
 * for rendering the connection status and sets both together.
 */

/** A live SSH attachment: the backend connection id + display metadata + root. */
export interface RemoteSession {
  /** Connection id returned by the `ssh_connect` command. */
  connId: string;
  /** Host the session is attached to (for status/labels). */
  host: string;
  /** Remote user. */
  user: string;
  /** Absolute POSIX path of the opened remote folder (the workspace root). */
  rootPath: string;
  /**
   * The credentials used to open this session, kept in memory (never persisted)
   * so the connection can be re-established if it drops. Absent for sessions
   * restored without credentials.
   */
  input?: import("../api").SshConnectInput;
}

let active: RemoteSession | null = null;

/** The current remote attachment, or null when working locally. */
export function getActiveRemote(): RemoteSession | null {
  return active;
}

/** True while a remote folder is attached (FS routes to SFTP). */
export function isRemoteActive(): boolean {
  return active !== null;
}

/** Attaches/detaches the remote session. Pass null to return to local mode. */
export function setActiveRemote(session: RemoteSession | null): void {
  active = session;
}
