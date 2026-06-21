/**
 * Multi-window remote attach (issue #8) — VS Code-style "open the remote in its
 * own window".
 *
 * After the user connects and picks a folder, the connection's **ownership is
 * handed off** to a fresh app window: the original window stays local, and the
 * new window attaches to the already-open SSH connection. The connection id and
 * (non-secret) metadata travel in the new window's URL; the password is never
 * passed (so a reconnect there re-prompts).
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Effect } from "@tauri-apps/api/window";

export interface RemoteAttach {
  connId: string;
  host: string;
  user: string;
  rootPath: string;
}

let windowSeq = 0;

/**
 * Opens a new window attached to an existing remote connection. Resolves once the
 * window is created; rejects if creation fails (so the caller can fall back to an
 * in-place attach).
 */
export async function openRemoteWindow(attach: RemoteAttach): Promise<void> {
  const payload = btoa(encodeURIComponent(JSON.stringify(attach)));
  const url = new URL(window.location.href);
  url.searchParams.set("remoteAttach", payload);

  const label = `remote-${Date.now()}-${windowSeq++}`;
  // Mirror the main window's frameless chrome (custom title bar + Mica acrylic);
  // otherwise the new window shows the native OS frame on top of our title bar.
  const win = new WebviewWindow(label, {
    url: url.toString(),
    title: `${attach.user}@${attach.host} — Fluent Coder`,
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    resizable: true,
    decorations: false,
    transparent: true,
    windowEffects: { effects: [Effect.Mica] },
  });

  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (e) =>
      reject(new Error(String((e as { payload?: unknown }).payload ?? "erro")))
    );
  });
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
