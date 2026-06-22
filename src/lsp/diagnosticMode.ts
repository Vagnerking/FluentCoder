export type DiagnosticMode = "auto" | "pull" | "push";

/**
 * Decides whether the direct `textDocument/diagnostic` bridge should be active.
 *
 * Roslyn accepts pull diagnostics without advertising `diagnosticProvider`, so
 * its adapter must opt in explicitly. Other servers can keep using the static
 * capability (`auto`) or declare that they only publish diagnostics (`push`).
 */
export function shouldUsePullDiagnostics(
  mode: DiagnosticMode,
  hasStaticCapability: boolean
): boolean {
  return mode === "pull" || (mode === "auto" && hasStaticCapability);
}
