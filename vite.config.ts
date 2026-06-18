import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @tauri-apps/cli sets these; we honor them so dev works on any host.
const host = process.env.TAURI_DEV_HOST;

// `vscode-languageclient` (pulled in by monaco-languageclient) does
// `require("vscode")`, a module that only exists inside a real VS Code
// extension host. monaco-languageclient@1.x ships a browser shim for it at
// lib/vscode-compatibility.js; in Node it installs that via a require hook, but
// Vite/esbuild can't see that hook — so we alias "vscode" to the shim here.
const vscodeShim = fileURLToPath(
  new URL(
    "./node_modules/monaco-languageclient/lib/vscode-compatibility.js",
    import.meta.url,
  ),
);

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      // Both copies of vscode-languageclient (top-level and the one nested under
      // monaco-languageclient) resolve "vscode" to the same compatibility shim.
      vscode: vscodeShim,
    },
  },

  // Pre-bundle the shim so esbuild's dep optimizer resolves "vscode" too.
  optimizeDeps: {
    include: ["vscode-languageclient", "monaco-languageclient"],
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
    watch: {
      // Don't watch the Rust side from Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
}));
