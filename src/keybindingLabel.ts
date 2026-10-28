/**
 * Compatibilidade: o formatador de atalhos mora em `src/platform/keybinding.ts`
 * (por SO: `Ctrl+P` no Windows/Linux, `⌘P` no macOS).
 */
export { formatKeybinding, formatShortcutsInText, keybindingFor } from "./platform/keybinding.ts";
