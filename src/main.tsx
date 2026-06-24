// MUST be first: unifies the Monaco instance (npm, not CDN) + wires workers so
// the editor models and the LSP client share one Monaco. See monaco-loader.ts.
import "./monaco-loader";
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { DetachedEditor } from "./components/DetachedEditor";
import { readDetachToken } from "./detach/editorWindow";
import "./styles.css";

// Kill the WebView's native right-click menu (Inspecionar / Recarregar / Salvar
// como…). The app provides its own context menus everywhere; this suppresses the
// default one for any spot without a custom handler. Our menus already call
// preventDefault (so they're unaffected) and Monaco renders its own menu. Runs
// in the capture phase so it wins even where a child stops propagation.
window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

// A window opened as a torn-off editor renders only that editor — never the full
// workbench (no session restore, no LSP manager, etc.).
const detachToken = readDetachToken();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {detachToken ? <DetachedEditor token={detachToken} /> : <App />}
  </React.StrictMode>
);

async function revealPaintedWindow() {
  // One frame lets React commit the shell while keeping warm-window startup
  // effectively immediate. Fonts are cached by the shared WebView process.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await invoke("window_ready");
}

if (!detachToken) {
  void revealPaintedWindow().catch((error) => {
    console.error("Falha ao exibir a janela inicializada:", error);
    const current = getCurrentWindow();
    void current.show().then(() => current.setFocus()).catch((fallbackError) => {
      console.error("Falha no fallback de exibição da janela:", fallbackError);
    });
  });
}
