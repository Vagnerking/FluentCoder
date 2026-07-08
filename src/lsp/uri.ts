/**
 * Path ↔ URI helpers shared across the LSP layer.
 *
 * Both the Monaco model URI and the LSP `rootUri`/`textDocument.uri` must use the
 * `file://` scheme so they match a client's `documentSelector` ({ scheme: "file" })
 * and so the server resolves paths. A raw Windows path (`C:\foo\bar.cs`) handed to
 * Monaco would be parsed with `C` as the URI *scheme* — never matching `file`.
 */
import type * as Monaco from "monaco-editor";

const WINDOWS_DRIVE_IN_FILE_URI = /^(file:\/\/\/)([a-z])%3A(?=\/)/i;
const WINDOWS_DRIVE_URI_KEY = /^(file:\/\/\/)([a-z])(?::|%3A)(?=\/)/i;
const WINDOWS_FILE_PATH = /^\/[a-z]:\//i;
const WINDOWS_EXTENDED_UNC_PATH = /^\\\\\?\\UNC\\/i;
const WINDOWS_EXTENDED_PATH = /^\\\\\?\\/;

type MutableUriFactory = {
  parse: typeof Monaco.Uri.parse;
  file: typeof Monaco.Uri.file;
  from: typeof Monaco.Uri.from;
  __fluentCoderWindowsUriPatched?: boolean;
};

function canonicalizeWindowsFileUri(uri: Monaco.Uri): Monaco.Uri {
  if (uri.scheme !== "file" || !WINDOWS_FILE_PATH.test(uri.path)) return uri;

  const originalToString = uri.toString.bind(uri);
  uri.toString = (skipEncoding?: boolean): string => {
    const serialized = originalToString(skipEncoding);
    return serialized.replace(WINDOWS_DRIVE_IN_FILE_URI, "$1$2:");
  };
  return uri;
}

/**
 * String-level form of the drive-colon canonicalization above: turns
 * `file:///c%3A/foo` into `file:///c:/foo`, leaving every other escape (`%20`
 * etc.) intact. Every uri our code puts ON THE WIRE must pass through this —
 * Roslyn tracks documents by exact uri string, and the v10 native document
 * sync serializes through the extHost `Uri` class, which this module's
 * `installWindowsFileUriSerialization` patch does NOT reach (it only patches
 * the `monaco.Uri` factory). Without one canonical form, the native didOpen
 * (`c%3A`) and our hand-rolled requests (`c:`) address "different" documents
 * and Roslyn shuts its queue down on the first mismatched didClose.
 */
export function canonicalizeDriveInFileUri(uri: string): string {
  return uri.replace(WINDOWS_DRIVE_IN_FILE_URI, "$1$2:");
}

/**
 * Monaco percent-encodes the colon in a Windows drive when serializing a URI:
 * `file:///c%3A/foo`. That URI is valid in isolation, but Roslyn 5's
 * DocumentUri-to-path conversion turns it into `/c:/foo`, so the open document
 * no longer matches the `C:\foo` document loaded from MSBuild and is placed in
 * "Miscellaneous Files".
 *
 * Install this before the first model is created. It keeps normal URI escaping
 * (spaces remain `%20`) and only restores the drive separator required by
 * Windows file URIs: `file:///c:/foo`.
 */
export function installWindowsFileUriSerialization(
  monaco: typeof Monaco
): void {
  const factory = monaco.Uri as unknown as MutableUriFactory;
  if (factory.__fluentCoderWindowsUriPatched) return;

  const originalParse = factory.parse.bind(monaco.Uri);
  const originalFile = factory.file.bind(monaco.Uri);
  const originalFrom = factory.from.bind(monaco.Uri);

  factory.parse = ((value: string, strict?: boolean) =>
    canonicalizeWindowsFileUri(
      originalParse(value, strict)
    )) as typeof Monaco.Uri.parse;
  factory.file = ((path: string) =>
    canonicalizeWindowsFileUri(originalFile(path))) as typeof Monaco.Uri.file;
  factory.from = ((components: Monaco.UriComponents, strict?: boolean) =>
    canonicalizeWindowsFileUri(
      originalFrom(components, strict)
    )) as typeof Monaco.Uri.from;

  factory.__fluentCoderWindowsUriPatched = true;
}

/**
 * Converts a filesystem path to a `file:///` URI. Handles Windows drive paths
 * (`C:\foo` → `file:///c:/foo`) and POSIX paths alike.
 */
export function toFileUri(p: string): string {
  let filesystemPath = p;
  if (WINDOWS_EXTENDED_UNC_PATH.test(filesystemPath)) {
    filesystemPath = `\\\\${filesystemPath.slice(8)}`;
  } else if (WINDOWS_EXTENDED_PATH.test(filesystemPath)) {
    filesystemPath = filesystemPath.slice(4);
  }

  let normalized = filesystemPath.replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    return `file:${encodeURI(normalized)}`;
  }
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  // encodeURI keeps `/` and `:` intact while escaping spaces etc.
  return `file://${encodeURI(normalized)}`;
}

/**
 * Stable key for comparing file URIs produced by native Windows paths and by
 * Monaco. Monaco lowercases the drive letter; native paths commonly retain an
 * uppercase drive. Both identify the same file and must share one map key.
 */
export function canonicalFileUriKey(uri: string): string {
  return uri.replace(
    WINDOWS_DRIVE_URI_KEY,
    (_match, prefix: string, drive: string) =>
      `${prefix}${drive.toLocaleLowerCase("en-US")}:`
  );
}

/**
 * Reverse of {@link toFileUri}: a `file://` URI back to a filesystem path.
 * `file:///c:/foo/bar.cs` → `C:\foo\bar.cs`; `file:///home/x` → `/home/x`.
 * Used by the editor opener to turn an LSP definition target into a path the
 * app can open in a tab.
 */
export function fromFileUri(uri: string): string {
  let p = uri.replace(/^file:\/\//, "");
  p = decodeURI(p);
  // `decodeURI` skips reserved characters, so a percent-encoded drive colon
  // (`/c%3A/…` — Roslyn serializes MetadataAsSource uris this way) survives it
  // and breaks the drive-letter handling below. Colon is invalid elsewhere in
  // a Windows path and a legal literal on POSIX, so decoding it is always safe.
  p = p.replace(/%3A/gi, ":");
  // Strip the leading slash before a Windows drive letter (`/c:/…` → `c:/…`).
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
  // On Windows, normalize to backslashes for a drive-rooted path.
  if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, "\\");
  return p;
}
