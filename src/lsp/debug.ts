import { appendOutput } from "../output/outputStore";

/**
 * Debug log for the LSP lifecycle, mirrored to the webview console and to the
 * "LSP" output channel (issue #6), so it's visible in the bottom panel's "Saída"
 * tab. It used to also append to a file, but that needed a machine-specific
 * absolute path; the console + channel are enough and work on any machine.
 */
export function lspLog(...args: unknown[]): void {
  const line =
    "[lsp] " +
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
  // eslint-disable-next-line no-console
  console.log(line);
  appendOutput("LSP", line);
}
