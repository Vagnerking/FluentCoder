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

// Mirror LSP lines to the backend's shared `razor-diag.log`, interleaved with
// the broker's pipeline steps, so a failing C#/Razor run is inspectable as one
// ordered timeline even in a packaged build / under the E2E driver (where the
// webview console isn't captured). Dynamic import keeps `api` out of this
// module's load path (and avoids an import cycle).
//
// Two tiers: lines about the Razor/C# (Roslyn) pipeline are ALWAYS mirrored
// (that's the whole point — the projection chain is the hard thing to debug);
// everything else only mirrors when `localStorage["lsp.diagToFile"] === "1"`, to
// keep the file focused in normal use.
const PIPELINE_RE =
  /razor|projection|roslyn|csharp|cshtml|\.g\.cs|semantic|diagnostic|solution\/open|projectInitial/i;
let diagToFileAll: boolean | undefined;
function mirrorToDiagFile(line: string): void {
  if (diagToFileAll === undefined) {
    try {
      diagToFileAll = localStorage.getItem("lsp.diagToFile") === "1";
    } catch {
      diagToFileAll = false;
    }
  }
  if (!diagToFileAll && !PIPELINE_RE.test(line)) return;
  void import("../api")
    .then(({ razorDiagLog }) => razorDiagLog(line))
    .catch(() => {
      /* diagnostics are best-effort; never let logging break the LSP flow */
    });
}
