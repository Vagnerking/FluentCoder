/** Payload used to hand a live SSH connection to a new workbench window. */

export interface RemoteAttach {
  connId: string;
  host: string;
  user: string;
  rootPath: string;
}

export interface LocalAttach {
  rootPath: string;
}

/** A new SSH connection only replaces a workbench that has no project open. */
export function shouldOpenRemoteInNewWindow(
  currentRootPath: string | null,
  isNewConnection: boolean
): boolean {
  return isNewConnection && currentRootPath !== null;
}

/** Encodes the payload with URL-safe base64, including Unicode paths and users. */
function encodeAttachPayload(attach: RemoteAttach | LocalAttach): string {
  const bytes = new TextEncoder().encode(JSON.stringify(attach));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeAttachPayload(payload: string): unknown {
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function encodeRemoteAttach(attach: RemoteAttach): string {
  return encodeAttachPayload(attach);
}

export function encodeLocalAttach(attach: LocalAttach): string {
  return encodeAttachPayload(attach);
}

export function decodeRemoteAttach(payload: string): RemoteAttach | null {
  try {
    const attach = decodeAttachPayload(payload) as RemoteAttach | null;
    if (!attach?.connId || !attach.rootPath) return null;
    return attach;
  } catch {
    return null;
  }
}

export function decodeLocalAttach(payload: string): LocalAttach | null {
  try {
    const attach = decodeAttachPayload(payload) as LocalAttach | null;
    if (!attach?.rootPath) return null;
    return attach;
  } catch {
    return null;
  }
}

/**
 * Reads this window's remote-attach payload from the URL, if it was opened as a
 * remote window. Returns null for the ordinary (local) main window.
 */
export function readRemoteAttach(): RemoteAttach | null {
  try {
    const raw = new URLSearchParams(window.location.search).get("remoteAttach");
    if (!raw) return null;
    return decodeRemoteAttach(raw);
  } catch {
    return null;
  }
}

/** Reads this window's local-folder attach payload from the URL, if present. */
export function readLocalAttach(): LocalAttach | null {
  try {
    const raw = new URLSearchParams(window.location.search).get("localAttach");
    if (!raw) return null;
    return decodeLocalAttach(raw);
  } catch {
    return null;
  }
}

/**
 * Removes the `remoteAttach` query param from the URL after consuming it, so a
 * window reload doesn't try to re-attach a stale connection id.
 */
export function clearRemoteAttachParam(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.has("remoteAttach")) {
    url.searchParams.delete("remoteAttach");
    window.history.replaceState(null, "", url.toString());
  }
}

export function clearLocalAttachParam(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.has("localAttach")) {
    url.searchParams.delete("localAttach");
    window.history.replaceState(null, "", url.toString());
  }
}
