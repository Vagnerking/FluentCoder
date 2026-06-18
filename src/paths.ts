const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
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
