/**
 * Unifies the Monaco instance and boots the VS Code services — must be imported
 * once at app entry, BEFORE any `@monaco-editor/react` editor mounts.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SINGLE-INSTANCE CONTRACT (the critical risk of the v10 migration)
 * ──────────────────────────────────────────────────────────────────────────
 * `@monaco-editor/react` defaults to loading Monaco from a CDN, which would be a
 * DIFFERENT Monaco instance than the one our LSP layer imports. With two
 * instances the language client watches an empty `monaco.editor.getModels()`,
 * never sends `textDocument/didOpen`, and no IntelliSense ever appears.
 *
 * On the v10 stack `monaco-editor` is aliased (package.json) to
 * `@codingame/monaco-vscode-editor-api`, so `import * as monaco from
 * "monaco-editor"` already resolves to the `@codingame` build everywhere.
 * `loader.config({ monaco })` then points `@monaco-editor/react` at that SAME
 * instance — editor and LSP share one Monaco, one model registry, one provider
 * registry.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * INITIALIZATION ORDER
 * ──────────────────────────────────────────────────────────────────────────
 * `@codingame`'s `initialize()` must run exactly once and BEFORE the first
 * editor is created (documented constraint). We start it here at module load
 * and only hand Monaco to `@monaco-editor/react` (via `loader.config`) AFTER it
 * resolves, so the first `<Editor>` can never mount against uninitialized
 * services. `whenMonacoReady` lets the UI gate its first editor on the same
 * promise. The web workers are configured inside `ensureVscodeServices()` via
 * the v10 worker factory (no more `MonacoEnvironment.getWorker` returning the
 * vanilla json/css/html/ts workers — those language services are now provided
 * by real LSP servers, and the embedded TS worker is disabled on purpose).
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { installWindowsFileUriSerialization } from "./lsp/uri";
import { ensureVscodeServices } from "./lsp/vscodeServices";

// Must happen before any model is created. Otherwise Roslyn receives
// file:///c%3A/... and treats project files as miscellaneous. Applied to the
// shared `@codingame` Monaco instance (the alias target), so editor + LSP both
// serialize Windows file URIs as file:///c:/... .
installWindowsFileUriSerialization(monaco);

/**
 * Resolves once the VS Code services are initialized and `@monaco-editor/react`
 * has been pointed at the shared Monaco instance. The first editor must await
 * this (see `EditorPane`). Boots the services exactly once (idempotent — shared
 * with the LSP client bootstrap in `src/lsp/vscodeServices.ts`).
 */
export const whenMonacoReady: Promise<void> = ensureVscodeServices().then(() => {
  // Point @monaco-editor/react at the @codingame instance instead of its CDN
  // default — AFTER initialize() so no editor can mount before services exist.
  loader.config({ monaco });

  // The @codingame build ships VS Code's default keybindings, so a focused
  // editor grabs Ctrl+Shift+P / Ctrl+P (and F1) itself and opens VS Code's
  // built-in quick-input widget — swallowing the keydown before it bubbles to
  // the app's window handler (App.tsx). No command/file quick-access provider
  // is wired to that widget here, so the user gets a dead, empty box instead
  // of the app's Command Palette / Quick Open. `command: null` unbinds the
  // default rule, letting the key bubble to the app handler again.
  monaco.editor.addKeybindingRules([
    {
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      command: null,
    },
    {
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP,
      command: null,
    },
    // Ctrl+T is VS Code's `workbench.action.showAllSymbols`; unbind it so the
    // key bubbles to the app's own "Ir para símbolo no projeto" (SymbolSearch).
    {
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT,
      command: null,
    },
    { keybinding: monaco.KeyCode.F1, command: null },
    // Go to Type Definition has no default VS Code chord — bind the C# Dev Kit
    // shortcut so it works with the editor focused (milestone #5). Go to
    // Implementation (Ctrl+F12) and Format Selection (Ctrl+K Ctrl+F) already
    // ship as @codingame defaults, so they need no rule here.
    {
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.F12,
      command: "editor.action.goToTypeDefinition",
    },
  ]);
});
