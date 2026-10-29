import type { OpenFile } from "../../types";
import { Menu, type MenuItemSpec } from "../ui/Menu";

export interface TabContextMenuProps {
  x: number;
  y: number;
  path: string;
  files: readonly OpenFile[];
  onDismiss: () => void;
  onClose: (path: string) => void | Promise<void>;
  onCloseOthers: (path: string) => void;
  onCloseLeft: (path: string) => void;
  onCloseRight: (path: string) => void;
  onCloseAll: () => void;
  onMoveToNewWindow?: (path: string) => void;
  /** Fixar/desafixar a aba (omitido = sem suporte, ex.: janela destacada). */
  onPin?: (path: string, pinned: boolean) => void;
  /** Tira do modo preview. */
  onKeepOpen?: (path: string) => void;
}

/** Menu de contexto de uma aba (fechar em lote, fixar, manter aberta, mover). */
export function TabContextMenu({
  x,
  y,
  path,
  files,
  onDismiss,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onCloseAll,
  onMoveToNewWindow,
  onPin,
  onKeepOpen,
}: TabContextMenuProps) {
  const index = files.findIndex((f) => f.path === path);
  const file = files[index];
  const items: MenuItemSpec[] = [
    { id: "close", label: "Fechar", icon: "close", shortcut: "Ctrl+W", onSelect: () => void onClose(path) },
    { id: "close-others", label: "Fechar outras", disabled: files.length <= 1, onSelect: () => onCloseOthers(path) },
    { id: "close-left", label: "Fechar à esquerda", disabled: index <= 0, onSelect: () => onCloseLeft(path) },
    { id: "close-right", label: "Fechar à direita", disabled: index >= files.length - 1, onSelect: () => onCloseRight(path) },
    { id: "sep-1", separator: true },
    { id: "close-all", label: "Fechar todas", icon: "closeAll", onSelect: () => onCloseAll() },
  ];
  if (onPin || (onKeepOpen && file?.preview)) {
    items.push({ id: "sep-pin", separator: true });
    if (onKeepOpen && file?.preview) {
      items.push({ id: "keep-open", label: "Manter aberta", onSelect: () => onKeepOpen(path) });
    }
    if (onPin) {
      items.push(
        file?.pinned
          ? { id: "unpin", label: "Desafixar", icon: "pin", onSelect: () => onPin(path, false) }
          : { id: "pin", label: "Fixar", icon: "pinned", onSelect: () => onPin(path, true) }
      );
    }
  }
  if (onMoveToNewWindow) {
    items.push(
      { id: "sep-2", separator: true },
      { id: "move-window", label: "Mover para Nova Janela", icon: "linkExternal", onSelect: () => onMoveToNewWindow(path) }
    );
  }
  return <Menu ariaLabel="Ações da aba" anchor={{ x, y }} onClose={onDismiss} items={items} />;
}
