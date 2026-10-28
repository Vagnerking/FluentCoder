/**
 * Ponte com os comandos Rust de `src-tauri/src/platform/commands.rs`.
 * Separado dos módulos puros para que eles rodem nos testes sem o Tauri.
 */

import { invoke } from "@tauri-apps/api/core";

/** Abre o gerenciador de arquivos do SO com `path` selecionado. */
export function revealInFileManager(path: string, workspaceRoot?: string): Promise<void> {
  return invoke("platform_reveal_path", { workspaceRoot: workspaceRoot ?? null, path });
}

/**
 * Abre uma URL (http/https/mailto) no navegador do sistema. `window.open`
 * não serve: no WebKitGTK/WKWebView do Tauri ele não chega ao navegador do SO.
 */
export function openExternal(url: string): Promise<void> {
  return invoke("platform_open_external", { url });
}

/** Abre um arquivo/pasta local no app padrão do sistema. */
export function openPath(path: string, workspaceRoot?: string): Promise<void> {
  return invoke("platform_open_path", { workspaceRoot: workspaceRoot ?? null, path });
}
