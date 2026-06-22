/**
 * Multi-window editor groups (tear-off tabs, VS Code style).
 *
 * A detached window is a same-process `WebviewWindow` editor group: it holds its
 * own set of tabs. Its full state travels through a backend stash by token
 * (`editor_stash`/`editor_take`/`editor_update`/`editor_release`) instead of the
 * URL, so it survives reloads and large/dirty buffers. The active group (which
 * window receives newly-opened files) is tracked in the backend via focus; the
 * main window routes opens to a detached group with `emitTo(...,"open-in-detached")`.
 * Re-docking emits `redock-editor` and the main window reopens the tabs.
 */
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import type { OpenFile } from "../types";

export interface DetachedRemote {
  connId: string;
  host: string;
  user: string;
  rootPath: string;
}

/** The full state of a detached editor window (an editor group). */
export interface DetachedState {
  files: OpenFile[];
  activePath: string | null;
  /** Present when these files live on a remote SSH host (so saves route over SFTP). */
  remote?: DetachedRemote;
}

let seq = 0;

/**
 * Opens a detached editor window for `state`. When `pos` (screen/logical pixels,
 * e.g. where a tab was dropped) is given, the window spawns there — so a tear-off
 * lands on the monitor the user dropped it on. Rejects if creation fails.
 */
export async function openDetachedEditor(
  state: DetachedState,
  pos?: { x: number; y: number }
): Promise<void> {
  const token = await invoke<string>("editor_stash", {
    payload: JSON.stringify(state),
  });
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("detach", token);

    const first = state.files.find((f) => f.path === state.activePath) ?? state.files[0];
    const label = `editor-${Date.now()}-${seq++}`;
    const win = new WebviewWindow(label, {
    url: url.toString(),
    title: first?.name ?? "Editor",
    width: 900,
    height: 680,
    minWidth: 400,
    minHeight: 300,
    decorations: false,
    transparent: true,
    // Born WITHOUT stealing activation. Focusing the new window deactivated the
    // window the tab came from, and when a fullscreen app (e.g. VS Code) sits
    // behind it, Windows MINIMISES the window that just lost focus to hand the
    // screen back to the fullscreen app. Not activating the new window keeps the
    // source put; it still shows on top (SW_SHOWNOACTIVATE) — click it to focus.
    focus: false,
    windowEffects: { effects: [Effect.Mica] },
    // Drop the window with its titlebar roughly under the cursor.
    ...(pos ? { x: Math.round(pos.x - 90), y: Math.round(pos.y - 12) } : {}),
    });

    await new Promise<void>((resolve, reject) => {
      void win.once("tauri://created", () => resolve());
      void win.once("tauri://error", (e) =>
        reject(new Error(String((e as { payload?: unknown }).payload ?? "erro")))
      );
    });
  } catch (error) {
    await editorRelease(token).catch(() => {});
    throw error;
  }
  // No setFocus / always-on-top here on purpose: any activation of the new window
  // deactivates the source, which Windows then minimises behind a fullscreen app.
}

/** Label of the app window under a screen point (null = empty desktop / other
 *  app). Used to decide between moving a tab to an existing window vs spawning. */
export function windowAtPosition(
  x: number,
  y: number,
  exclude = ""
): Promise<string | null> {
  return invoke<string | null>("window_at_position", { x, y, exclude });
}

/** Global cursor position in logical/CSS pixels — polled during a drag because
 *  HTML5 `drag` events stop firing once the cursor leaves the source window. */
export function cursorPosition(): Promise<[number, number]> {
  return invoke<[number, number]>("cursor_position");
}

/** Hands a dragged tab to an existing window (it adopts the file as a tab). The
 *  optional screen position lets the target insert it where the cursor was. */
export async function adoptTabInWindow(
  label: string,
  file: OpenFile,
  pos?: { x: number; y: number }
): Promise<void> {
  await emitTo(label, "adopt-tab", { file, x: pos?.x, y: pos?.y });
  try {
    const win = await WebviewWindow.getByLabel(label);
    await win?.setFocus();
  } catch {
    // focus is best-effort
  }
}

/** This window's detach token, if it was opened as a detached editor group. */
export function readDetachToken(): string | null {
  return new URLSearchParams(window.location.search).get("detach");
}

/** Reads the stashed group state for `token` (peek — survives reload). */
export async function takeDetachedState(token: string): Promise<DetachedState | null> {
  const json = await invoke<string | null>("editor_take", { token });
  if (!json) return null;
  try {
    return JSON.parse(json) as DetachedState;
  } catch {
    return null;
  }
}

/** Persists the group state (debounced by callers) so a reload restores it. */
export function editorUpdate(token: string, state: DetachedState): Promise<void> {
  return invoke("editor_update", { token, payload: JSON.stringify(state) });
}

/** Frees a stashed group (on re-dock or window close). */
export function editorRelease(token: string): Promise<void> {
  return invoke("editor_release", { token });
}

/**
 * Sends the whole group back to the main window (reusing the token) and closes
 * it. The main window peeks the token, reopens the tabs and releases it.
 */
export async function redockEditor(
  token: string,
  state: DetachedState
): Promise<void> {
  await editorUpdate(token, state);
  // This group is going away — hand "active" back to the main window so the next
  // open lands there (never on this dead label).
  await clearActiveEditor();
  await emitTo("main", "redock-editor", { token });
  await getCurrentWindow().close();
}

// ---- Active editor group (which window receives newly-opened files) ----

export interface ActiveEditor {
  label: string;
  token: string;
}

/** Marks a detached window (by label + token) as the active editor group. */
export function setActiveEditor(label: string, token: string): Promise<void> {
  return invoke("set_active_editor", { label, token });
}

/** Marks the main window as the active editor group (the home group). */
export function clearActiveEditor(): Promise<void> {
  return invoke("clear_active_editor");
}

/** The active detached group, or null when the main window is active. */
export function getActiveEditor(): Promise<ActiveEditor | null> {
  return invoke<ActiveEditor | null>("get_active_editor");
}

/** Routes a file into a detached editor group (adds it as a tab there). */
export function openInDetached(label: string, file: OpenFile): Promise<void> {
  return emitTo(label, "open-in-detached", { file });
}
