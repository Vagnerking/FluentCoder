/**
 * Typed access to the Material Icon Theme package *data* (no bundler magic).
 *
 * The npm package `material-icon-theme` ships the same JSON contract VSCode uses
 * for icon themes: maps of file extension / file name / folder name → an *icon
 * definition name*, plus `iconDefinitions[name].iconPath` pointing at an SVG. We
 * don't reimplement that data — we read it and resolve against it.
 *
 * This module is deliberately free of `import.meta` / Vite-only syntax so the
 * resolver (and its unit tests) can import it under plain Node. The SVG-URL
 * lookup that *does* need Vite lives in {@link ./icon-assets}.
 */
import iconsJson from "material-icon-theme/dist/material-icons.json";

/** One icon definition: a relative path to its SVG, as shipped by the package. */
export interface IconDefinition {
  iconPath: string;
}

/** Per-theme override maps (light/high-contrast reuse the same key shapes). */
export interface ThemeOverrides {
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
}

/** The subset of the package JSON our resolver reads. */
export interface MaterialIconsConfig {
  iconDefinitions: Record<string, IconDefinition>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  /** Default fallbacks when nothing matches. */
  file: string;
  folder: string;
  folderExpanded: string;
  light: ThemeOverrides;
  highContrast: ThemeOverrides;
}

export const materialConfig = iconsJson as unknown as MaterialIconsConfig;

/** `./../icons/folder-src.svg` (from the JSON) → `folder-src` (the SVG stem). */
export function iconFileStem(iconPath: string): string {
  const file = iconPath.split("/").pop() ?? "";
  return file.replace(/\.svg$/i, "");
}
