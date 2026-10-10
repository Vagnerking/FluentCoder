/**
 * Pure keyboard rules for the <Tabs> primitive (WAI-ARIA "tabs" pattern with
 * a roving tabindex). Kept free of React/DOM so it is unit-tested directly.
 */

export type TabsOrientation = "horizontal" | "vertical";

/** Minimal shape the navigation needs: whether a tab can take focus. */
export interface TabsNavItem {
  disabled?: boolean;
}

/** First enabled index scanning from `from` in `dir`, wrapping; -1 if none. */
export function nextEnabledTab(
  items: readonly TabsNavItem[],
  from: number,
  dir: 1 | -1,
): number {
  const n = items.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return -1;
}

/** First / last enabled index, or -1 when every tab is disabled. */
export function firstEnabledTab(items: readonly TabsNavItem[]): number {
  return items.findIndex((t) => !t.disabled);
}
export function lastEnabledTab(items: readonly TabsNavItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (!items[i].disabled) return i;
  return -1;
}

/**
 * The tab a key moves focus (and, with automatic activation, the selection)
 * to — or `null` when the key isn't a tab-navigation key for this orientation.
 * Arrows wrap and skip disabled tabs; Home/End jump to the enabled ends.
 */
export function tabsKeyTarget(
  key: string,
  current: number,
  items: readonly TabsNavItem[],
  orientation: TabsOrientation = "horizontal",
): number | null {
  const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  let target: number;
  switch (key) {
    case prevKey:
      target = nextEnabledTab(items, current < 0 ? 0 : current, -1);
      break;
    case nextKey:
      target = nextEnabledTab(items, current < 0 ? -1 : current, 1);
      break;
    case "Home":
      target = firstEnabledTab(items);
      break;
    case "End":
      target = lastEnabledTab(items);
      break;
    default:
      return null;
  }
  return target < 0 ? null : target;
}

/**
 * Which tab owns the roving `tabIndex=0`: the selected one when it's enabled,
 * otherwise the first enabled tab (so the tablist is always reachable by Tab).
 */
export function rovingTabIndex(
  items: readonly TabsNavItem[],
  selectedIndex: number,
): number {
  if (selectedIndex >= 0 && !items[selectedIndex]?.disabled) return selectedIndex;
  return firstEnabledTab(items);
}
