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
  mirrorToDiagFile(line);
}

// When `localStorage["lsp.diagToFile"] === "1"`, also append each LSP line to
// the backend's shared `razor-diag.log`, interleaved with the broker's pipeline
// steps. This makes a failing C#/Razor run inspectable as one ordered timeline
// even in a packaged build / under the E2E driver (where the webview console is
// not captured). Off by default — zero cost in normal use. Dynamic import keeps
// `api` out of this module's load path (and avoids any import cycle).
let diagToFile: boolean | undefined;
function mirrorToDiagFile(line: string): void {
  if (diagToFile === undefined) {
    try {
      diagToFile = localStorage.getItem("lsp.diagToFile") === "1";
    } catch {
      diagToFile = false;
    }
  }
  if (!diagToFile) return;
  void import("../api")
    .then(({ razorDiagLog }) => razorDiagLog(line))
    .catch(() => {
      /* diagnostics are best-effort; never let logging break the LSP flow */
    });
}
