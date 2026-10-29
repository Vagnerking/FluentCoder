import type { ContextMenuItem } from "../types";
import { Menu, type MenuItemSpec } from "./ui/Menu";

interface TreeContextMenuProps {
  /** Viewport coordinates where the menu should anchor (the click point). */
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Called when the menu should close (item run, Esc, outside click). */
  onClose: () => void;
}

/** Maps the explorer/Git item model onto the shared menu primitive. */
function toMenuItems(items: readonly ContextMenuItem[]): MenuItemSpec[] {
  return items.map((it) => ({
    id: it.id,
    label: it.label,
    icon: it.icon,
    shortcut: it.accelerator,
    title: it.title,
    separator: it.separator,
    disabled: it.enabled === false,
    submenu: it.submenu?.length ? toMenuItems(it.submenu) : undefined,
    onSelect: it.run,
  }));
}

/**
 * Context menu of the file explorer and the Git panel — a thin adapter over
 * the shared {@link Menu} primitive (keyboard nav, submenus, flip at the
 * viewport edges, focus restore). It knows nothing about concrete actions: it
 * renders `items` and calls each `run` on activation.
 */
export function TreeContextMenu({ x, y, items, onClose }: TreeContextMenuProps) {
  return (
    <Menu
      ariaLabel="Ações do item"
      anchor={{ x, y }}
      items={toMenuItems(items)}
      onClose={() => onClose()}
      minWidth={220}
    />
  );
}
