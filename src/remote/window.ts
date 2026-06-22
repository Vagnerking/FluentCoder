/**
 * Legacy remote-window attach payload. New connections now reuse the current
 * workbench; this reader remains so a remote window that was already open during
 * a development reload can still finish attaching safely.
 */

export interface RemoteAttach {
  connId: string;
  host: string;
  user: string;
  rootPath: string;
}

/**
 * Reads this window's remote-attach payload from the URL, if it was opened as a
 * remote window. Returns null for the ordinary (local) main window.
 */
export function readRemoteAttach(): RemoteAttach | null {
  try {
    const raw = new URLSearchParams(window.location.search).get("remoteAttach");
    if (!raw) return null;
    const attach = JSON.parse(decodeURIComponent(atob(raw))) as RemoteAttach;
    if (!attach.connId || !attach.rootPath) return null;
    return attach;
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
