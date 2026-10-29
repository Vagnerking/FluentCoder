const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

/**
 * Whether two paths must be compared ignoring case: Windows drive paths
 * always; POSIX paths only when the caller has established the filesystem's
 * case behavior. An operating-system default does not identify a volume:
 * macOS also supports case-sensitive APFS volumes.
 */
function caseInsensitivePair(a: string, b: string, caseInsensitivePosix: boolean): boolean {
  if (WINDOWS_ABSOLUTE_PATH.test(a) && WINDOWS_ABSOLUTE_PATH.test(b)) return true;
  return caseInsensitivePosix && a.startsWith("/") && b.startsWith("/");
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Lexical comparison for paths whose spelling/context is already established.
 * Use filesystem identity (editor/existingFile) when opening a local alias;
 * this function does not determine a volume or directory's case behavior.
 * Windows paths are compared
 * case-insensitively because different code paths (the native folder picker,
 * LSP file URIs, the explorer tree) normalize the drive letter and casing
 * differently — `C:\…` and `c:\…` are the same file on Windows. Separators are
 * normalized so `\` and `/` don't read as distinct. Without this, the editor
 * would open the same file as two tabs (issue #7).
 */
export function samePath(a: string, b: string, caseInsensitivePosix = false): boolean {
  const fa = normalizeSeparators(a);
  const fb = normalizeSeparators(b);
  if (caseInsensitivePair(a, b, caseInsensitivePosix)) {
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
  rootPath: string | null,
  caseInsensitivePosix = false
): string {
  if (!rootPath) return filePath;

  const file = normalizeSeparators(filePath);
  const root = trimTrailingSeparators(normalizeSeparators(rootPath));
  const ignoreCase = caseInsensitivePair(filePath, rootPath, caseInsensitivePosix);
  const comparableFile = ignoreCase ? file.toLocaleLowerCase("en-US") : file;
  const comparableRoot = ignoreCase ? root.toLocaleLowerCase("en-US") : root;

  if (comparableFile === comparableRoot) {
    return file.slice(root.length).replace(/^\/+/, "");
  }

  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const comparablePrefix = ignoreCase
    ? rootPrefix.toLocaleLowerCase("en-US")
    : rootPrefix;

  if (!comparableFile.startsWith(comparablePrefix)) return filePath;

  return file.slice(rootPrefix.length);
}
