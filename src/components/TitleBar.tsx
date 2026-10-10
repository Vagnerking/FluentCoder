import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MenuBar } from "./MenuBar";
import { Tooltip } from "./Tooltip";
import { IconButton } from "./ui/IconButton";
import { Codicon } from "../icons/codicons/Codicon";
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
  /** Secondary side bar (Fluent Chat) open state + toggle. */
  agentsOpen: boolean;
  onToggleAgents: () => void;
  /** Menu definitions (File, Edit, …) rendered in the left-hand MenuBar. */
  menus: MenuDef[];
  /**
   * Command center: the centred search pill opens Quick Open (Ctrl+P). When
   * omitted the bar falls back to a plain, centred title label.
   */
  onOpenQuickOpen?: () => void;
  /** Command center's palette button (Ctrl+Shift+P). */
  onOpenCommandPalette?: () => void;
}

/**
 * Custom Windows 11-style title bar. The bar itself is the OS drag region;
 * the centre hosts the command center (search pill → Quick Open, palette
 * button → Command Palette), the right side the VS Code-style layout toggles
 * and the minimize / maximize / close caption buttons that drive the native
 * window through the Tauri window API.
 */
export function TitleBar({
  title,
  sidebarOpen,
  onToggleSidebar,
  panelOpen,
  onTogglePanel,
  agentsOpen,
  onToggleAgents,
  menus,
  onOpenQuickOpen,
  onOpenCommandPalette,
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

  // A maximized window has square corners (like Windows 11): the CSS frame
  // drops its radius/border while this class is set.
  useEffect(() => {
    document.documentElement.classList.toggle("window-maximized", maximized);
  }, [maximized]);

  return (
    <div className="titlebar">
      {/* Three grid zones (1fr auto 1fr): the menu lives in the LEFT zone and
          collapses there, the command center sits centred in its own zone, and
          the controls are on the RIGHT — so the centre never overlaps the menus. */}
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
        {onOpenQuickOpen ? (
          // Command center (VS Code-style): a search pill that opens Quick Open
          // plus a palette button for the Command Palette. The window title
          // rides inside the pill so the "where am I" context stays visible.
          <div className="command-center" role="group" aria-label="Central de comandos">
            <button
              type="button"
              className="command-center-search"
              onClick={onOpenQuickOpen}
              aria-label={`Pesquisar arquivos (Ctrl+P). ${title}`}
            >
              <Codicon name="search" className="command-center-icon" />
              <span className="command-center-label">{title}</span>
              <kbd className="command-center-kbd" aria-hidden="true">
                Ctrl+P
              </kbd>
            </button>
            {onOpenCommandPalette && (
              <IconButton
                icon="commandPalette"
                size="sm"
                className="command-center-palette"
                label="Paleta de comandos (Ctrl+Shift+P)"
                tooltipPlacement="bottom"
                onClick={onOpenCommandPalette}
              />
            )}
          </div>
        ) : (
          <span className="titlebar-title">{title}</span>
        )}
      </div>

      <div className="titlebar-right" data-tauri-drag-region>
        {/* VS Code-style layout controls, just left of the window buttons. The
            glyph itself shows the on/off state (filled vs. outlined pane). */}
        <div className="titlebar-layout" data-tauri-drag-region>
          <IconButton
            icon="fluentChat"
            size="sm"
            className="titlebar-layout-btn"
            label={agentsOpen ? "Ocultar Fluent Chat" : "Mostrar Fluent Chat"}
            tooltipPlacement="bottom"
            pressed={agentsOpen}
            onClick={onToggleAgents}
          />
          <IconButton
            icon={sidebarOpen ? "layoutSidebarLeft" : "layoutSidebarLeftOff"}
            size="sm"
            className="titlebar-layout-btn"
            label={
              sidebarOpen
                ? "Ocultar barra lateral (Ctrl+B)"
                : "Mostrar barra lateral (Ctrl+B)"
            }
            tooltipPlacement="bottom"
            pressed={sidebarOpen}
            onClick={onToggleSidebar}
          />
          <IconButton
            icon={panelOpen ? "layoutPanel" : "layoutPanelOff"}
            size="sm"
            className="titlebar-layout-btn"
            label={panelOpen ? "Ocultar painel inferior" : "Mostrar painel inferior"}
            tooltipPlacement="bottom"
            pressed={panelOpen}
            onClick={onTogglePanel}
          />
        </div>

        <div className="window-controls" data-tauri-drag-region>
          <Tooltip label="Minimizar" placement="bottom">
            <button
              className="caption-btn"
              onClick={() => appWindow.minimize()}
              aria-label="Minimizar"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
              </svg>
            </button>
          </Tooltip>

          <Tooltip label={maximized ? "Restaurar" : "Maximizar"} placement="bottom">
            <button
              ref={maxBtnRef}
              className={`caption-btn${maxHover ? " nc-hover" : ""}`}
              onClick={() => appWindow.toggleMaximize()}
              aria-label={maximized ? "Restaurar" : "Maximizar"}
            >
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="2.5" width="6" height="6" rx="1" stroke="currentColor" fill="none" />
                  <path d="M2.5 2.5 V1.5 Q2.5 0.5 3.5 0.5 H8.5 Q9.5 0.5 9.5 1.5 V6.5 Q9.5 7.5 8.5 7.5 H6.5" stroke="currentColor" fill="none" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" stroke="currentColor" fill="none" />
                </svg>
              )}
            </button>
          </Tooltip>

          <Tooltip label="Fechar" placement="bottom">
            <button
              className="caption-btn caption-close"
              onClick={() => appWindow.close()}
              aria-label="Fechar"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"
                  stroke="currentColor"
                  strokeWidth="1"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
