/**
 * Camada de plataforma do front (par de `src-tauri/src/platform/`).
 *
 * - `os.ts`: SO + capacidades, detectados uma vez;
 * - `labels.ts`: rótulos por SO ("Revelar no Finder"…);
 * - `keybinding.ts`: atalhos (Ctrl+P / ⌘P);
 * - `fonts.ts`: pilhas de fonte por SO;
 * - `commands.ts`: revelar / abrir externo via Rust (importe direto de lá).
 */

export * from "./os.ts";
export * from "./labels.ts";
export * from "./keybinding.ts";
export * from "./fonts.ts";
