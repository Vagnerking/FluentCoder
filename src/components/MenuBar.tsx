import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { MenuDef, MenuItem } from "../types";

interface MenuBarProps {
  menus: MenuDef[];
}

/** True when an item can receive focus / be activated (not a separator, not disabled). */
function isFocusable(item: MenuItem): boolean {
  return !item.separator && item.enabled !== false;
}

/** Renders a menu's items as a dropdown list (shared by inline + overflow). */
function MenuItems({
  items,
  focusedItem,
  itemRefs,
  onRun,
  onHover,
}: {
  items: MenuItem[];
  focusedItem: number | null;
  itemRefs?: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  onRun: (item: MenuItem) => void;
  onHover: (index: number, item: MenuItem) => void;
}) {
  return (
    <>
      {items.map((item, itemIndex) =>
        item.separator ? (
          <div key={item.id} className="menubar-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            ref={(el) => {
              if (itemRefs) itemRefs.current[itemIndex] = el;
            }}
            role="menuitem"
            className={`menubar-item${item.enabled === false ? " disabled" : ""}${
              focusedItem === itemIndex ? " focused" : ""
            }`}
            disabled={item.enabled === false}
            aria-disabled={item.enabled === false}
            tabIndex={-1}
            onMouseEnter={() => onHover(itemIndex, item)}
            onClick={() => {
              if (item.enabled === false) return;
              onRun(item);
            }}
          >
            <span className="menubar-item-label">{item.label}</span>
            {item.accelerator && (
              <span className="menubar-item-accel">{item.accelerator}</span>
            )}
          </button>
        )
      )}
    </>
  );
}

/**
 * Data-driven, keyboard-accessible menu bar (File, Edit, …), VS Code-style.
 *
 * RESPONSIVE: it measures the available width and only renders the menus that
 * fit inline; the rest collapse into an overflow (☰) button whose dropdown lists
 * them and flies each one's items out to the side (cascade). When nothing fits,
 * the whole bar becomes a single hamburger menu.
 *
 * Inline menus keep the full keyboard model (Alt to focus, ←/→ between menus,
 * ↑/↓ in a dropdown, Enter/Esc). No business logic — items run via `run?.()`.
 */
export function MenuBar({ menus }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusedItem, setFocusedItem] = useState<number | null>(null);
  const [barFocused, setBarFocused] = useState(false);

  // Responsive overflow: how many leading menus fit inline; the rest go to the ☰.
  const [fitCount, setFitCount] = useState(menus.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowSub, setOverflowSub] = useState<number | null>(null);

  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  // The cascade submenu (overflow → row → items). It's a separate portal, so it
  // needs its own ref or the outside-mousedown handler closes it before the item
  // click can fire — which is exactly why the ⋯ actions "didn't work".
  const submenuRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Per-menu natural widths (measured off-screen) + the overflow button's width.
  const widthsRef = useRef<number[]>([]);

  // ---- Responsive measurement: recompute how many menus fit. ----
  const recompute = useCallback(() => {
    const bar = barRef.current;
    const measure = measureRef.current;
    if (!bar || !measure) return;
    const buttons = Array.from(
      measure.querySelectorAll<HTMLElement>(".menubar-menu")
    );
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
    setOverflowSub(null);
    setOpenIndex((cur) => (cur !== null && cur >= fitCount ? null : cur));
  }, [fitCount]);

  const overflowing = fitCount < menus.length;

  // ---- Outside-click / Escape close (inline dropdowns + overflow). ----
  useEffect(() => {
    if (openIndex === null && !overflowOpen) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      if (
        dropdownRef.current?.contains(t) ||
        barRef.current?.contains(t) ||
        overflowRef.current?.contains(t) ||
        submenuRef.current?.contains(t)
      )
        return;
      setOpenIndex(null);
      setBarFocused(false);
      setOverflowOpen(false);
      setOverflowSub(null);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openIndex, overflowOpen]);

  const focusButton = useCallback((i: number) => {
    buttonRefs.current[i]?.focus();
  }, []);

  const firstFocusable = useCallback(
    (menuIndex: number): number | null => {
      const items = menus[menuIndex]?.items ?? [];
      for (let i = 0; i < items.length; i++) if (isFocusable(items[i])) return i;
      return null;
    },
    [menus]
  );

  const openAndFocus = useCallback(
    (menuIndex: number) => {
      // Opening an inline menu always dismisses the overflow, so the two can
      // never be open (and highlighted) at the same time.
      setOverflowOpen(false);
      setOverflowSub(null);
      setOpenIndex(menuIndex);
      setActiveIndex(menuIndex);
      setFocusedItem(firstFocusable(menuIndex));
    },
    [firstFocusable]
  );

  const nextItem = useCallback(
    (menuIndex: number, from: number, dir: 1 | -1): number | null => {
      const items = menus[menuIndex]?.items ?? [];
      if (items.length === 0) return null;
      let idx = from;
      for (let step = 0; step < items.length; step++) {
        idx = (idx + dir + items.length) % items.length;
        if (isFocusable(items[idx])) return idx;
      }
      return isFocusable(items[from]) ? from : null;
    },
    [menus]
  );

  useEffect(() => {
    if (openIndex === null || focusedItem === null) return;
    const el = itemRefs.current[focusedItem];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, [openIndex, focusedItem]);

  useEffect(() => {
    itemRefs.current = [];
  }, [openIndex]);

  // Alt focuses/closes the bar (only meaningful for inline menus).
  useEffect(() => {
    function handleAlt(e: KeyboardEvent) {
      if (e.key !== "Alt" || e.ctrlKey || e.shiftKey || e.metaKey) return;
      e.preventDefault();
      if (barFocused || openIndex !== null || overflowOpen) {
        setOpenIndex(null);
        setBarFocused(false);
        setFocusedItem(null);
        setOverflowOpen(false);
        setOverflowSub(null);
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
  }, [barFocused, openIndex, overflowOpen, focusButton, fitCount]);

  useEffect(() => {
    if (barFocused && openIndex === null) focusButton(activeIndex);
  }, [barFocused, openIndex, activeIndex, focusButton]);

  // ←/→ wrap only across the INLINE menus (fitCount of them).
  const switchMenu = useCallback(
    (dir: 1 | -1) => {
      if (fitCount === 0) return;
      const target = (activeIndex + dir + fitCount) % fitCount;
      openAndFocus(target);
    },
    [activeIndex, fitCount, openAndFocus]
  );

  function onBarKeyDown(e: React.KeyboardEvent, i: number) {
    switch (e.key) {
      case "ArrowRight": {
        e.preventDefault();
        const next = (i + 1) % fitCount;
        setActiveIndex(next);
        if (openIndex !== null) openAndFocus(next);
        else focusButton(next);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const prev = (i - 1 + fitCount) % fitCount;
        setActiveIndex(prev);
        if (openIndex !== null) openAndFocus(prev);
        else focusButton(prev);
        break;
      }
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        openAndFocus(i);
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

  function onDropdownKeyDown(e: React.KeyboardEvent) {
    if (openIndex === null) return;
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = nextItem(openIndex, focusedItem ?? -1, 1);
        if (next !== null) setFocusedItem(next);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = nextItem(openIndex, focusedItem ?? menus[openIndex].items.length, -1);
        if (prev !== null) setFocusedItem(prev);
        break;
      }
      case "ArrowRight":
        e.preventDefault();
        switchMenu(1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        switchMenu(-1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        if (focusedItem === null) break;
        const item = menus[openIndex].items[focusedItem];
        if (item && isFocusable(item)) runItem(item);
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

  const closeAll = useCallback(() => {
    setOpenIndex(null);
    setBarFocused(false);
    setFocusedItem(null);
    setOverflowOpen(false);
    setOverflowSub(null);
  }, []);

  const runItem = useCallback(
    (item: MenuItem) => {
      if (item.enabled === false) return;
      item.run?.();
      closeAll();
    },
    [closeAll]
  );

  const openMenu = openIndex !== null ? menus[openIndex] : null;
  const openButton = openIndex !== null ? buttonRefs.current[openIndex] : null;
  const rect = openButton?.getBoundingClientRect();
  const overflowMenus = menus.slice(fitCount);
  const overflowRect = overflowOpen
    ? overflowBtnRef.current?.getBoundingClientRect()
    : undefined;
  const subMenu =
    overflowSub !== null ? menus[fitCount + overflowSub] : null;
  // The hovered overflow row, for the cascade submenu position.
  const subRowRect =
    overflowSub !== null
      ? overflowRef.current
          ?.querySelectorAll<HTMLElement>(".menubar-overflow-row")
          [overflowSub]?.getBoundingClientRect()
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
            aria-haspopup="true"
            aria-expanded={openIndex === i}
            tabIndex={activeIndex === i ? 0 : -1}
            onClick={() => {
              setActiveIndex(i);
              // Clicking an inline menu dismisses the overflow (no two-open bug).
              setOverflowOpen(false);
              setOverflowSub(null);
              setOpenIndex(openIndex === i ? null : i);
              setFocusedItem(openIndex === i ? null : firstFocusable(i));
            }}
            onMouseEnter={() => {
              // While anything is open (an inline menu OR the overflow), hovering
              // another top-level menu switches to it — like VS Code.
              if ((openIndex !== null && openIndex !== i) || overflowOpen)
                openAndFocus(i);
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
            title="Mais"
            aria-label="Mais menus"
            aria-haspopup="true"
            aria-expanded={overflowOpen}
            onClick={() => {
              setOpenIndex(null);
              setOverflowOpen((v) => !v);
              setOverflowSub(null);
            }}
          >
            {fitCount === 0 ? <HamburgerIcon /> : "⋯"}
          </button>
        )}

        {/* Draggable filler so the empty part of the bar still moves the window. */}
        <div className="menubar-filler" data-tauri-drag-region />
      </div>

      {/* Inline dropdown for a fitted menu. */}
      {openMenu && rect && createPortal(
        <div
          ref={dropdownRef}
          className="menubar-dropdown"
          role="menu"
          style={{ left: rect.left, top: rect.bottom }}
          onKeyDown={onDropdownKeyDown}
        >
          <MenuItems
            items={openMenu.items}
            focusedItem={focusedItem}
            itemRefs={itemRefs}
            onRun={runItem}
            onHover={(idx, item) => {
              if (isFocusable(item)) setFocusedItem(idx);
            }}
          />
        </div>,
        document.body
      )}

      {/* Overflow (☰) dropdown: lists the collapsed menus; each flies its items
          out to the side (cascade). */}
      {overflowOpen && overflowRect && createPortal(
        <div
          ref={overflowRef}
          className="menubar-dropdown menubar-overflow"
          role="menu"
          style={{ left: overflowRect.left, top: overflowRect.bottom }}
        >
          {overflowMenus.map((menu, i) => (
            <button
              key={menu.label}
              className={`menubar-item menubar-overflow-row${overflowSub === i ? " focused" : ""}`}
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={overflowSub === i}
              onMouseEnter={() => setOverflowSub(i)}
              onClick={() => setOverflowSub(overflowSub === i ? null : i)}
            >
              <span className="menubar-item-label">{menu.label}</span>
              <span className="menubar-item-accel">›</span>
            </button>
          ))}
        </div>,
        document.body
      )}

      {/* Cascade submenu for the hovered overflow row. */}
      {subMenu && subRowRect && createPortal(
        <div
          ref={submenuRef}
          className="menubar-dropdown menubar-submenu"
          role="menu"
          style={{ left: subRowRect.right - 2, top: subRowRect.top }}
        >
          <MenuItems
            items={subMenu.items}
            focusedItem={null}
            onRun={runItem}
            onHover={() => {}}
          />
        </div>,
        document.body
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
