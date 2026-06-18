/**
 * Icon resolution layer for files and folders.
 *
 * This is the single place that decides *which* Material icon a path gets — the
 * spec's "camada própria de resolução de ícones". UI components never look up
 * extensions or folder names themselves; they call {@link resolveFileIconName} /
 * {@link resolveFolderIconName} and render whatever comes back.
 *
 * Resolution priority (per spec):
 *   1. Exact file name      (package.json, Dockerfile, appsettings.json)
 *   2. File extension       (.cs, .ts, .json)
 *   3. Exact folder name    (Controllers, wwwroot)
 *   4. Generic file icon    (unknown file fallback)
 *   5. Generic folder icon  (unknown folder fallback)
 *
 * So `appsettings.json` tries the exact name first (none), then `.json`; while
 * `package.json` matches the exact name and wins over `.json`.
 *
 * The package keys everything in lowercase, so we lowercase before lookups. The
 * resolved icon *name* (a stable string) is cached; the SVG URL behind it is
 * loaded and cached separately by the component layer.
 */
import { materialConfig } from "./material-config";

/** Which palette variant of the theme to resolve against. */
export type IconColorTheme = "dark" | "light";

/** Last path segment, tolerant of both `\` and `/`. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** All extension candidates for a name, longest first ("d.ts" before "ts"). */
function extensionCandidates(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let from = lower.indexOf(".");
  while (from !== -1) {
    out.push(lower.slice(from + 1));
    from = lower.indexOf(".", from + 1);
  }
  return out;
}

/** Light overrides win when the editor is in a light theme; else the base map. */
function pick(
  map: Record<string, string>,
  lightMap: Record<string, string> | undefined,
  theme: IconColorTheme,
  key: string,
): string | undefined {
  if (theme === "light" && lightMap?.[key]) return lightMap[key];
  return map[key];
}

// Resolved icon *names* are cheap and stable, so we memoize them. Keyed by
// theme so a light/dark switch doesn't serve stale names.
const fileCache = new Map<string, string>();
const folderCache = new Map<string, string>();

/**
 * Resolves the Material icon definition name for a file path/name.
 * Always returns a usable name (falls back to the generic file icon).
 */
export function resolveFileIconName(
  pathOrName: string,
  theme: IconColorTheme = "dark",
): string {
  const name = baseName(pathOrName).toLowerCase();
  const cacheKey = `${theme}:${name}`;
  const cached = fileCache.get(cacheKey);
  if (cached) return cached;

  let icon: string | undefined;

  // 1. Exact file name (package.json, dockerfile, tsconfig.json…).
  icon = pick(
    materialConfig.fileNames,
    materialConfig.light.fileNames,
    theme,
    name,
  );

  // 2. File extension — longest compound extension first.
  if (!icon) {
    for (const ext of extensionCandidates(name)) {
      icon = pick(
        materialConfig.fileExtensions,
        materialConfig.light.fileExtensions,
        theme,
        ext,
      );
      if (icon) break;
    }
  }

  // 4. Generic file fallback.
  if (!icon) icon = materialConfig.file;

  fileCache.set(cacheKey, icon);
  return icon;
}

/**
 * Resolves the Material icon definition name for a folder.
 * `expanded` selects the open-folder variant. Falls back to the generic folder.
 */
export function resolveFolderIconName(
  pathOrName: string,
  expanded = false,
  theme: IconColorTheme = "dark",
): string {
  const name = baseName(pathOrName).toLowerCase();
  const cacheKey = `${theme}:${expanded ? "exp" : "col"}:${name}`;
  const cached = folderCache.get(cacheKey);
  if (cached) return cached;

  const names = expanded
    ? materialConfig.folderNamesExpanded
    : materialConfig.folderNames;
  const lightNames = expanded
    ? materialConfig.light.folderNamesExpanded
    : materialConfig.light.folderNames;

  // 3. Exact folder name (Controllers, wwwroot, node_modules…).
  let icon = pick(names, lightNames, theme, name);

  // 5. Generic folder fallback (open vs closed).
  if (!icon) {
    icon = expanded ? materialConfig.folderExpanded : materialConfig.folder;
  }

  folderCache.set(cacheKey, icon);
  return icon;
}

/** Clears resolution caches — call if associations are customized at runtime. */
export function clearIconCache(): void {
  fileCache.clear();
  folderCache.clear();
}
