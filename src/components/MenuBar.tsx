import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import type { MenuDef, MenuItem } from "../types";
import { Menu, type MenuCloseReason, type MenuItemSpec } from "./ui/Menu";
import { isMac } from "../platform/os";

interface MenuBarProps {
  menus: MenuDef[];
}

/** Maps a menu-bar entry onto the shared menu primitive's item model. */
function toMenuItems(items: readonly MenuItem[]): MenuItemSpec[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    shortcut: item.accelerator,
    separator: item.separator,
    disabled: item.enabled === false,
    onSelect: item.run,
  }));
}

/**
 * Data-driven, keyboard-accessible menu bar (File, Edit, …), VS Code-style.
 *
 * RESPONSIVE: it measures the available width and only renders the menus that
 * fit inline; the rest collapse into an overflow (⋯) button whose flyout lists
 * them, each opening its items as a submenu. When nothing fits, the whole bar
 * becomes a single hamburger menu.
 *
 * Keyboard: Alt focuses the bar, ←/→ move between menus (also from inside an
 * open dropdown), ↓/Enter/Space open one; inside, the shared {@link Menu}
 * handles ↑/↓, Home/End, type-ahead, Enter and Esc (which returns focus to the
 * menu's button). No business logic — items run via `run?.()`.
 */
export function MenuBar({ menus }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [barFocused, setBarFocused] = useState(false);

  // Responsive overflow: how many leading menus fit inline; the rest go to the ⋯.
  const [fitCount, setFitCount] = useState(menus.length);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Per-menu natural widths (measured off-screen).
  const widthsRef = useRef<number[]>([]);

  // ---- Responsive measurement: recompute how many menus fit. ----
  const recompute = useCallback(() => {
    const bar = barRef.current;
    const measure = measureRef.current;
    if (!bar || !measure) return;
    const buttons = Array.from(measure.querySelectorAll<HTMLElement>(".menubar-menu"));
    widthsRef.current = buttons.map((b) => b.offsetWidth);
    const overflowW = 36; // the ⋯ / ☰ button
    const gap = 10; // breathing room so menus never crowd the title zone
    const total = widthsRef.current.reduce((a, b) => a + b, 0);
    const available = bar.clientWidth - gap;
    if (total <= available) {
      setFitCount(menus.length);
      return;
    }
    // Below a minimum, don't bother with a few inline menus + "⋯" — collapse the
    // WHOLE bar into the hamburger (☰), like VS Code when the window is small.
    const MIN_INLINE = 200;
    if (available < MIN_INLINE) {
      setFitCount(0);
      return;
    }
    // Otherwise fit as many leading menus as we can, reserving the overflow slot.
    let used = overflowW;
    let n = 0;
    for (const w of widthsRef.current) {
      if (used + w > available) break;
      used += w;
      n++;
    }
    setFitCount(n);
  }, [menus.length]);

  useLayoutEffect(() => {
    recompute();
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [recompute, menus]);

  // When the fit count changes, close the overflow and any inline dropdown that
  // just collapsed into it (its button no longer exists).
  useEffect(() => {
    setOverflowOpen(false);
    setOpenIndex((cur) => (cur !== null && cur >= fitCount ? null : cur));
  }, [fitCount]);

  const overflowing = fitCount < menus.length;

  const focusButton = useCallback((i: number) => {
    buttonRefs.current[i]?.focus();
  }, []);

  const openMenuAt = useCallback((menuIndex: number) => {
    // Opening an inline menu always dismisses the overflow, so the two can
    // never be open (and highlighted) at the same time.
    setOverflowOpen(false);
    setOpenIndex(menuIndex);
    setActiveIndex(menuIndex);
  }, []);

  const closeAll = useCallback(() => {
    setOpenIndex(null);
    setBarFocused(false);
    setOverflowOpen(false);
  }, []);

  // Alt focuses/closes the bar (only meaningful for inline menus). Not on
  // macOS: there Option is a typing modifier (accents, symbols) and menus
  // aren't reached through Alt.
  useEffect(() => {
    if (isMac()) return;
    function handleAlt(e: KeyboardEvent) {
      if (e.key !== "Alt" || e.ctrlKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      if (barFocused || openIndex !== null || overflowOpen) {
        closeAll();
      } else if (fitCount > 0) {
        setBarFocused(true);
        setActiveIndex(0);
        focusButton(0);
      } else {
        // Fully collapsed → open the hamburger.
        setOverflowOpen(true);
        overflowBtnRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleAlt);
    return () => document.removeEventListener("keydown", handleAlt);
  }, [barFocused, openIndex, overflowOpen, focusButton, fitCount, closeAll]);

  useEffect(() => {
    if (barFocused && openIndex === null) focusButton(activeIndex);
  }, [barFocused, openIndex, activeIndex, focusButton]);

  // ←/→ wrap only across the INLINE menus (fitCount of them).
  const switchMenu = useCallback(
    (dir: 1 | -1) => {
      if (fitCount === 0) return;
      const target = (activeIndex + dir + fitCount) % fitCount;
      openMenuAt(target);
    },
    [activeIndex, fitCount, openMenuAt],
  );

  function onBarKeyDown(e: React.KeyboardEvent, i: number) {
    switch (e.key) {
      case "ArrowRight": {
        e.preventDefault();
        const next = (i + 1) % fitCount;
        setActiveIndex(next);
        if (openIndex !== null) openMenuAt(next);
        else focusButton(next);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const prev = (i - 1 + fitCount) % fitCount;
        setActiveIndex(prev);
        if (openIndex !== null) openMenuAt(prev);
        else focusButton(prev);
        break;
      }
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        openMenuAt(i);
        break;
      case "Escape":
        if (openIndex === null && barFocused) {
          e.preventDefault();
          setBarFocused(false);
          buttonRefs.current[i]?.blur();
        }
        break;
      default:
        break;
    }
  }

  // Closing an inline dropdown: Esc returns focus to its button (bar stays
  // focused, like VS Code); anything else closes the whole bar.
  const onDropdownClose = useCallback(
    (reason: MenuCloseReason) => {
      if (reason === "escape" && openIndex !== null) {
        const btn = openIndex;
        setOpenIndex(null);
        setBarFocused(true);
        setActiveIndex(btn);
        focusButton(btn);
        return;
      }
      closeAll();
    },
    [openIndex, closeAll, focusButton],
  );

  const insideBar = useCallback(
    (t: Node) => !!barRef.current?.contains(t),
    [],
  );

  const openMenu = openIndex !== null ? menus[openIndex] : null;
  const openButton = openIndex !== null ? buttonRefs.current[openIndex] : null;
  const rect = openButton?.getBoundingClientRect();
  const overflowMenus = menus.slice(fitCount);
  const overflowRect = overflowOpen
    ? overflowBtnRef.current?.getBoundingClientRect()
    : undefined;

  return (
    <>
      {/* Hidden measuring copy — always all menus, off-screen, to size them. */}
      <div ref={measureRef} className="menubar-measure" aria-hidden="true">
        {menus.map((m) => (
          <span key={m.label} className="menubar-menu">
            {m.label}
          </span>
        ))}
      </div>

      <div ref={barRef} className="menubar" role="menubar">
        {menus.slice(0, fitCount).map((menu, i) => (
          <button
            key={menu.label}
            ref={(el) => {
              buttonRefs.current[i] = el;
            }}
            className={`menubar-menu${openIndex === i ? " active" : ""}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openIndex === i}
            tabIndex={activeIndex === i ? 0 : -1}
            onClick={() => {
              setActiveIndex(i);
              setOverflowOpen(false);
              setOpenIndex(openIndex === i ? null : i);
            }}
            onMouseEnter={() => {
              // While anything is open (an inline menu OR the overflow), hovering
              // another top-level menu switches to it — like VS Code.
              if ((openIndex !== null && openIndex !== i) || overflowOpen) openMenuAt(i);
            }}
            onKeyDown={(e) => onBarKeyDown(e, i)}
          >
            {menu.label}
          </button>
        ))}

        {overflowing && (
          <button
            ref={overflowBtnRef}
            className={`menubar-menu menubar-overflow-btn${overflowOpen ? " active" : ""}`}
            aria-label="Mais menus"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            onClick={() => {
              setOpenIndex(null);
              setOverflowOpen((v) => !v);
            }}
          >
            {fitCount === 0 ? <HamburgerIcon /> : "⋯"}
          </button>
        )}

        {/* Draggable filler so the empty part of the bar still moves the window. */}
        <div className="menubar-filler" data-tauri-drag-region />
      </div>

      {/* Inline dropdown for a fitted menu (remounts per menu → focuses its
          first item, like opening it fresh). */}
      {openMenu && rect && (
        <Menu
          key={openIndex}
          ariaLabel={openMenu.label}
          className="menubar-dropdown"
          anchor={{ rect, placement: "bottom-start" }}
          items={toMenuItems(openMenu.items)}
          onClose={onDropdownClose}
          onArrowOut={switchMenu}
          isInside={insideBar}
        />
      )}

      {/* Overflow (⋯ / ☰): the collapsed menus, each as a submenu. */}
      {overflowOpen && overflowRect && (
        <Menu
          ariaLabel="Mais menus"
          className="menubar-dropdown menubar-overflow"
          anchor={{ rect: overflowRect, placement: "bottom-start" }}
          items={overflowMenus.map((menu) => ({
            id: `menu-${menu.label}`,
            label: menu.label,
            submenu: toMenuItems(menu.items),
          }))}
          onClose={(reason) => {
            closeAll();
            if (reason === "escape") overflowBtnRef.current?.focus();
          }}
          isInside={insideBar}
        />
      )}
    </>
  );
}

/** Hamburger glyph for the fully-collapsed menu. */
function HamburgerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4h12M2 8h12M2 12h12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
