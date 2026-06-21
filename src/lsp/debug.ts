/**
 * Debug log for the LSP lifecycle, mirrored to the webview console. It used to
 * also append to a file, but that needed a machine-specific absolute path; the
 * console is enough and works on any machine.
 */

export function lspLog(...args: unknown[]): void {
  const line =
    "[lsp] " +
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
  // eslint-disable-next-line no-console
  console.log(line);
}
