const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * True when two paths point at the same file. Windows paths are compared
 * case-insensitively because different code paths (the native folder picker,
 * LSP file URIs, the explorer tree) normalize the drive letter and casing
 * differently — `C:\…` and `c:\…` are the same file on Windows. Separators are
 * normalized so `\` and `/` don't read as distinct. Without this, the editor
 * would open the same file as two tabs (issue #7).
 */
export function samePath(a: string, b: string): boolean {
  const fa = normalizeSeparators(a);
  const fb = normalizeSeparators(b);
  const isWindowsPath =
    WINDOWS_ABSOLUTE_PATH.test(a) && WINDOWS_ABSOLUTE_PATH.test(b);
  if (isWindowsPath) {
    return fa.toLocaleLowerCase("en-US") === fb.toLocaleLowerCase("en-US");
  }
  return fa === fb;
}

function trimTrailingSeparators(path: string): string {
  if (path === "/" || /^[a-zA-Z]:\/$/.test(path)) return path;
  return path.replace(/\/+$/, "");
}

/**
 * Returns a path relative to the workspace when the file belongs to it.
 * Windows paths are compared case-insensitively because LSP file URIs may
 * normalize the drive letter differently from the native folder picker.
 * Files outside the workspace keep their absolute path.
 */
export function pathForWorkspaceDisplay(
  filePath: string,
  rootPath: string | null
): string {
  if (!rootPath) return filePath;

  const file = normalizeSeparators(filePath);
  const root = trimTrailingSeparators(normalizeSeparators(rootPath));
  const isWindowsPath =
    WINDOWS_ABSOLUTE_PATH.test(filePath) &&
    WINDOWS_ABSOLUTE_PATH.test(rootPath);
  const comparableFile = isWindowsPath ? file.toLocaleLowerCase("en-US") : file;
  const comparableRoot = isWindowsPath ? root.toLocaleLowerCase("en-US") : root;

  if (comparableFile === comparableRoot) {
    return file.slice(root.length).replace(/^\/+/, "");
  }

  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const comparablePrefix = isWindowsPath
    ? rootPrefix.toLocaleLowerCase("en-US")
    : rootPrefix;

  if (!comparableFile.startsWith(comparablePrefix)) return filePath;

  return file.slice(rootPrefix.length);
}
