/**
 * "Open With…" selector (ISSUE-70).
 *
 * A small floating menu — same acrylic/portal pattern as the tab context menu
 * (`.tab-context-menu`) — that lists the modes applicable to a file and opens
 * the chosen one. It's data-driven: it renders whatever {@link applicableModes}
 * returns for the path, marking the default mode, so new modes need no UI work.
 *
 * Self-contained on purpose: the explorer context menu (épico A) only needs to
 * mount this with the click position and the target path; everything else lives
 * here. Closing mirrors the tab menu: outside mousedown or Escape.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { OpenMode } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import { applicableModes, defaultModeFor } from "./openWith";

interface OpenWithPickerProps {
  /** Absolute path of the file to open. */
  path: string;
  /** Viewport coordinates to anchor the menu at (the right-click point). */
  x: number;
  y: number;
  /** Open `path` in the chosen mode. */
  onPick: (mode: OpenMode) => void;
  /** Dismiss without choosing (outside click / Escape). */
  onClose: () => void;
}

export function OpenWithPicker({
  path,
  x,
  y,
  onPick,
  onClose,
}: OpenWithPickerProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const modes = applicableModes(path);
  const defaultMode = defaultModeFor(path);

  return createPortal(
    <div
      ref={menuRef}
      className="tab-context-menu open-with-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <div className="open-with-title">Abrir com…</div>
      {modes.map((m) => (
        <button
          key={m.mode}
          className="tab-context-item open-with-item"
          role="menuitem"
          onClick={() => {
            onPick(m.mode);
            onClose();
          }}
        >
          <Codicon name={m.icon} className="open-with-icon" />
          <span className="open-with-label">{m.label}</span>
          {m.mode === defaultMode && (
            <span className="open-with-default">padrão</span>
          )}
        </button>
      ))}
    </div>,
    document.body
  );
}
