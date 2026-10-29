/**
 * Pure rules for the <Menu> primitive: keyboard navigation (WAI-ARIA menu
 * pattern), type-ahead and flyout placement. No React/DOM, so it is unit
 * tested directly (`menuLogic.test.ts`).
 */

/** The shape navigation needs from a menu entry. */
export interface MenuNavItem {
  label?: string;
  separator?: boolean;
  disabled?: boolean;
  submenu?: readonly MenuNavItem[];
}

/** An entry that can take focus and be activated (not a separator/disabled). */
export function isActionable(item: MenuNavItem | undefined): boolean {
  return !!item && !item.separator && !item.disabled;
}

/** Next actionable index from `from` in `dir`, wrapping; -1 when none. */
export function nextActionable(
  items: readonly MenuNavItem[],
  from: number,
  dir: 1 | -1,
): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (isActionable(items[i])) return i;
  }
  return -1;
}

export function firstActionable(items: readonly MenuNavItem[]): number {
  return items.findIndex(isActionable);
}

export function lastActionable(items: readonly MenuNavItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (isActionable(items[i])) return i;
  return -1;
}

export type MenuKeyAction =
  | { type: "none" }
  | { type: "move"; index: number }
  | { type: "activate"; index: number }
  | { type: "openSubmenu"; index: number }
  | { type: "closeSubmenu" }
  | { type: "close"; reason: "escape" | "tab" }
  /** ←/→ at the root of a menu-bar dropdown: switch to the adjacent menu. */
  | { type: "arrowOut"; dir: 1 | -1 };

export interface MenuKeyState {
  activeIndex: number;
  /** True inside a nested submenu surface (← closes it instead of escaping). */
  isSubmenu: boolean;
}

/**
 * Maps a key to what the menu should do. ↑/↓ move with wrap (skipping
 * separators/disabled), Home/End jump, Enter/Space activate (or open a
 * submenu), → opens a submenu (or, at the root, asks to move to the next
 * menu-bar menu), ← closes a submenu (or moves to the previous menu), Esc
 * closes the current level, Tab closes the whole menu.
 */
export function menuKeyAction(
  key: string,
  items: readonly MenuNavItem[],
  state: MenuKeyState,
): MenuKeyAction {
  const { activeIndex, isSubmenu } = state;
  const current = items[activeIndex];
  const hasSub = !!current?.submenu?.length && isActionable(current);
  switch (key) {
    case "ArrowDown": {
      const i = nextActionable(items, activeIndex < 0 ? -1 : activeIndex, 1);
      return i < 0 ? { type: "none" } : { type: "move", index: i };
    }
    case "ArrowUp": {
      const i = nextActionable(items, activeIndex < 0 ? items.length : activeIndex, -1);
      return i < 0 ? { type: "none" } : { type: "move", index: i };
    }
    case "Home": {
      const i = firstActionable(items);
      return i < 0 ? { type: "none" } : { type: "move", index: i };
    }
    case "End": {
      const i = lastActionable(items);
      return i < 0 ? { type: "none" } : { type: "move", index: i };
    }
    case "Enter":
    case " ":
      if (!isActionable(current)) return { type: "none" };
      return hasSub
        ? { type: "openSubmenu", index: activeIndex }
        : { type: "activate", index: activeIndex };
    case "ArrowRight":
      if (hasSub) return { type: "openSubmenu", index: activeIndex };
      return isSubmenu ? { type: "none" } : { type: "arrowOut", dir: 1 };
    case "ArrowLeft":
      return isSubmenu ? { type: "closeSubmenu" } : { type: "arrowOut", dir: -1 };
    case "Escape":
      return isSubmenu ? { type: "closeSubmenu" } : { type: "close", reason: "escape" };
    case "Tab":
      return { type: "close", reason: "tab" };
    default:
      return { type: "none" };
  }
}

/** True for a single printable character with no command modifier. */
export function isTypeaheadKey(
  key: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
): boolean {
  return key.length === 1 && key !== " " && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
}

/**
 * Type-ahead: the next actionable item (after `from`, wrapping) whose label
 * starts with `query` (case/accent-insensitive). -1 when nothing matches.
 */
export function typeaheadMatch(
  items: readonly MenuNavItem[],
  query: string,
  from: number,
): number {
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(query);
  if (!q) return -1;
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + step) % n) + n) % n;
    const it = items[i];
    if (isActionable(it) && norm(it.label ?? "").startsWith(q)) return i;
  }
  return -1;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Size {
  width: number;
  height: number;
}

/**
 * Where the flyout opens relative to its anchor:
 * - `point`: at the cursor (context menus);
 * - `bottom-start` / `top-start`: below/above a trigger, left-aligned
 *   (menu bar dropdowns open down, status bar menus open up);
 * - `right-start`: beside a parent item (submenus).
 */
export type MenuPlacement = "point" | "bottom-start" | "top-start" | "right-start";

/** Keeps the flyout this far from the viewport edges. */
const EDGE = 4;

/**
 * Viewport position (left/top, px) for a flyout of `size` anchored to `anchor`,
 * flipping to the opposite side when the preferred one would overflow and
 * clamping into the viewport as a last resort.
 */
export function placeMenu(
  anchor: Rect,
  placement: MenuPlacement,
  size: Size,
  viewport: Size,
  gap = 2,
): { left: number; top: number } {
  let left: number;
  let top: number;
  switch (placement) {
    case "right-start": {
      // Overlap the parent's padding so the item rows line up.
      left = anchor.right - gap;
      top = anchor.top - EDGE;
      if (left + size.width > viewport.width - EDGE) left = anchor.left - size.width + gap;
      break;
    }
    case "bottom-start": {
      left = anchor.left;
      top = anchor.bottom + gap;
      if (top + size.height > viewport.height - EDGE && anchor.top - gap - size.height >= EDGE) {
        top = anchor.top - gap - size.height;
      }
      break;
    }
    case "top-start": {
      left = anchor.left;
      top = anchor.top - gap - size.height;
      if (top < EDGE && anchor.bottom + gap + size.height <= viewport.height - EDGE) {
        top = anchor.bottom + gap;
      }
      break;
    }
    default: {
      // "point": the anchor is a zero-size rect at the cursor.
      left = anchor.left;
      top = anchor.top;
      if (left + size.width > viewport.width - EDGE) left = anchor.left - size.width;
      if (top + size.height > viewport.height - EDGE) top = anchor.top - size.height;
    }
  }
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewport.width - size.width - EDGE));
  top = Math.min(Math.max(EDGE, top), Math.max(EDGE, viewport.height - size.height - EDGE));
  return { left, top };
}
