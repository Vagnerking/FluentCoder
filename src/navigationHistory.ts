export interface NavigationHistory {
  entries: string[];
  index: number;
}

export function createNavigationHistory(): NavigationHistory {
  return { entries: [], index: -1 };
}

/**
 * Records a user-driven file activation. Navigating after going back discards
 * the old forward branch, matching browser and VS Code navigation behavior.
 */
export function recordNavigation(
  history: NavigationHistory,
  path: string
): NavigationHistory {
  if (history.entries[history.index] === path) return history;

  const entries = history.entries.slice(0, history.index + 1);
  entries.push(path);
  return { entries, index: entries.length - 1 };
}

export function navigationTarget(
  history: NavigationHistory,
  direction: -1 | 1
): { path: string; index: number } | null {
  const index = history.index + direction;
  if (index < 0 || index >= history.entries.length) return null;
  return { path: history.entries[index], index };
}

/** Chromium/WebView2 button numbers for browser-style mouse navigation. */
export function mouseNavigationDirection(button: number): -1 | 1 | null {
  if (button === 3) return -1;
  if (button === 4) return 1;
  return null;
}
