import { realpathSync } from "node:fs";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @tauri-apps/cli sets these; we honor them so dev works on any host.
const host = process.env.TAURI_DEV_HOST;

// monaco-languageclient v10 runs on `@codingame/monaco-vscode-api`, which
// REGISTERS the bare `vscode` module itself (its package.json maps the `vscode`
// import to the real VS Code API surface). So unlike the v1.x line we must NOT
// alias `vscode` to a hand-written shim — doing so would shadow the package and
// give `vscode-languageclient` a different singleton than the editor services,
// breaking the whole stack. The alias is gone on purpose. `monaco-editor` is
// already redirected to `@codingame/monaco-vscode-editor-api` via package.json,
// so editor + LSP share one Monaco instance (the single-instance contract).

// Worktrees may share dependencies through a junction/symlink. Vite resolves
// font URLs to that physical directory, so explicitly allow it in development.
const dependenciesRoot = realpathSync(
  fileURLToPath(new URL("./node_modules", import.meta.url)),
);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // The `@codingame/monaco-vscode-api` stack ships hundreds of ESM modules that
  // import each other deeply and rely on `new URL(..., import.meta.url)` worker
  // resolution. esbuild's dep pre-bundling rewrites those URLs and routinely
  // chokes on the cyclic graph, so we EXCLUDE the whole `@codingame` stack and
  // let Vite serve its source ESM directly (the official guidance for it).
  //
  // BUT `monaco-languageclient` itself must be INCLUDED (pre-bundled): it does
  // `import { BaseLanguageClient } from "vscode-languageclient/browser.js"`, and
  // `vscode-languageclient` (+ `vscode-jsonrpc`, the protocol pkg) are CommonJS.
  // Served raw, Vite's cjs→esm interop can't surface that named export and the
  // app dies at load with "does not provide an export named 'BaseLanguageClient'"
  // (blank screen). Pre-bundling lets esbuild resolve the CJS interop and expose
  // the named exports. We list the CJS deps explicitly so esbuild folds them in.
  optimizeDeps: {
    include: [
      "monaco-languageclient",
      "vscode-languageclient",
      "vscode-languageclient/browser.js",
      "vscode-jsonrpc",
      "vscode-languageserver-protocol",
      "vscode-ws-jsonrpc",
    ],
    exclude: [
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-editor-api",
      "vscode",
    ],
  },

  // The v10 worker factory loads its workers as ES modules
  // (`new Worker(url, { type: "module" })` — editor/textmate/extension-host
  // workers). Rollup's default worker output format is `iife`, which cannot be
  // code-split, and those workers DO split (they import shared @codingame
  // chunks) — hence the build error "UMD and IIFE output formats are not
  // supported for code-splitting builds". Emit ES-module workers instead.
  worker: {
    format: "es",
  },

  build: {
    // Don't inline the Material icon SVGs as base64 in the JS bundle — there
    // are ~1200 of them and inlining loads them all at startup, hurting cold
    // load. Emitting each as a hashed file lets the browser fetch only the
    // icons actually shown, and cache them. Other small assets still inline.
    assetsInlineLimit: (file) =>
      file.includes("material-icon-theme/icons/") ? false : undefined,
  },

  // Vite options tailored for Tauri development.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), dependenciesRoot],
    },
    watch: {
      // Don't watch the Rust side from Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
}));
