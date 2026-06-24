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
  // chokes on the cyclic graph, so we exclude the whole stack from optimization
  // and let Vite serve the source ESM directly (the official guidance for this
  // package). No `vscode` shim to pre-bundle anymore either.
  optimizeDeps: {
    exclude: [
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-editor-api",
      "monaco-languageclient",
      "vscode",
    ],
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
