import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MenuBar } from "./MenuBar";
import { useSnapLayout } from "../snap/useSnapLayout";
import type { MenuDef } from "../types";
import logoUrl from "../assets/fluent-coder.png";

interface TitleBarProps {
  /** Text shown centred in the bar (e.g. active file name). */
  title: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Bottom panel (terminal/problems) open state + toggle. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Menu definitions (File, Edit, …) rendered in the left-hand MenuBar. */
  menus: MenuDef[];
}

/**
 * Custom Windows 11-style title bar. The bar itself is the OS drag region;
 * the right side hosts the VS Code-style layout toggles (side bar / panel),
 * a "pin on top" (always-on-top) toggle, and the minimize / maximize / close
 * caption buttons that drive the native window through the Tauri window API.
 */
export function TitleBar({
  title,
  sidebarOpen,
  onToggleSidebar,
  panelOpen,
  onTogglePanel,
  menus,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  // The Snap Layouts overlay covers the maximize button, so the webview can't
  // `:hover` it — the backend relays the OS hover instead.
  const [maxHover, setMaxHover] = useState(false);
  const maxBtnRef = useRef<HTMLButtonElement>(null);
  useSnapLayout(maxBtnRef, setMaxHover);

  // Keep the maximize/restore glyph in sync with the real window state.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized);
    appWindow
      .onResized(async () => setMaximized(await appWindow.isMaximized()))
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [appWindow]);

  return (
    <div className="titlebar">
      {/* Three grid zones (1fr auto 1fr): the menu lives in the LEFT zone and
          collapses there, the title sits centred in its own zone, and the
          controls are on the RIGHT — so the title can never overlap the menus. */}
      {/* Every zone + button group is a drag region (Tauri v2 checks the EXACT
          mousedown target, so the buttons/menus inside still click). This makes
          the WHOLE bar draggable, not just the bits with explicit regions. */}
      <div className="titlebar-left" data-tauri-drag-region>
        {/* App brand mark (like VS Code's top-left logo). Doubles as a drag
            region; it is not a control — the side-bar toggle lives on the right. */}
        <img
          className="titlebar-logo"
          src={logoUrl}
          alt="Fluent Coder"
          draggable={false}
          data-tauri-drag-region
        />
        <MenuBar menus={menus} />
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        <span className="titlebar-title">{title}</span>
      </div>

      <div className="titlebar-right" data-tauri-drag-region>
      {/* VS Code-style layout controls, just left of the window buttons. */}
      <div className="titlebar-layout" data-tauri-drag-region>
        <button
          className={`titlebar-layout-btn${sidebarOpen ? " active" : ""}`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"}
          aria-label="Alternar barra lateral"
          aria-pressed={sidebarOpen}
        >
          <SidebarIcon open={sidebarOpen} />
        </button>
        <button
          className={`titlebar-layout-btn${panelOpen ? " active" : ""}`}
          onClick={onTogglePanel}
          title={panelOpen ? "Ocultar painel inferior" : "Mostrar painel inferior"}
          aria-label="Alternar painel inferior"
          aria-pressed={panelOpen}
        >
          <PanelIcon open={panelOpen} />
        </button>
      </div>

      <div className="window-controls" data-tauri-drag-region>
        <button
          className="caption-btn"
          onClick={() => appWindow.minimize()}
          title="Minimizar"
          aria-label="Minimizar"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          ref={maxBtnRef}
          className={`caption-btn${maxHover ? " nc-hover" : ""}`}
          onClick={() => appWindow.toggleMaximize()}
          title={maximized ? "Restaurar" : "Maximizar"}
          aria-label={maximized ? "Restaurar" : "Maximizar"}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="2.5" width="6" height="6" stroke="currentColor" fill="none" />
              <path d="M2.5 2.5 V0.5 H8.5 V6.5 H6.5" stroke="currentColor" fill="none" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" />
            </svg>
          )}
        </button>

        <button
          className="caption-btn caption-close"
          onClick={() => appWindow.close()}
          title="Fechar"
          aria-label="Fechar"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
      </div>
    </div>
  );
}

/** "Side bar" glyph; the left column fills when the side bar is visible. */
function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      {open && <rect x="2" y="3" width="4" height="10" fill="currentColor" opacity="0.45" />}
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" fill="none" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
    </svg>
  );
}

/** "Bottom panel" glyph; the lower strip fills when the panel is visible. */
function PanelIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      {open && <rect x="2" y="10" width="12" height="3" fill="currentColor" opacity="0.45" />}
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" fill="none" />
      <line x1="1.5" y1="10" x2="14.5" y2="10" stroke="currentColor" />
    </svg>
  );
}
