// Whole-UI zoom (VSCode-style workbench scale). The scale is applied through the
// WebView's non-standard `zoom` property so the px-based chrome reflows, unlike
// `transform: scale`. Pure helpers live here so they can be unit-tested without
// dragging in App.tsx (which imports Monaco and browser-only modules).

/** Smallest allowed scale (50%). */
export const UI_SCALE_MIN = 0.5;
/** Largest allowed scale (300%). */
export const UI_SCALE_MAX = 3;
/** How much each zoom-in/out keystroke changes the scale (10%). */
export const UI_SCALE_STEP = 0.1;
/** The default/reset scale (100%). */
export const UI_SCALE_DEFAULT = 1;

/** Clamps a scale to [MIN, MAX] and rounds to 2 decimals to avoid FP drift
 * (e.g. 0.1 + 0.2 → 0.30000000000000004). Non-finite input falls back to the
 * default so a corrupt persisted value can never brick the UI. */
export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return UI_SCALE_DEFAULT;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

/** Next scale after a zoom in (+1) or out (-1) step, clamped to range. */
export function stepUiScale(value: number, direction: 1 | -1): number {
  return clampUiScale(value + direction * UI_SCALE_STEP);
}
