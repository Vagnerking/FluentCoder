/**
 * Pure logic behind the `<Select>` primitive: keyboard navigation, type-ahead
 * and popup placement. Kept free of React/DOM so it can be unit-tested with
 * `node --test` (the component only wires these results to state and events).
 *
 * Keyboard contract follows the WAI-ARIA APG "select-only combobox": focus stays
 * on the trigger, the highlighted option is exposed via `aria-activedescendant`
 * and disabled options are skipped. Closed type-ahead mirrors the native
 * `<select>` (it changes the value directly), so migrating call sites keeps the
 * behaviour users already had.
 */

/** Minimal shape the helpers need from an option. */
export interface NavOption {
  label: string;
  disabled?: boolean;
}

/** Index of the first enabled option, or -1 when every option is disabled. */
export function firstEnabledIndex(options: readonly NavOption[]): number {
  return options.findIndex((o) => !o.disabled);
}

/** Index of the last enabled option, or -1 when every option is disabled. */
export function lastEnabledIndex(options: readonly NavOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i].disabled) return i;
  }
  return -1;
}

/**
 * Moves `steps` enabled options away from `from` (negative = up), clamping at
 * the ends (APG listboxes don't wrap). Disabled options are skipped and don't
 * count as a step. With no valid start, it falls back to the first/last
 * enabled option depending on direction.
 */
export function moveEnabledIndex(
  options: readonly NavOption[],
  from: number,
  steps: number,
): number {
  if (from < 0 || from >= options.length) {
    return steps < 0 ? lastEnabledIndex(options) : firstEnabledIndex(options);
  }
  const dir = steps < 0 ? -1 : 1;
  let remaining = Math.abs(steps);
  let current = from;
  for (let i = from + dir; i >= 0 && i < options.length && remaining > 0; i += dir) {
    if (!options[i].disabled) {
      current = i;
      remaining--;
    }
  }
  return current;
}

/** Lowercase + accent-insensitive form used for type-ahead matching. */
export function normalizeForTypeahead(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Type-ahead: the enabled option whose label starts with `query`, searching
 * forward from `from` and wrapping. Typing the same character repeatedly
 * ("s", "ss", "sss") cycles through the options starting with it, like native
 * selects; a multi-character query keeps the current option if it still
 * matches. Returns -1 when nothing matches.
 */
export function typeaheadIndex(
  options: readonly NavOption[],
  query: string,
  from: number,
): number {
  const q = normalizeForTypeahead(query);
  if (!q || options.length === 0) return -1;
  const repeated = q.split("").every((c) => c === q[0]);
  const needle = repeated ? q[0] : q;
  // A repeated char (or a fresh one-char query) cycles to the NEXT match; a
  // longer query re-tests the current option first so it doesn't jump away.
  const offset = repeated ? 1 : 0;
  const start = from < 0 ? 0 : from + offset;
  for (let n = 0; n < options.length; n++) {
    const i = (start + n) % options.length;
    const opt = options[i];
    if (!opt.disabled && normalizeForTypeahead(opt.label).startsWith(needle)) {
      return i;
    }
  }
  return -1;
}

/** True for keys that feed the type-ahead buffer (one printable character). */
export function isTypeaheadKey(
  key: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
): boolean {
  return key.length === 1 && key !== " " && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
}

/** How many options PageUp/PageDown jump. */
export const PAGE_STEP = 10;

/** What the component should do in response to a key. */
export type SelectKeyAction =
  /** Key not handled — let it propagate untouched. */
  | { type: "none" }
  /** Open the popup with `activeIndex` highlighted. */
  | { type: "open"; activeIndex: number }
  /** Popup stays open; move the highlight. */
  | { type: "move"; activeIndex: number }
  /** Choose `index`, then close. `keepDefault` lets Tab still move focus. */
  | { type: "commit"; index: number; keepDefault?: boolean }
  /** Close without changing the value. */
  | { type: "close" };

export interface SelectKeyState {
  open: boolean;
  /** Highlighted option while open (-1 = none). */
  activeIndex: number;
  /** Index of the current value (-1 = no match). */
  selectedIndex: number;
}

/**
 * Maps a non-type-ahead key press to an action, given the current state.
 *
 * Closed: ArrowDown/ArrowUp/Enter/Space open on the current value; Home/End
 * open on the first/last option. Open: arrows/Home/End/PageUp/PageDown move,
 * Enter/Space/Alt+ArrowUp commit, Tab commits and lets focus move on, Esc
 * closes without changing the value.
 */
export function selectKeyAction(
  key: string,
  state: SelectKeyState,
  options: readonly NavOption[],
  mods: { altKey?: boolean } = {},
): SelectKeyAction {
  const { open, activeIndex, selectedIndex } = state;
  const startIndex =
    selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : firstEnabledIndex(options);

  if (!open) {
    switch (key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        return { type: "open", activeIndex: startIndex };
      case "Home":
        return { type: "open", activeIndex: firstEnabledIndex(options) };
      case "End":
        return { type: "open", activeIndex: lastEnabledIndex(options) };
      default:
        return { type: "none" };
    }
  }

  const canCommit = activeIndex >= 0 && !options[activeIndex]?.disabled;
  switch (key) {
    case "ArrowDown":
      return { type: "move", activeIndex: moveEnabledIndex(options, activeIndex, 1) };
    case "ArrowUp":
      if (mods.altKey) {
        return canCommit ? { type: "commit", index: activeIndex } : { type: "close" };
      }
      return { type: "move", activeIndex: moveEnabledIndex(options, activeIndex, -1) };
    case "PageDown":
      return { type: "move", activeIndex: moveEnabledIndex(options, activeIndex, PAGE_STEP) };
    case "PageUp":
      return { type: "move", activeIndex: moveEnabledIndex(options, activeIndex, -PAGE_STEP) };
    case "Home":
      return { type: "move", activeIndex: firstEnabledIndex(options) };
    case "End":
      return { type: "move", activeIndex: lastEnabledIndex(options) };
    case "Enter":
    case " ":
      return canCommit ? { type: "commit", index: activeIndex } : { type: "close" };
    case "Tab":
      return canCommit
        ? { type: "commit", index: activeIndex, keepDefault: true }
        : { type: "close" };
    case "Escape":
      return { type: "close" };
    default:
      return { type: "none" };
  }
}

/** Gap (px) between the trigger and the popup, and the popup and the viewport. */
export const POPUP_GAP = 4;
export const VIEWPORT_MARGIN = 8;

export interface PopupPlacement {
  /** Open below (`top` set) or above (`bottom` set) the trigger. */
  side: "below" | "above";
  left: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  maxHeight: number;
}

/**
 * Positions the popup (in viewport coordinates, for `position: fixed`) next to
 * the trigger. It opens below unless there isn't room for the list and there's
 * more room above; the max height is capped to the space on the chosen side,
 * and it's shifted horizontally so it never overflows the viewport.
 */
export function computePopupPlacement(
  trigger: { left: number; top: number; bottom: number; width: number },
  viewport: { width: number; height: number },
  desiredHeight: number,
  maxHeight = 320,
): PopupPlacement {
  const spaceBelow = viewport.height - trigger.bottom - POPUP_GAP - VIEWPORT_MARGIN;
  const spaceAbove = trigger.top - POPUP_GAP - VIEWPORT_MARGIN;
  const wanted = Math.min(desiredHeight, maxHeight);
  // Below by default; flip only when the list doesn't fit and above is roomier.
  const below = spaceBelow >= wanted || spaceBelow >= spaceAbove;
  const room = Math.max(0, below ? spaceBelow : spaceAbove);
  const minWidth = trigger.width;
  const maxLeft = viewport.width - VIEWPORT_MARGIN - minWidth;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(trigger.left, maxLeft));
  return below
    ? {
        side: "below",
        left,
        top: trigger.bottom + POPUP_GAP,
        minWidth,
        maxHeight: Math.min(maxHeight, room),
      }
    : {
        side: "above",
        left,
        bottom: viewport.height - trigger.top + POPUP_GAP,
        minWidth,
        maxHeight: Math.min(maxHeight, room),
      };
}
