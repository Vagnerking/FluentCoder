/**
 * TEMP: file-based debug log for the LSP lifecycle. The webview console isn't
 * captured in the tauri dev log, so we mirror key events to a file we can read
 * from the shell. Remove once the C# flow is confirmed working.
 */
import { writeFile } from "../api";

let buffer = "";
const LOG_PATH = "C:\\Users\\Vagner\\lsp-debug.log";

export function lspLog(...args: unknown[]): void {
  const line =
    "[lsp] " +
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
  // eslint-disable-next-line no-console
  console.log(line);
  buffer += line + "\n";
  void writeFile(LOG_PATH, buffer).catch(() => {});
}
