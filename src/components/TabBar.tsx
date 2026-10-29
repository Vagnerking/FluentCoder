import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { OpenFile, FileDecoration } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import { EditorTab } from "./editor/EditorTab";
import { TabContextMenu } from "./editor/TabContextMenu";
import { tabDescriptions, tabRovingIndex } from "./editor/tabLogic";
import { useTabOverflow } from "./editor/useTabOverflow";
import { useEditorTabDrag, type TabDragPayload } from "./editor/useEditorTabDrag";

export { TAB_DRAG_MIME, readTabDragPayload, type TabDragPayload } from "./editor/useEditorTabDrag";

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
   *  {groupId, path} on start and null on end. */
  onDragStateChange?: (drag: TabDragPayload | null) => void;
  /** Throttled live screen position during a tab drag — used to hint which
   *  window the tab would drop on (cross-window drag feedback). */
  onDragMove?: (screenX: number, screenY: number) => void;
  /** Editor-title actions rendered at the right of the strip (EditorActions). */
  actions?: ReactNode;
  /** Resolves the git/diagnostic decoration for a path; default = none. */
  decorationFor?: (path: string) => FileDecoration | undefined;
  /** Fixar/desafixar uma aba. */
  onPin?: (path: string, pinned: boolean) => void;
  /** Tira a aba do modo preview (duplo clique / "Manter aberta"). */
  onKeepOpen?: (path: string) => void;
}

/**
 * Faixa de abas do grupo: composição de EditorTab (apresentação),
 * useTabOverflow (rolagem/fades/setas), useEditorTabDrag (reordenar, mover
 * entre grupos/janelas, destacar) e TabContextMenu. Teclado (tablist com
 * ativação manual): ←/→/Home/End movem o foco, Enter/Espaço ativam, Delete
 * fecha.
 */
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
  actions,
  decorationFor = () => undefined,
  onPin,
  onKeepOpen,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // Aba com o foco itinerante (null = segue a ativa).
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const overflowState = useTabOverflow(barRef, activePath, files.length);
  const { overflow, syncOverflow, scrollTabsBy, onWheel, revealTab } = overflowState;
  const drag = useEditorTabDrag({
    groupId,
    onReorder,
    externalDragActive,
    onTabStripDrop,
    onDetach,
    onDragStateChange,
    onDragMove,
    updateAutoScroll: overflowState.updateAutoScroll,
    pauseAutoScroll: overflowState.pauseAutoScroll,
    stopAutoScroll: overflowState.stopAutoScroll,
  });
  const descriptions = useMemo(() => tabDescriptions(files), [files]);
  // A ativa mudou por fora (Quick Open, clique): o foco itinerante a acompanha.
  useEffect(() => setFocusPath(null), [activePath]);

  if (files.length === 0) return null;

  const stopPath =
    focusPath && files.some((f) => f.path === focusPath)
      ? focusPath
      : activePath && files.some((f) => f.path === activePath)
        ? activePath
        : files[0].path;

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, path: string, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(path);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      void onClose(path);
      return;
    }
    const next = tabRovingIndex(index, event.key, files.length);
    if (next === null) return;
    event.preventDefault();
    const target = files[next].path;
    setFocusPath(target);
    tabRefs.current.get(target)?.focus();
    revealTab(target);
  };

  return (
    <>
      <div className="tab-strip">
        <div className="tab-bar-wrap">
          <div className={`tab-fade left${overflow.left ? " show" : ""}`} aria-hidden="true" />
          <div className={`tab-fade right${overflow.right ? " show" : ""}`} aria-hidden="true" />
          {/* Scroll arrows over the fades: a pointer affordance for the hidden
              tabs (the wheel also scrolls). Out of the tab order — keyboard
              users reach every tab through the tablist itself. */}
          {overflow.left && (
            <button
              type="button"
              className="tab-scroll left"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => scrollTabsBy(-1)}
            >
              <Codicon name="chevronLeft" size={14} />
            </button>
          )}
          {overflow.right && (
            <button
              type="button"
              className="tab-scroll right"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => scrollTabsBy(1)}
            >
              <Codicon name="chevronRight" size={14} />
            </button>
          )}
          <div
            className="tab-bar"
            ref={barRef}
            role="tablist"
            aria-label="Abas abertas"
            aria-orientation="horizontal"
            data-group-id={groupId}
            onScroll={syncOverflow}
            onWheel={onWheel}
            {...drag.stripHandlers}
          >
            {files.map((f, index) => (
              <EditorTab
                key={f.path}
                file={f}
                active={f.path === activePath}
                tabStop={f.path === stopPath}
                description={descriptions.get(f.path)}
                decoration={decorationFor(f.path)}
                dragClass={drag.dragClassFor(f.path)}
                drag={drag.tabHandlers(f.path, f.name)}
                tabRef={(el) => {
                  if (el) tabRefs.current.set(f.path, el);
                  else tabRefs.current.delete(f.path);
                }}
                onSelect={() => {
                  setFocusPath(f.path);
                  onSelect(f.path);
                }}
                onClose={() => void onClose(f.path)}
                onKeepOpen={onKeepOpen && f.preview ? () => onKeepOpen(f.path) : undefined}
                onUnpin={onPin ? () => onPin(f.path, false) : undefined}
                onKeyDown={(e) => onTabKeyDown(e, f.path, index)}
                onFocus={() => setFocusPath(f.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, path: f.path });
                }}
              />
            ))}
            {drag.dropAtEnd && <div className="tab-drop-end" aria-hidden="true" />}
          </div>
        </div>
        {actions && <div className="tab-bar-actions">{actions}</div>}
      </div>

      {contextMenu && (
        <TabContextMenu
          {...contextMenu}
          files={files}
          onDismiss={() => setContextMenu(null)}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onCloseLeft={onCloseLeft}
          onCloseRight={onCloseRight}
          onCloseAll={onCloseAll}
          onMoveToNewWindow={onMoveToNewWindow}
          onPin={onPin}
          onKeepOpen={onKeepOpen}
        />
      )}
    </>
  );
}
