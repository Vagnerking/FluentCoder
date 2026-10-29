// MUST be first: unifies the Monaco instance (npm, not CDN) + wires workers so
// the editor models and the LSP client share one Monaco. See monaco-loader.ts.
import { whenMonacoReady } from "./monaco-loader";
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { DetachedEditor } from "./components/DetachedEditor";
import { readDetachToken } from "./detach/editorWindow";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles.css";
import "./styles/icons.css";
import "./styles/shell.css";
import "./styles/explorer.css";
import "./styles/tabs.css";
import "./styles/editor.css";
import "./styles/git.css";
import "./styles/git-fluent.css";
import "./styles/agents.css";
import "./styles/panels.css";
import "./styles/status.css";
import "./styles/overlays.css";
import "./styles/graph.css";
import "./styles/menu.css";
import "./styles/tooltip.css";
import "./styles/workbench.css";
import "./styles/extensions.css";
import "./styles/views.css";
import "./styles/view-pane.css";
import "./styles/settings.css";
import "./theme/acrylic.css";
import { applyAcrylicFlyouts } from "./theme/acrylic";
import { bootSettings } from "./settings/bootstrap";
import { installWorkbenchSettings } from "./settings/applyWorkbench";
import { installThemeSettings } from "./settings/applyTheme";
import { installMonacoSettingsBridge } from "./settings/monacoBridge";
import { installKeybindings } from "./settings/keybindingRuntime";
import { installSettingsJsonSupport } from "./settings/settingsJsonMonaco";
import { installExtHostSettingsBridge } from "./settings/extHostBridge";
import { getPlatform } from "./platform/os";
import { installNativeDragGuard } from "./workbench/workbenchDrag";
import { bootThemes } from "./theme/boot";

// macOS runs a native, opaque window (a transparent frameless window never
// materializes there — the app would show only a Dock icon and menu bar). Tag the
// root before first paint so the CSS paints a solid base under the translucent
// surfaces instead of leaving them over a void. Windows keeps its Mica backdrop.
// The OS comes from the Rust side once (`window.__FLUENT_PLATFORM__`, see
// `src/platform/os.ts`) — never `navigator.platform`. `html.platform-*` also
// selects the per-OS font stacks (`styles/tokens.css`).
// Linux runs frameless + transparent like Windows, but with no Mica: the CSS
// paints a solid, rounded window surface itself (see `html.platform-linux`).
document.documentElement.classList.add(`platform-${getPlatform().os}`);

// Flyouts acrílicos só onde o WebView desenha o backdrop-filter (senão opacos).
applyAcrylicFlyouts();

// Temas (cor, ícones) + contribuições declarativas de extensões (temas,
// gramáticas, snippets — lidas como dados, sem executar código). O tema do
// cache entra antes do 1º paint.
bootThemes();

// Kill the WebView's native right-click menu (Inspecionar / Recarregar / Salvar
// como…). The app provides its own context menus everywhere; this suppresses the
// default one for any spot without a custom handler. Our menus already call
// preventDefault (so they're unaffected) and Monaco renders its own menu. Runs
// in the capture phase so it wins even where a child stops propagation.
window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

// Qualquer arraste HTML5 (Explorer, abas, Git…) liga o estado de arraste do
// workbench: sem seleção acidental de texto no WebKitGTK e iframes blindados.
installNativeDragGuard();

// A window opened as a torn-off editor renders only that editor — never the full
// workbench (no session restore, no LSP manager, etc.).
const detachToken = readDetachToken();

// Configurações (User settings.json + workspace): carregadas ANTES do 1º render
// para o layout (lado da sidebar, zoom, fonte) já nascer certo — com teto, para
// um disco lento nunca segurar a janela (até lá valem os defaults).
const settingsReady = Promise.race([
  bootSettings(),
  new Promise<void>((resolve) => setTimeout(resolve, 1500)),
]);
installWorkbenchSettings();
// Subconjunto das settings → serviço de configuração do VS Code no Monaco
// (servidores de linguagem e modelos); as opções travadas do editor ficam fora.
installMonacoSettingsBridge(whenMonacoReady);
// keybindings.json do usuário (formato VS Code, com `when`).
installKeybindings();
// Validação + completion dos settings.json/keybindings.json no editor.
void whenMonacoReady.then(installSettingsJsonSupport).catch(() => {});
installExtHostSettingsBridge();

void settingsReady.then(() => {
  // A preferência de acrílico vem das settings.
  applyAcrylicFlyouts();
  installThemeSettings();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {detachToken ? <DetachedEditor token={detachToken} /> : <App />}
    </React.StrictMode>
  );
  if (!detachToken) {
    void revealPaintedWindow().catch((error) => {
      console.error("Falha ao exibir a janela inicializada:", error);
      const current = getCurrentWindow();
      void current.show().then(() => current.setFocus()).catch((fallbackError) => {
        console.error("Falha no fallback de exibição da janela:", fallbackError);
      });
    });
  }
});

async function revealPaintedWindow() {
  // One frame lets React commit the shell while keeping warm-window startup
  // effectively immediate. Fonts are cached by the shared WebView process.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await invoke("window_ready");
}

