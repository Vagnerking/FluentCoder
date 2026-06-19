import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { OpenFile, FileDecoration } from "../types";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";

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
  decorationFor = () => undefined,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
      <div className="tab-bar">
        {files.map((f) => {
          const deco = decorationFor(f.path);
          return (
            <div
              key={f.path}
              className={`tab${f.path === activePath ? " active" : ""}`}
              onClick={() => onSelect(f.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, path: f.path });
              }}
              title={f.path}
            >
              <FileIcon path={f.path} className="tab-icon" />
              <span className={`tab-name${deco ? ` deco-${deco.kind}` : ""}`}>
                {f.name}
              </span>
              <span
                className={`tab-close${f.dirty ? " dirty" : ""}`}
                title={f.dirty ? "Não salvo" : "Fechar"}
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
              </span>
            </div>
          );
        })}
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
        </div>,
        document.body
      )}
    </>
  );
}
