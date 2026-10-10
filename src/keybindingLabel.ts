/**
 * Rótulo legível de um atalho para a Paleta de Comandos: aceita o formato das
 * extensões VS Code (`ctrl+shift+escape`, acordes separados por espaço) e os
 * aceleradores dos menus do app (`Ctrl+K Ctrl+O`), e devolve sempre
 * "Ctrl+Shift+Esc" / "Ctrl+K Ctrl+O" (no macOS, Cmd vira ⌘ etc.).
 */

const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  meta: "Meta",
  cmd: "Cmd",
  win: "Win",
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  space: "Espaço",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  backquote: "`",
};

const MAC_NAMES: Record<string, string> = { Ctrl: "⌃", Shift: "⇧", Alt: "⌥", Cmd: "⌘", Meta: "⌘" };

function keyName(k: string): string {
  const low = k.toLowerCase();
  if (KEY_NAMES[low]) return KEY_NAMES[low];
  if (/^f\d{1,2}$/.test(low)) return low.toUpperCase();
  return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
}

export function formatKeybinding(raw: string | undefined | null, mac = false): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const chords = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (chords.length === 0) return undefined;
  const out = chords.map((chord) => {
    // "ctrl++" → a tecla é "+".
    const parts = chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+");
    const names = parts.filter(Boolean).map(keyName);
    return mac ? names.map((n) => MAC_NAMES[n] ?? n).join("") : names.join("+");
  });
  return out.join(" ");
}

/** Primeiro atalho contribuído para um comando (sem `when` impossível). */
export function keybindingFor(command: string, list: { command: string; key: string; when?: string }[] | undefined): string | undefined {
  const kb = list?.find((k) => k.command === command && !/^\s*false\s*$/.test(k.when ?? ""));
  return kb ? formatKeybinding(kb.key) : undefined;
}
