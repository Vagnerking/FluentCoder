import { QuickPick, type QuickPickItem } from "./QuickPick";
import type { IconAction } from "../icons/codicons/codicon-map";

/** A runnable command surfaced in the palette. */
export interface PaletteCommand {
  id: string;
  /** Category prefix shown before the label (e.g. "Arquivo"). */
  category?: string;
  label: string;
  icon?: IconAction;
  run: () => void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

/**
 * VS Code-style command palette (Ctrl+Shift+P). Lists the app's runnable
 * commands (menu actions + SSH) and runs the chosen one. A thin wrapper over
 * {@link QuickPick} so it shares the one quick-pick UI/UX.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const items: QuickPickItem[] = commands.map((c) => ({
    id: c.id,
    label: c.category ? `${c.category}: ${c.label}` : c.label,
    icon: c.icon ?? "commandPalette",
    keywords: c.category,
  }));

  return (
    <QuickPick
      placeholder="Digite o nome de um comando…"
      items={items}
      onPick={(it) => {
        onClose();
        commands.find((c) => c.id === it.id)?.run();
      }}
      onClose={onClose}
    />
  );
}
