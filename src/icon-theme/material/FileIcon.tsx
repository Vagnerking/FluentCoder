/**
 * Renders the Material icon for a file or folder.
 *
 * Components pass a path/name (and, for folders, whether it's open); this
 * component owns the two-step resolution — name via {@link resolveFileIconName} /
 * {@link resolveFolderIconName}, then the SVG URL via {@link iconUrl}. The URL
 * table is resolved at build time (see icon-assets), so resolution is
 * synchronous; the browser fetches and caches the SVG bytes by content-hashed
 * URL, so repeated rows of the same type reuse one download.
 */
import { iconUrl } from "./icon-assets";
import {
  resolveFileIconName,
  resolveFolderIconName,
  type IconColorTheme,
} from "./icon-resolver";

interface FileIconProps {
  /** File/folder path or bare name (only the last segment is used). */
  path: string;
  /** True for a directory; selects folder resolution + open/closed variant. */
  isDir?: boolean;
  /** For folders, whether it's currently expanded (open-folder icon). */
  expanded?: boolean;
  /** Active color theme; light has its own icon overrides for some types. */
  theme?: IconColorTheme;
  /** Pixel size of the square icon. Defaults to 16 (one explorer row). */
  size?: number;
  /** Extra class for state styling (e.g. dimmed for git-ignored files). */
  className?: string;
}

export function FileIcon({
  path,
  isDir = false,
  expanded = false,
  theme = "dark",
  size = 16,
  className,
}: FileIconProps) {
  const iconName = isDir
    ? resolveFolderIconName(path, expanded, theme)
    : resolveFileIconName(path, theme);
  const url = iconUrl(iconName);

  return (
    <span
      className={`file-icon${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {url && <img src={url} width={size} height={size} alt="" draggable={false} />}
    </span>
  );
}
