/// <reference types="vite/client" />

/**
 * Deep import into Monaco's internals: the `ICommandService` decorator used to
 * execute `editor.action.peekLocations` for "Find/Peek References" (see
 * `src/lsp/references.ts`). Monaco ships no `.d.ts` for its internal `esm/vs/...`
 * modules, so declare the one symbol we consume.
 */
declare module "monaco-editor/esm/vs/platform/commands/common/commands.js" {
  /** Service identifier (decorator) resolvable via a command handler accessor. */
  export const ICommandService: unknown;
}

/**
 * The Vite config aliases the bare "vscode" specifier to monaco-languageclient's
 * VS Code compatibility shim (the same live singleton `vscode-languageclient`
 * consumes). TypeScript can't see that alias, so declare just the slice we touch
 * in `src/lsp/client.ts` to patch the shim's "unsupported" provider registrations.
 */
declare module "vscode" {
  export const languages: Record<string, unknown>;
}
