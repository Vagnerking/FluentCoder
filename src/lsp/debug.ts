/**
 * TEMP: file-based debug log for the LSP lifecycle. The webview console isn't
 * captured in the tauri dev log, so we mirror key events to a file we can read
 * from the shell. Remove once the C# flow is confirmed working.
 */
import { writeFile } from "../api";

let buffer = "";
// Temp file we can read from the shell to diagnose LSP startup/diagnostics. The
// previous path was hardcoded to another machine, so nothing was ever written.
const LOG_PATH = "C:\\Users\\rafae\\AppData\\Local\\Temp\\fc-lsp-debug.log";

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
