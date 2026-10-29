/**
 * "Open With…" selector (ISSUE-70).
 *
 * A small flyout — the shared {@link Menu} primitive — that lists the modes
 * applicable to a file and opens the chosen one. It's data-driven: it renders
 * whatever {@link applicableModes} returns for the path, marking the default
 * mode, so new modes need no UI work.
 *
 * Self-contained on purpose: the explorer context menu (épico A) only needs to
 * mount this with the click position and the target path; everything else lives
 * here. Closing: outside press, Escape, or choosing a mode.
 */
import type { OpenMode } from "../types";
import { Menu } from "../components/ui/Menu";
import { applicableModes, defaultModeFor } from "./openWith";

interface OpenWithPickerProps {
  /** Absolute path of the file to open. */
  path: string;
  /** Viewport coordinates to anchor the menu at (the right-click point). */
  x: number;
  y: number;
  /** Open `path` in the chosen mode. */
  onPick: (mode: OpenMode) => void;
  /** Dismiss without choosing (outside click / Escape). */
  onClose: () => void;
}

export function OpenWithPicker({ path, x, y, onPick, onClose }: OpenWithPickerProps) {
  const modes = applicableModes(path);
  const defaultMode = defaultModeFor(path);

  return (
    <Menu
      ariaLabel="Abrir com"
      className="open-with-menu"
      anchor={{ x, y }}
      header={<span className="ui-menu-overline">Abrir com…</span>}
      onClose={() => onClose()}
      items={modes.map((m) => ({
        id: m.mode,
        label: m.label,
        icon: m.icon,
        badge: m.mode === defaultMode ? "padrão" : undefined,
        onSelect: () => onPick(m.mode),
      }))}
    />
  );
}
