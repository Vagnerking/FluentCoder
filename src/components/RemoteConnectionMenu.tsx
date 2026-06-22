import { useEffect, useRef, useState } from "react";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import { useModalDismiss } from "./useModalDismiss";

interface RemoteConnectionMenuProps {
  /** `user@host` of the active connection. */
  target: string;
  /** Re-open the folder browser on the same connection. */
  onOpenFolder: () => void;
  /** Open a new terminal on the host. */
  onNewTerminal: () => void;
  /** Re-establish the connection (e.g. after it dropped) and reopen the folder. */
  onReconnect: () => void;
  /** Disconnect and reset the window to the empty local state. */
  onDisconnect: () => void;
  onClose: () => void;
}

interface MenuAction {
  id: string;
  icon: IconAction;
  label: string;
  description: string;
  run: () => void;
  /** Danger styling for destructive actions (disconnect). */
  danger?: boolean;
}

/**
 * Connection-management menu (issue #8) — opens when the user clicks the active
 * SSH indicator in the status bar. Mirrors VS Code's remote menu: clicking the
 * indicator does NOT disconnect; it offers actions to manage the connection.
 * Keyboard-navigable (↑/↓ + Enter, Esc to close).
 */
export function RemoteConnectionMenu({
  target,
  onOpenFolder,
  onNewTerminal,
  onReconnect,
  onDisconnect,
  onClose,
}: RemoteConnectionMenuProps) {
  const actions: MenuAction[] = [
    {
      id: "open-folder",
      icon: "folderOpened",
      label: "Abrir outra pasta no host…",
      description: "Navegar e abrir outra pasta nesta conexão",
      run: onOpenFolder,
    },
    {
      id: "new-terminal",
      icon: "terminal",
      label: "Novo terminal remoto",
      description: "Abrir um shell na máquina remota",
      run: onNewTerminal,
    },
    {
      id: "reconnect",
      icon: "refresh",
      label: "Reconectar",
      description: "Refazer a conexão (ex.: se a rede caiu) e reabrir a pasta",
      run: onReconnect,
    },
    {
      id: "disconnect",
      icon: "debugDisconnect",
      label: "Desconectar do host remoto",
      description: "Fechar a conexão e voltar ao modo local",
      run: onDisconnect,
      danger: true,
    },
  ];

  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  function activate(index: number) {
    const action = actions[index];
    if (action) action.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (s + 1) % actions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (s - 1 + actions.length) % actions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div
        className="ssh-card ssh-menu"
        role="dialog"
        aria-label="Gerenciar conexão remota"
      >
        <header className="ssh-head">
          <span className="ssh-head-badge">
            <Codicon name="remote" />
          </span>
          <div className="ssh-head-text">
            <span className="ssh-head-title">Conexão remota</span>
            <span className="ssh-head-sub">{target}</span>
          </div>
        </header>

        <div
          className="ssh-menu-list"
          role="listbox"
          tabIndex={0}
          ref={listRef}
          aria-activedescendant={`ssh-menu-opt-${actions[selected]?.id}`}
          onKeyDown={onKeyDown}
        >
          {actions.map((action, i) => (
            <div
              key={action.id}
              id={`ssh-menu-opt-${action.id}`}
              role="option"
              aria-selected={i === selected}
              className={
                "ssh-menu-item" +
                (i === selected ? " selected" : "") +
                (action.danger ? " danger" : "")
              }
              onMouseMove={() => setSelected(i)}
              onClick={() => activate(i)}
            >
              <Codicon name={action.icon} className="ssh-menu-item-icon" />
              <div className="ssh-menu-item-text">
                <span className="ssh-menu-item-label">{action.label}</span>
                <span className="ssh-menu-item-desc">{action.description}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
