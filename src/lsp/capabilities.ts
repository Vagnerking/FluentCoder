/**
 * Server-capability introspection (pure — no Monaco/LSP imports so it stays unit
 * testable under `node --test`).
 *
 * On the v10 stack a language feature only works when the server ADVERTISES its
 * provider in the `initialize` response AND the native client feature (or our
 * bridge) registers a Monaco provider for it. Several milestone-#5 features
 * (inlay hints, go-to-implementation/type-definition, workspace symbols,
 * range/on-type formatting) rely on the native feature auto-registering, which
 * happens only when the capability is present. So we log exactly what the server
 * offered instead of assuming — turning "does Roslyn support X" into a fact in
 * the LSP log (see `tools/razor-lsp-probe/FINDINGS-fase0.md`).
 */

/**
 * The capabilities we track, mapped to a stable short label used in the log line
 * and in tests. Keyed by the exact `ServerCapabilities` field name.
 */
export const TRACKED_CAPABILITIES: Readonly<Record<string, string>> = {
  hoverProvider: "hover",
  definitionProvider: "definition",
  typeDefinitionProvider: "typeDefinition",
  implementationProvider: "implementation",
  referencesProvider: "references",
  documentSymbolProvider: "documentSymbol",
  workspaceSymbolProvider: "workspaceSymbol",
  renameProvider: "rename",
  codeActionProvider: "codeAction",
  codeLensProvider: "codeLens",
  documentFormattingProvider: "format",
  documentRangeFormattingProvider: "rangeFormat",
  documentOnTypeFormattingProvider: "onTypeFormat",
  inlayHintProvider: "inlayHint",
  signatureHelpProvider: "signatureHelp",
  semanticTokensProvider: "semanticTokens",
  callHierarchyProvider: "callHierarchy",
  typeHierarchyProvider: "typeHierarchy",
};

/**
 * Summarizes which tracked capabilities a server advertised, as two lists of
 * short labels (present / absent). An LSP capability is either a boolean or an
 * options object; both mean "supported". Only `undefined`/`null`/`false` count
 * as absent.
 */
export function summarizeCapabilities(
  capabilities: Record<string, unknown> | undefined
): { present: string[]; absent: string[] } {
  const present: string[] = [];
  const absent: string[] = [];
  for (const [key, label] of Object.entries(TRACKED_CAPABILITIES)) {
    const value = capabilities?.[key];
    if (value === undefined || value === null || value === false) {
      absent.push(label);
    } else {
      present.push(label);
    }
  }
  return { present, absent };
}
