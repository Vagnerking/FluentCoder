import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { MenuDef, MenuItem } from "../types";

interface MenuBarProps {
  menus: MenuDef[];
}

/** True when an item can receive focus / be activated (not a separator, not disabled). */
function isFocusable(item: MenuItem): boolean {
  return !item.separator && item.enabled !== false;
}

/**
 * Data-driven menu bar (File, Edit, …) with full keyboard accessibility and
 * VSCode-style behavior. Each menu opens a dropdown rendered via portal below
 * its button. Closes on outside mousedown or Escape.
 *
 * Keyboard:
 *  - Alt focuses/opens the bar (Alt again or Esc on the bar closes it).
 *  - In the bar: ←/→ move the active menu (with wrap); ↓/Enter/Space open the
 *    dropdown and focus its first enabled item.
 *  - In a dropdown: ↑/↓ move between items (wrap, skipping separators/disabled);
 *    Enter/Space activate; Esc closes and returns focus to the menu button;
 *    ←/→ switch to the neighbouring menu (close + open + focus first item).
 *  - Hovering another menu button while a dropdown is open switches the dropdown.
 *
 * No business logic — items run via their own `run?.()` callbacks.
 */
export function MenuBar({ menus }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  /** Which menu button is "active" for roving tabindex / Alt focus. */
  const [activeIndex, setActiveIndex] = useState(0);
  /** Index of the focused item inside the open dropdown, or null. */
  const [focusedItem, setFocusedItem] = useState<number | null>(null);
  /** Whether the bar currently holds keyboard focus (driven by Alt). */
  const [barFocused, setBarFocused] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Outside-click and Escape closing (unchanged from ISSUE-47, plus focus reset).
  useEffect(() => {
    if (openIndex === null) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      const inDropdown = dropdownRef.current?.contains(target);
      const inBar = barRef.current?.contains(target);
      if (!inDropdown && !inBar) {
        setOpenIndex(null);
        setBarFocused(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
    };
  }, [openIndex]);

  /** Focus a menu button by index. */
  const focusButton = useCallback((i: number) => {
    buttonRefs.current[i]?.focus();
  }, []);

  /** Index of the first focusable item in a menu, or null if none. */
  const firstFocusable = useCallback((menuIndex: number): number | null => {
    const items = menus[menuIndex]?.items ?? [];
    for (let i = 0; i < items.length; i++) {
      if (isFocusable(items[i])) return i;
    }
    return null;
  }, [menus]);

  /** Open a menu and focus its first enabled item. */
  const openAndFocus = useCallback((menuIndex: number) => {
    setOpenIndex(menuIndex);
    setActiveIndex(menuIndex);
    setFocusedItem(firstFocusable(menuIndex));
  }, [firstFocusable]);

  /** Next focusable item index from `from`, in `dir` (+1/-1), with wrap. Skips separators/disabled. */
  const nextItem = useCallback((menuIndex: number, from: number, dir: 1 | -1): number | null => {
    const items = menus[menuIndex]?.items ?? [];
    if (items.length === 0) return null;
    let idx = from;
    for (let step = 0; step < items.length; step++) {
      idx = (idx + dir + items.length) % items.length;
      if (isFocusable(items[idx])) return idx;
    }
    return isFocusable(items[from]) ? from : null;
  }, [menus]);

  // Move real focus onto the focused dropdown item & keep it visible.
  useEffect(() => {
    if (openIndex === null || focusedItem === null) return;
    const el = itemRefs.current[focusedItem];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, [openIndex, focusedItem]);

  // Reset per-dropdown item refs whenever the open menu changes.
  useEffect(() => {
    itemRefs.current = [];
  }, [openIndex]);

  // Global Alt handler: toggle bar focus / open state (VSCode style).
  useEffect(() => {
    function handleAlt(e: KeyboardEvent) {
      if (e.key !== "Alt") return;
      // Only plain Alt — ignore Alt combined with other modifiers.
      if (e.ctrlKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      if (barFocused || openIndex !== null) {
        // Toggle off: close and blur the bar.
        setOpenIndex(null);
        setBarFocused(false);
        setFocusedItem(null);
      } else {
        // Toggle on: focus the first menu button.
        setBarFocused(true);
        setActiveIndex(0);
        focusButton(0);
      }
    }
    document.addEventListener("keydown", handleAlt);
    return () => document.removeEventListener("keydown", handleAlt);
  }, [barFocused, openIndex, focusButton]);

  // Keep the active button focused when the bar is focused but nothing is open.
  useEffect(() => {
    if (barFocused && openIndex === null) {
      focusButton(activeIndex);
    }
  }, [barFocused, openIndex, activeIndex, focusButton]);

  /** Switch the open dropdown to a neighbouring menu (wrap), focusing its first item. */
  const switchMenu = useCallback((dir: 1 | -1) => {
    const target = (activeIndex + dir + menus.length) % menus.length;
    openAndFocus(target);
  }, [activeIndex, menus.length, openAndFocus]);

  // Keyboard handling on the menu bar buttons (no dropdown open, or moving between menus).
  function onBarKeyDown(e: React.KeyboardEvent, i: number) {
    switch (e.key) {
      case "ArrowRight": {
        e.preventDefault();
        const next = (i + 1) % menus.length;
        setActiveIndex(next);
        if (openIndex !== null) openAndFocus(next);
        else focusButton(next);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const prev = (i - 1 + menus.length) % menus.length;
        setActiveIndex(prev);
        if (openIndex !== null) openAndFocus(prev);
        else focusButton(prev);
        break;
      }
      case "ArrowDown":
      case "Enter":
      case " ": {
        e.preventDefault();
        openAndFocus(i);
        break;
      }
      case "Escape": {
        if (openIndex === null && barFocused) {
          e.preventDefault();
          setBarFocused(false);
          buttonRefs.current[i]?.blur();
        }
        break;
      }
      default:
        break;
    }
  }

  // Keyboard handling inside the open dropdown.
  function onDropdownKeyDown(e: React.KeyboardEvent) {
    if (openIndex === null) return;
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const from = focusedItem ?? -1;
        const next = nextItem(openIndex, from, 1);
        if (next !== null) setFocusedItem(next);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const from = focusedItem ?? menus[openIndex].items.length;
        const prev = nextItem(openIndex, from, -1);
        if (prev !== null) setFocusedItem(prev);
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        switchMenu(1);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        switchMenu(-1);
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        if (focusedItem === null) break;
        const item = menus[openIndex].items[focusedItem];
        if (item && isFocusable(item)) {
          item.run?.();
          setOpenIndex(null);
          setBarFocused(false);
          setFocusedItem(null);
        }
        break;
      }
      case "Escape": {
        e.preventDefault();
        const btnIndex = openIndex;
        setOpenIndex(null);
        setFocusedItem(null);
        setBarFocused(true);
        setActiveIndex(btnIndex);
        focusButton(btnIndex);
        break;
      }
      default:
        break;
    }
  }

  const openMenu = openIndex !== null ? menus[openIndex] : null;
  const openButton = openIndex !== null ? buttonRefs.current[openIndex] : null;
  const rect = openButton?.getBoundingClientRect();

  return (
    <>
      <div ref={barRef} className="menubar" role="menubar">
        {menus.map((menu, i) => (
          <button
            key={menu.label}
            ref={(el) => { buttonRefs.current[i] = el; }}
            className={`menubar-menu${openIndex === i ? " active" : ""}`}
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={openIndex === i}
            tabIndex={activeIndex === i ? 0 : -1}
            onClick={() => {
              setActiveIndex(i);
              setOpenIndex(openIndex === i ? null : i);
              setFocusedItem(openIndex === i ? null : firstFocusable(i));
            }}
            onMouseEnter={() => {
              if (openIndex !== null && openIndex !== i) {
                openAndFocus(i);
              }
            }}
            onKeyDown={(e) => onBarKeyDown(e, i)}
          >
            {menu.label}
          </button>
        ))}
      </div>

      {openMenu && rect && createPortal(
        <div
          ref={dropdownRef}
          className="menubar-dropdown"
          role="menu"
          style={{ left: rect.left, top: rect.bottom }}
          onKeyDown={onDropdownKeyDown}
        >
          {openMenu.items.map((item, itemIndex) =>
            item.separator ? (
              <div key={item.id} className="menubar-separator" role="separator" />
            ) : (
              <button
                key={item.id}
                ref={(el) => { itemRefs.current[itemIndex] = el; }}
                role="menuitem"
                className={`menubar-item${item.enabled === false ? " disabled" : ""}${focusedItem === itemIndex ? " focused" : ""}`}
                disabled={item.enabled === false}
                aria-disabled={item.enabled === false}
                tabIndex={-1}
                onMouseEnter={() => {
                  if (isFocusable(item)) setFocusedItem(itemIndex);
                }}
                onClick={() => {
                  if (item.enabled === false) return;
                  item.run?.();
                  setOpenIndex(null);
                  setBarFocused(false);
                  setFocusedItem(null);
                }}
              >
                <span className="menubar-item-label">{item.label}</span>
                {item.accelerator && (
                  <span className="menubar-item-accel">{item.accelerator}</span>
                )}
              </button>
            )
          )}
        </div>,
        document.body
      )}
    </>
  );
}
