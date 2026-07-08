import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emitTo } from "@tauri-apps/api/event";
import { EditorPane } from "./EditorPane";
import { ImagePreview } from "./ImagePreview";
import { MediaPreview } from "./MediaPreview";
import { TabBar } from "./TabBar";
import { Codicon } from "../icons/codicons/Codicon";
import { pickSavePath, writeFile, writeSshTextFile } from "../api";
import { useSnapLayout } from "../snap/useSnapLayout";
import { reorderFiles } from "../tabOrder";
import { setActiveRemote } from "../remote/host";
import {
  adoptTabInWindow,
  clearActiveEditor,
  cursorPosition,
  editorRelease,
  editorUpdate,
  openDetachedEditor,
  redockEditor,
  setActiveEditor,
  takeDetachedState,
  windowAtPosition,
  type DetachedRemote,
} from "../detach/editorWindow";
import { dropTargetAt } from "../detach/dropTarget";
import type { OpenFile } from "../types";

const UNTITLED_PREFIX = "untitled:";

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/**
 * A detached editor window (tear-off) — a full editor GROUP with its own tabs.
 * Rendered (instead of the workbench) by `main.tsx` when the URL carries a detach
 * token. It loads its state from the backend stash, persists edits back (so a
 * reload restores), reports focus so newly-opened files route here ("active
 * group"), and can re-dock the whole group to the main window.
 */
export function DetachedEditor({ token }: { token: string }) {
  const win = getCurrentWindow();
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [remote, setRemote] = useState<DetachedRemote | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [tabDragging, setTabDragging] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const [dropBar, setDropBar] = useState<
    { left: number; top: number; height: number } | null
  >(null);
  const [onTop, setOnTop] = useState(false);
  // Snap Layouts overlay on this window's maximize button (covers it, so hover
  // comes from the backend).
  const [maxHover, setMaxHover] = useState(false);
  const maxBtnRef = useRef<HTMLButtonElement>(null);
  useSnapLayout(maxBtnRef, setMaxHover);
  const filesRef = useRef(files);
  filesRef.current = files;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const lastHintRef = useRef<string | null>(null);
  const confirmedClose = useRef(false);

  // Load the group state.
  useEffect(() => {
    let cancelled = false;
    void takeDetachedState(token).then((s) => {
      if (cancelled) return;
      if (!s) {
        setMissing(true);
        return;
      }
      if (s.remote) {
        setActiveRemote(s.remote);
        setRemote(s.remote);
      }
      setFiles(s.files);
      setActivePath(s.activePath ?? s.files[0]?.path ?? null);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Persist the group (debounced) so a reload restores tabs + edits.
  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      void editorUpdate(token, { files, activePath, remote: remote ?? undefined });
    }, 400);
    return () => clearTimeout(id);
  }, [token, files, activePath, remote, loaded]);

  // Become the active editor group on focus (so new opens come here).
  useEffect(() => {
    void setActiveEditor(win.label, token);
    const un = win.onFocusChanged(({ payload: focused }) => {
      if (focused) void setActiveEditor(win.label, token);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [win, token]);

  // Receive files routed here: appended from the main window's explorer
  // ("open-in-detached"), or dragged in from another window ("adopt-tab"),
  // inserted where the cursor was.
  useEffect(() => {
    const insertAt = (f: OpenFile, targetPath: string | null, before: boolean) => {
      setFiles((prev) => {
        const without = prev.filter((x) => x.path !== f.path);
        let at = without.length;
        if (targetPath) {
          const ti = without.findIndex((x) => x.path === targetPath);
          at = ti < 0 ? without.length : before ? ti : ti + 1;
        }
        return [
          ...without.slice(0, at),
          { ...f, mode: f.mode ?? "text" },
          ...without.slice(at),
        ];
      });
      setActivePath(f.path);
    };
    const a = listen<{ file: OpenFile }>("open-in-detached", (e) =>
      insertAt(e.payload.file, null, false)
    );
    const b = listen<{ file: OpenFile; x?: number; y?: number }>(
      "adopt-tab",
      (e) => {
        const t =
          e.payload.x != null && e.payload.y != null
            ? dropTargetAt(e.payload.x, e.payload.y)
            : null;
        insertAt(e.payload.file, t?.targetPath ?? null, t?.before ?? false);
        setDropHint(false);
        setDropBar(null);
        void win.setFocus();
      }
    );
    return () => {
      void a.then((fn) => fn());
      void b.then((fn) => fn());
    };
  }, [win]);

  const active = files.find((f) => f.path === activePath) ?? null;

  const save = useCallback(async () => {
    if (!active) return;
    try {
      let targetPath = active.path;
      if (targetPath.startsWith(UNTITLED_PREFIX)) {
        const picked = await pickSavePath(active.name);
        if (!picked) return;
        targetPath = picked;
      }
      if (active.workspaceRemote && !active.path.startsWith(UNTITLED_PREFIX)) {
        await writeSshTextFile(active.workspaceRemote.connId, targetPath, active.content);
      } else {
        await writeFile(targetPath, active.content);
      }
      setFiles((prev) =>
        prev.map((f) =>
          f.path === active.path
            ? {
                ...f,
                path: targetPath,
                name: fileName(targetPath),
                dirty: false,
                workspaceRemote: active.path.startsWith(UNTITLED_PREFIX)
                  ? undefined
                  : f.workspaceRemote,
              }
            : f
        )
      );
      if (targetPath !== active.path) setActivePath(targetPath);
    } catch (err) {
      alert(`Não foi possível salvar:\n${err}`);
    }
  }, [active]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const closeWindow = useCallback((skipConfirm = false) => {
    const dirty = filesRef.current.filter((file) => file.dirty);
    if (
      !skipConfirm &&
      dirty.length > 0 &&
      !window.confirm(
        dirty.length === 1
          ? `Há alterações não salvas em ${dirty[0].name}. Fechar mesmo assim?`
          : `Há alterações não salvas em ${dirty.length} arquivos. Fechar mesmo assim?`
      )
    ) {
      return;
    }
    confirmedClose.current = true;
    // Hand "active" back to main so the next open never targets this dead label.
    void clearActiveEditor();
    void editorRelease(token).finally(() => void win.close());
  }, [token, win]);

  useEffect(() => {
    const unlisten = win.onCloseRequested((event) => {
      if (confirmedClose.current) return;
      event.preventDefault();
      closeWindow();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [win, closeWindow]);

  // Close a tab; closing the last one closes the window.
  const closeTab = useCallback(
    (path: string) => {
      const current = filesRef.current;
      const closing = current.find((file) => file.path === path);
      if (closing?.dirty && !window.confirm(`Descartar alterações em ${closing.name}?`)) return;
      const next = current.filter((file) => file.path !== path);
      if (next.length === 0) {
        closeWindow(true);
        return;
      }
      setFiles(next);
      setActivePath((activePath) =>
        activePath === path ? next[next.length - 1].path : activePath
      );
    },
    [closeWindow]
  );

  const reorder = useCallback((from: string, to: string, before: boolean) => {
    setFiles((prev) => reorderFiles(prev, from, to, before));
  }, []);

  // Dragged a tab off this window: drop it onto the window under the cursor (the
  // main window, another detached one) — or, on empty desktop, a fresh window on
  // that monitor. Dropping inside this same window is a no-op.
  const handleDetach = useCallback(
    async (path: string, x: number, y: number) => {
      const file = filesRef.current.find((f) => f.path === path);
      if (!file) return;
      // Real OS cursor — the HTML5 dragend coords freeze over other apps.
      try {
        const [cx, cy] = await cursorPosition();
        if (cx || cy) {
          x = cx;
          y = cy;
        }
      } catch {
        /* keep passed coords */
      }
      let target: string | null = null;
      try {
        target = await windowAtPosition(x, y, "");
      } catch {
        target = null;
      }
      if (target === win.label) return;
      if (target) {
        try {
          await adoptTabInWindow(target, file, { x, y });
          closeTab(path);
        } catch (err) {
          console.warn("Não foi possível mover a aba:", err);
        }
        return;
      }
      try {
        await openDetachedEditor(
          {
            files: [file],
            activePath: file.path,
            remote: remoteRef.current ?? undefined,
          },
          { x, y }
        );
        closeTab(path);
      } catch (err) {
        console.warn("Não foi possível destacar a aba:", err);
      }
    },
    [win.label, closeTab]
  );

  const toggleOnTop = useCallback(() => {
    setOnTop((cur) => {
      const next = !cur;
      void win.setAlwaysOnTop(next);
      return next;
    });
  }, [win]);

  // Cross-window drag feedback: continuously tell the OTHER window under the
  // cursor where it is, so it can place its own insertion indicator.
  const handleDragMove = useCallback(
    async (x: number, y: number) => {
      let target: string | null = null;
      try {
        target = await windowAtPosition(x, y, "");
      } catch {
        target = null;
      }
      const hint = target && target !== win.label ? target : null;
      if (lastHintRef.current && lastHintRef.current !== hint) {
        void emitTo(lastHintRef.current, "drop-hint", { active: false });
      }
      lastHintRef.current = hint;
      if (hint) void emitTo(hint, "drop-hint", { active: true, x, y });
    },
    [win.label]
  );
  const clearDragHint = useCallback(() => {
    if (lastHintRef.current) {
      void emitTo(lastHintRef.current, "drop-hint", { active: false });
      lastHintRef.current = null;
    }
  }, []);

  // Poll the global cursor while dragging (HTML5 `drag` freezes off-window).
  const dragPoll = useRef(0);
  const startDragPoll = useCallback(() => {
    if (dragPoll.current) return;
    dragPoll.current = window.setInterval(async () => {
      try {
        const [x, y] = await cursorPosition();
        void handleDragMove(x, y);
      } catch {
        /* ignore */
      }
    }, 50);
  }, [handleDragMove]);
  const stopDragPoll = useCallback(() => {
    if (dragPoll.current) {
      clearInterval(dragPoll.current);
      dragPoll.current = 0;
    }
  }, []);

  // React to hints aimed at this window: resolve to a tab-strip insertion bar or
  // a whole-window highlight.
  useEffect(() => {
    const un = listen<{ active: boolean; x?: number; y?: number }>(
      "drop-hint",
      (e) => {
        if (!e.payload.active || e.payload.x == null || e.payload.y == null) {
          setDropHint(false);
          setDropBar(null);
          return;
        }
        const t = dropTargetAt(e.payload.x, e.payload.y);
        if (t) {
          setDropBar(t.bar);
          setDropHint(false);
        } else {
          setDropBar(null);
          setDropHint(true);
        }
      }
    );
    const reset = () => {
      setTabDragging(false);
      setDropHint(false);
      setDropBar(null);
      clearDragHint();
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      void un.then((fn) => fn());
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [clearDragHint]);

  if (missing) {
    return (
      <div className="detached-window">
        <div className="detached-empty">Este editor não está mais disponível.</div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="detached-window">
        <div className="detached-empty">Abrindo editor…</div>
      </div>
    );
  }

  const mode = active?.mode ?? "text";
  const activeRemoteConnId = active?.workspaceRemote?.connId ?? remote?.connId;
  const activeRootPath = active?.workspaceRemote?.rootPath ?? remote?.rootPath ?? null;

  return (
    <div className="detached-window">
      <div className="detached-titlebar" data-tauri-drag-region>
        <span className="detached-title" data-tauri-drag-region>
          {active?.name ?? "Editor"}
        </span>
        <div className="detached-controls" data-tauri-drag-region>
          <button
            type="button"
            className="detached-redock"
            title="Trazer estes editores de volta para a janela principal"
            onClick={() =>
              void redockEditor(token, {
                files,
                activePath,
                remote: remote ?? undefined,
              })
            }
          >
            <Codicon name="splitEditor" />
            Acoplar de volta
          </button>
          <button
            type="button"
            className={`caption-btn detached-pin${onTop ? " active" : ""}`}
            title={onTop ? "Desafixar janela" : "Fixar janela sempre no topo"}
            aria-label="Fixar janela no topo"
            aria-pressed={onTop}
            onClick={toggleOnTop}
          >
            <svg width="13" height="13" viewBox="0 0 16 16">
              <path
                d="M9.6 1.8 L14.2 6.4 L11.7 6.9 L9.1 9.5 L8.7 12.4 L7.3 11 L4.4 13.9 L3.7 13.2 L6.6 10.3 L5.2 8.9 L7.8 6.3 L8.3 3.8 Z"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinejoin="round"
                fill={onTop ? "currentColor" : "none"}
              />
            </svg>
          </button>
          <button
            type="button"
            className="caption-btn"
            title="Minimizar"
            aria-label="Minimizar"
            onClick={() => win.minimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            ref={maxBtnRef}
            type="button"
            className={`caption-btn${maxHover ? " nc-hover" : ""}`}
            title="Maximizar"
            aria-label="Maximizar"
            onClick={() => win.toggleMaximize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" />
            </svg>
          </button>
          <button
            type="button"
            className="caption-btn caption-close"
            title="Fechar"
            aria-label="Fechar"
            onClick={() => closeWindow()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>

      <TabBar
        files={files}
        activePath={activePath}
        groupId={win.label}
        onSelect={setActivePath}
        onClose={closeTab}
        onCloseAll={closeWindow}
        onCloseOthers={(p) => {
          setFiles((prev) => prev.filter((f) => f.path === p));
          setActivePath(p);
        }}
        onCloseLeft={(p) => {
          setFiles((prev) => {
            const i = prev.findIndex((f) => f.path === p);
            return i <= 0 ? prev : prev.slice(i);
          });
        }}
        onCloseRight={(p) => {
          setFiles((prev) => {
            const i = prev.findIndex((f) => f.path === p);
            return i < 0 ? prev : prev.slice(0, i + 1);
          });
        }}
        onReorder={reorder}
        onDetach={handleDetach}
        onDragStateChange={(d) => {
          setTabDragging(!!d);
          if (d) startDragPoll();
          else {
            stopDragPoll();
            clearDragHint();
          }
        }}
        onDragMove={handleDragMove}
      />

      <div className="detached-body">
        {!active ? (
          <div className="detached-empty">Sem arquivos abertos.</div>
        ) : mode === "image" ? (
          <ImagePreview path={active.path} name={active.name} connId={activeRemoteConnId} />
        ) : mode === "video" || mode === "audio" ? (
          <MediaPreview
            path={active.path}
            name={active.name}
            kind={mode}
            connId={activeRemoteConnId}
          />
        ) : (
          <EditorPane
            file={active}
            rootPath={activeRootPath}
            onChange={(v) =>
              setFiles((prev) =>
                prev.map((f) =>
                  f.path === active.path ? { ...f, content: v, dirty: true } : f
                )
              )
            }
            onCursorChange={() => {}}
            onProblemsChange={() => {}}
          />
        )}
        {/* Shield: while dragging a tab, keep Monaco from grabbing the drag (it
            would move its own cursor/scroll). No drop-zones here — this window
            has no splits; a drop on the body just isn't a tear-off. */}
        {tabDragging && <div className="drop-capture" />}
      </div>
      {/* A tab from another window is hovering this one. */}
      {dropHint && <div className="window-drop-hint" aria-hidden="true" />}
      {dropBar && (
        <div
          className="x-insert-bar"
          aria-hidden="true"
          style={{ left: dropBar.left, top: dropBar.top, height: dropBar.height }}
        />
      )}
    </div>
  );
}
