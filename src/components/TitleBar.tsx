import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface TitleBarProps {
  /** Text shown centred in the bar (e.g. active file name). */
  title: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

/**
 * Custom Windows 11-style title bar. The bar itself is the OS drag region;
 * the right side hosts minimize / maximize / close caption buttons that
 * drive the native window through the Tauri window API.
 */
export function TitleBar({ title, sidebarOpen, onToggleSidebar }: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

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
    <div className="titlebar" data-tauri-drag-region>
      {/* data-tauri-drag-region marks the empty areas as draggable; the
          interactive children below opt out via their own handlers. */}
      <button
        className="titlebar-icon-btn"
        onClick={onToggleSidebar}
        title={sidebarOpen ? "Ocultar explorador" : "Mostrar explorador"}
      >
        <SidebarIcon />
      </button>

      <span className="titlebar-title" data-tauri-drag-region>
        {title}
      </span>

      <div className="window-controls">
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
          className="caption-btn"
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
  );
}

/** Small "panel" glyph for the sidebar toggle, Fluent-style. */
function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" fill="none" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" />
    </svg>
  );
}
