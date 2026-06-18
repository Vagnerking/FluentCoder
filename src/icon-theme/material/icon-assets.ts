/**
 * Maps a resolved icon definition name to its bundled SVG URL (Vite-only).
 *
 * `eager + ?url` resolves every icon's URL at build time into one plain string
 * map — so there's no per-icon JS chunk, and Vite emits each SVG as a real
 * static asset (see `assetsInlineLimit` in vite.config). The SVG *bytes* are
 * only fetched when an `<img src>` actually requests one, so startup stays cheap
 * even though the URL table covers all ~1200 icons.
 *
 * This is split from {@link ./material-config} because `import.meta.glob` is
 * Vite syntax that can't run under the plain-Node unit-test runner.
 */
import { materialConfig, iconFileStem } from "./material-config";

const svgUrls = import.meta.glob<string>(
  "../../../node_modules/material-icon-theme/icons/*.svg",
  { query: "?url", import: "default", eager: true },
);

/** Resolves the bundled URL for an icon definition name, or null if missing. */
export function iconUrl(iconName: string): string | null {
  const def = materialConfig.iconDefinitions[iconName];
  if (!def) return null;
  const stem = iconFileStem(def.iconPath);
  return (
    svgUrls[`../../../node_modules/material-icon-theme/icons/${stem}.svg`] ?? null
  );
}
