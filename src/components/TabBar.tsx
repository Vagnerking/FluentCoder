import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { OpenFile, FileDecoration } from "../types";
import type { Edge } from "../editorGroups";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";

/** dataTransfer MIME carrying a dragged tab's {groupId, path} across groups. */
export const TAB_DRAG_MIME = "application/x-fluent-tab";

export interface TabDragPayload {
  groupId: string;
  path: string;
}

/** Reads {groupId, path} from a tab-drag dataTransfer (null if not ours). */
export function readTabDragPayload(dt: DataTransfer): TabDragPayload | null {
  const raw = dt.getData(TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TabDragPayload;
  } catch {
    return null;
  }
}

interface TabContextMenu {
  x: number;
  y: number;
  path: string;
}

interface TabBarProps {
  files: OpenFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
  /**
   * Closes a tab. Async because a dirty tab prompts a save/discard/cancel
   * dialog before closing — callers fire-and-forget (no need to await).
   */
  onClose: (path: string) => void | Promise<void>;
  onCloseAll: () => void;
  onCloseOthers: (path: string) => void;
  onCloseLeft: (path: string) => void;
  onCloseRight: (path: string) => void;
  /** Tears the tab off into its own window ("Mover para Nova Janela"). */
  onMoveToNewWindow?: (path: string) => void;
  /**
   * Tears the tab off by DRAGGING it off the tab area. Receives the screen
   * coordinates where it was dropped, so the app can move it to whichever window
   * is under the cursor (or spawn a new one there, on the right monitor).
   */
  onDetach?: (path: string, screenX: number, screenY: number) => void;
  /**
   * Reorders tabs: move `fromPath` to sit just before (`before=true`) or after
   * (`before=false`) `toPath`, matching the drop-side the user aimed at.
   */
  onReorder?: (fromPath: string, toPath: string, before: boolean) => void;
  /** This tab strip's editor-group id, stamped on the drag payload so other
   *  groups know where a dropped tab came from. */
  groupId?: string;
  /** True while a tab is being dragged anywhere in this window — lets THIS strip
   *  accept a tab from ANOTHER division (showing the insertion bar). */
  externalDragActive?: boolean;
  /** A tab from another division was dropped on this strip at `targetPath`
   *  (before/after it; null targetPath = appended at the end). */
  onTabStripDrop?: (
    payload: TabDragPayload,
    targetPath: string | null,
    before: boolean
  ) => void;
  /** Notifies when a tab drag starts/ends, so groups can shield their editors
   *  (drop-zone overlay) while a tab is in flight. Carries the dragged tab's
   *  {groupId, path} on start (the payload is unreadable during dragover, so the
   *  app keeps it to judge whether a drop would do anything) and null on end. */
  onDragStateChange?: (drag: TabDragPayload | null) => void;
  /** Throttled live screen position during a tab drag — used to hint which
   *  window the tab would drop on (cross-window drag feedback). */
  onDragMove?: (screenX: number, screenY: number) => void;
  /** Splits the editor: copies the active tab into a new group on `edge`
   *  (the "Split Editor" button). When set, a split button shows at the right. */
  onSplit?: (edge: Edge) => void;
  /** Resolves the git/diagnostic decoration for a path; default = none. */
  decorationFor?: (path: string) => FileDecoration | undefined;
}

/** Row of open-file tabs above the editor, each with its Material file icon. */
export function TabBar({
  files,
  activePath,
  onSelect,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onMoveToNewWindow,
  onDetach,
  onReorder,
  groupId,
  externalDragActive,
  onTabStripDrop,
  onDragStateChange,
  onDragMove,
  onSplit,
  decorationFor = () => undefined,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // Which edge of the hovered tab the insertion bar sits on (VS Code aims the
  // drop before/after the target depending on which half the cursor is over).
  const [dragOverSide, setDragOverSide] = useState<"left" | "right">("left");
  // Insertion bar after the last tab (dropping a tab onto the empty strip area).
  const [dropAtEnd, setDropAtEnd] = useState(false);
  // Whether there are hidden tabs to the left/right (drives the scroll fades).
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const menuRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // Edge auto-scroll while dragging near the row's left/right border.
  const autoScroll = useRef({ dir: 0, raf: 0, clientX: 0 });
  // Last screen coords seen during the drag — `dragend` alone can report stale
  // or clamped coords when dropping over another window, so the live `drag`
  // event keeps a reliable fallback.
  const lastDragScreen = useRef({ x: 0, y: 0 });
  // Throttle the cross-window hint (a per-frame backend hit-test would be wasteful).
  const lastHintTime = useRef(0);

  // Recompute the scroll fades when the row scrolls, resizes, or its tabs change.
  const syncOverflow = () => {
    const el = barRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft < max - 1,
    });
  };
  useEffect(() => {
    syncOverflow();
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncOverflow);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

  // Drives the edge auto-scroll: while a drag hovers within EDGE px of a border
  // (and there's more to reveal), the row scrolls that way each frame so you can
  // reorder into off-screen tabs.
  const stopAutoScroll = () => {
    if (autoScroll.current.raf) cancelAnimationFrame(autoScroll.current.raf);
    autoScroll.current = { dir: 0, raf: 0, clientX: 0 };
  };
  const tickAutoScroll = () => {
    const el = barRef.current;
    const st = autoScroll.current;
    if (!el || st.dir === 0) {
      st.raf = 0;
      return;
    }
    el.scrollLeft += st.dir * 12;
    syncOverflow();
    st.raf = requestAnimationFrame(tickAutoScroll);
  };
  const updateAutoScroll = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const EDGE = 44;
    const r = el.getBoundingClientRect();
    const max = el.scrollWidth - el.clientWidth;
    let dir = 0;
    if (clientX < r.left + EDGE && el.scrollLeft > 0) dir = -1;
    else if (clientX > r.right - EDGE && el.scrollLeft < max) dir = 1;
    autoScroll.current.dir = dir;
    if (dir !== 0 && !autoScroll.current.raf) {
      autoScroll.current.raf = requestAnimationFrame(tickAutoScroll);
    }
  };

  useEffect(() => () => stopAutoScroll(), []);

  // When an external drag (from another division) ends, drop our insertion hints.
  useEffect(() => {
    if (!externalDragActive) {
      setDropAtEnd(false);
      if (!dragPath) setDragOverPath(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalDragActive]);

  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  if (files.length === 0) return null;

  const targetIndex = files.findIndex((f) => f.path === contextMenu?.path);
  const hasLeft = targetIndex > 0;
  const hasRight = targetIndex < files.length - 1;
  const hasOthers = files.length > 1;

  return (
    <>
      <div className="tab-strip">
      <div className="tab-bar-wrap">
        <div
          className={`tab-fade left${overflow.left ? " show" : ""}`}
          aria-hidden="true"
        />
        <div
          className={`tab-fade right${overflow.right ? " show" : ""}`}
          aria-hidden="true"
        />
        <div
          className="tab-bar"
          ref={barRef}
          role="tablist"
          aria-label="Abas abertas"
          data-group-id={groupId}
          onScroll={syncOverflow}
          // No visible scrollbar: let the wheel scroll the row horizontally so the
          // overflowing tabs "slide" left/right into view.
          onWheel={(e) => {
            const el = barRef.current;
            if (!el || el.scrollWidth <= el.clientWidth) return;
            const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            if (delta !== 0) el.scrollLeft += delta;
          }}
          // While dragging near an edge, auto-scroll the row so off-screen tabs
          // become reachable drop targets. A tab from another division dropped on
          // the empty strip area is appended at the end.
          onDragOver={(e) => {
            if (dragPath) updateAutoScroll(e.clientX);
            const external = !dragPath && externalDragActive;
            if (external && e.target === e.currentTarget) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverPath(null);
              setDropAtEnd(true);
            }
          }}
          onDrop={(e) => {
            if (!dragPath && externalDragActive && e.target === e.currentTarget) {
              e.preventDefault();
              const payload = readTabDragPayload(e.dataTransfer);
              if (payload) onTabStripDrop?.(payload, null, false);
              setDragOverPath(null);
              setDropAtEnd(false);
            }
          }}
          onDragLeave={(e) => {
            autoScroll.current.dir = 0;
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDropAtEnd(false);
              if (!dragPath) setDragOverPath(null);
            }
          }}
        >
          {files.map((f) => {
            const deco = decorationFor(f.path);
            const accepting = dragPath ? dragPath !== f.path : !!externalDragActive;
            const isOver = f.path === dragOverPath && accepting;
            return (
              <div
                key={f.path}
                role="tab"
                tabIndex={f.path === activePath ? 0 : -1}
                data-path={f.path}
                aria-selected={f.path === activePath}
                className={
                  `tab${f.path === activePath ? " active" : ""}` +
                  (f.path === dragPath ? " dragging" : "") +
                  (isOver ? ` drag-over-${dragOverSide}` : "")
                }
                draggable={!!onReorder}
                onClick={() => onSelect(f.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(f.path);
                  } else if (event.key === "Delete") {
                    event.preventDefault();
                    onClose(f.path);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, path: f.path });
                }}
                onDrag={(e) => {
                  // screenX/Y are 0 on the final drag event of some platforms;
                  // ignore those and keep the last real position.
                  if (e.screenX || e.screenY) {
                    lastDragScreen.current = { x: e.screenX, y: e.screenY };
                    const now = performance.now();
                    if (onDragMove && now - lastHintTime.current > 70) {
                      lastHintTime.current = now;
                      onDragMove(e.screenX, e.screenY);
                    }
                  }
                }}
                onDragStart={(e) => {
                  setDragPath(f.path);
                  onDragStateChange?.({ groupId: groupId ?? "", path: f.path });
                  lastDragScreen.current = { x: e.screenX, y: e.screenY };
                  e.dataTransfer.effectAllowed = "move";
                  // Stamp the payload so OTHER groups' drop-zones know what (and
                  // from where) is being dragged (getData is unreadable in
                  // dragover, but the type is — that's enough to light up zones).
                  e.dataTransfer.setData(
                    TAB_DRAG_MIME,
                    JSON.stringify({ groupId: groupId ?? "", path: f.path })
                  );
                  // Use the tab chip itself as a clean drag image, anchored where
                  // the user grabbed it (avoids the browser's messy default ghost).
                  const r = e.currentTarget.getBoundingClientRect();
                  e.dataTransfer.setDragImage(
                    e.currentTarget,
                    e.clientX - r.left,
                    e.clientY - r.top
                  );
                }}
                onDragOver={(e) => {
                  // Accept a local reorder (drag started here) OR a tab from
                  // ANOTHER division (externalDragActive). Either way, show the
                  // insertion bar before/after this tab.
                  const accepting = dragPath
                    ? dragPath !== f.path
                    : !!externalDragActive;
                  if (!accepting) return;
                  e.preventDefault();
                  if (!dragPath) e.dataTransfer.dropEffect = "move";
                  // Left half → insert before this tab; right half → after it.
                  const r = e.currentTarget.getBoundingClientRect();
                  setDragOverSide(
                    e.clientX < r.left + r.width / 2 ? "left" : "right"
                  );
                  setDragOverPath(f.path);
                  setDropAtEnd(false);
                }}
                onDragLeave={() => {
                  setDragOverPath((p) => (p === f.path ? null : p));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const before = dragOverSide === "left";
                  if (dragPath && dragPath !== f.path) {
                    onReorder?.(dragPath, f.path, before);
                  } else if (!dragPath && externalDragActive) {
                    const payload = readTabDragPayload(e.dataTransfer);
                    if (payload) onTabStripDrop?.(payload, f.path, before);
                  }
                  setDragPath(null);
                  setDragOverPath(null);
                  setDropAtEnd(false);
                  stopAutoScroll();
                }}
                onDragEnd={(e) => {
                  // Always hand the drop's SCREEN coords to the app and let it
                  // decide by POSITION (hit-test), NOT by dropEffect: when you
                  // drop over another app (e.g. VS Code) it "accepts" the drag, so
                  // dropEffect is "copy"/"move" — checking it here would wrongly
                  // cancel the tear-off. The app ignores drops inside this same
                  // window (an internal drop-zone already handled those).
                  if (onDetach) {
                    const x = e.screenX || lastDragScreen.current.x;
                    const y = e.screenY || lastDragScreen.current.y;
                    onDetach(f.path, x, y);
                  }
                  setDragPath(null);
                  setDragOverPath(null);
                  setDropAtEnd(false);
                  stopAutoScroll();
                  onDragStateChange?.(null);
                }}
                title={f.path}
              >
                <FileIcon path={f.path} className="tab-icon" />
                <span
                  className={`tab-name${deco ? ` deco-${deco.kind}` : ""}`}
                >
                  {f.name}
                </span>
                <button
                  type="button"
                  className={`tab-close${f.dirty ? " dirty" : ""}`}
                  title={f.dirty ? "Não salvo" : "Fechar"}
                  aria-label={`Fechar ${f.name}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(f.path);
                  }}
                >
                  {f.dirty ? (
                    <span className="tab-dirty-dot" />
                  ) : (
                    <Codicon name="close" size={14} />
                  )}
                </button>
              </div>
            );
          })}
          {dropAtEnd && <div className="tab-drop-end" aria-hidden="true" />}
        </div>
      </div>
        {onSplit && (
          <div className="tab-bar-actions">
            <button
              type="button"
              className="tab-action-btn"
              title="Dividir editor para a direita"
              aria-label="Dividir editor"
              onClick={() => onSplit("right")}
            >
              {/* Inline SVG (matches the titlebar layout icons, currentColor) so
                  it always inherits the button's color — no icon-font surprises. */}
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect
                  x="1.5"
                  y="2.5"
                  width="13"
                  height="11"
                  rx="1.5"
                  stroke="currentColor"
                  fill="none"
                />
                <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="tab-context-item"
            onClick={() => { onClose(contextMenu.path); setContextMenu(null); }}
          >
            Fechar
          </button>
          <button
            className={`tab-context-item${!hasOthers ? " disabled" : ""}`}
            disabled={!hasOthers}
            onClick={() => { if (hasOthers) { onCloseOthers(contextMenu.path); setContextMenu(null); } }}
          >
            Fechar outras
          </button>
          <button
            className={`tab-context-item${!hasLeft ? " disabled" : ""}`}
            disabled={!hasLeft}
            onClick={() => { if (hasLeft) { onCloseLeft(contextMenu.path); setContextMenu(null); } }}
          >
            Fechar à esquerda
          </button>
          <button
            className={`tab-context-item${!hasRight ? " disabled" : ""}`}
            disabled={!hasRight}
            onClick={() => { if (hasRight) { onCloseRight(contextMenu.path); setContextMenu(null); } }}
          >
            Fechar à direita
          </button>
          <div className="tab-context-separator" />
          <button
            className="tab-context-item"
            onClick={() => { onCloseAll(); setContextMenu(null); }}
          >
            Fechar todas
          </button>
          {onMoveToNewWindow && (
            <>
              <div className="tab-context-separator" />
              <button
                className="tab-context-item"
                onClick={() => { onMoveToNewWindow(contextMenu.path); setContextMenu(null); }}
              >
                Mover para Nova Janela
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
