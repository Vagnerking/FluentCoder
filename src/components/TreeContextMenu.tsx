import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuItem } from "../types";
import { Codicon } from "../icons/codicons/Codicon";

interface TreeContextMenuProps {
  /** Viewport coordinates where the menu should anchor (the click point). */
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Called when the menu should close (item run, Esc, outside click). */
  onClose: () => void;
}

/** Index of the first item that can receive keyboard focus (skips separators/disabled). */
function firstFocusable(items: ContextMenuItem[]): number {
  return items.findIndex((it) => !it.separator && it.enabled !== false);
}

/**
 * Purely presentational floating menu for the file explorer, mirroring the
 * portal pattern from `TabBar`: rendered in `document.body`, positioned at the
 * click point, and closed on outside mousedown / Escape. It knows nothing about
 * concrete actions — it renders `items` and calls each `run` on activation.
 * Supports separators, disabled rows, accelerators, and one level of submenu.
 */
export function TreeContextMenu({ x, y, items, onClose }: TreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [activeIndex, setActiveIndex] = useState<number>(() => firstFocusable(items));
  // Index of the row whose submenu is open, or null.
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  // Close on outside mousedown / Escape, exactly like TabBar's menu.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [onClose]);

  // Flip away from the viewport edges so the menu is never clipped.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + rect.width > window.innerWidth) nx = Math.max(4, window.innerWidth - rect.width - 4);
    if (y + rect.height > window.innerHeight) ny = Math.max(4, window.innerHeight - rect.height - 4);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Focus the menu so it captures arrow/Enter immediately on open.
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  function move(delta: number) {
    setActiveIndex((current) => {
      const n = items.length;
      let next = current;
      for (let step = 0; step < n; step++) {
        next = (next + delta + n) % n;
        const it = items[next];
        if (it && !it.separator && it.enabled !== false) return next;
      }
      return current;
    });
  }

  function activate(item: ContextMenuItem) {
    if (item.separator || item.enabled === false) return;
    if (item.submenu) return; // submenu opens on hover/ArrowRight, not on activate
    item.run?.();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "ArrowRight") {
      const it = items[activeIndex];
      if (it?.submenu) {
        e.preventDefault();
        setOpenSubmenu(activeIndex);
      }
    } else if (e.key === "ArrowLeft") {
      if (openSubmenu != null) {
        e.preventDefault();
        setOpenSubmenu(null);
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = items[activeIndex];
      if (it) {
        if (it.submenu) setOpenSubmenu(activeIndex);
        else activate(it);
      }
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="tree-context-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      tabIndex={-1}
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={item.id} className="tree-context-separator" role="separator" />;
        }
        const disabled = item.enabled === false;
        const hasSubmenu = !!item.submenu?.length;
        return (
          <div
            key={item.id}
            className={`tree-context-item${disabled ? " disabled" : ""}${
              index === activeIndex ? " active" : ""
            }`}
            role="menuitem"
            aria-disabled={disabled || undefined}
            aria-haspopup={hasSubmenu || undefined}
            aria-expanded={hasSubmenu ? openSubmenu === index : undefined}
            onMouseEnter={() => {
              if (!disabled) setActiveIndex(index);
              setOpenSubmenu(hasSubmenu ? index : null);
            }}
            onClick={() => activate(item)}
          >
            <span className="tree-context-icon">
              {item.icon ? <Codicon name={item.icon} size={16} /> : null}
            </span>
            <span className="tree-context-label">{item.label}</span>
            {item.accelerator && (
              <span className="tree-context-accel">{item.accelerator}</span>
            )}
            {hasSubmenu && (
              <span className="tree-context-chevron">
                <Codicon name="chevronRight" size={12} />
              </span>
            )}
            {hasSubmenu && openSubmenu === index && (
              <div className="tree-context-submenu" role="menu">
                {item.submenu!.map((sub) =>
                  sub.separator ? (
                    <div key={sub.id} className="tree-context-separator" role="separator" />
                  ) : (
                    <div
                      key={sub.id}
                      className={`tree-context-item${sub.enabled === false ? " disabled" : ""}`}
                      role="menuitem"
                      aria-disabled={sub.enabled === false || undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (sub.enabled === false) return;
                        sub.run?.();
                        onClose();
                      }}
                    >
                      <span className="tree-context-icon">
                        {sub.icon ? <Codicon name={sub.icon} size={16} /> : null}
                      </span>
                      <span className="tree-context-label">{sub.label}</span>
                      {sub.accelerator && (
                        <span className="tree-context-accel">{sub.accelerator}</span>
                      )}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body
  );
}
