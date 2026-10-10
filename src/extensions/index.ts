/**
 * API pública do módulo de extensões VS Code hospedadas — o que outras partes
 * do app (ex.: a sidebar "Fluent Chat") podem usar sem depender dos internos.
 * Contratos em docs/context/extensoes-vscode.md.
 *
 * Componentes:
 * - `ExtensionDock` — abas "Agentes" + UI real das extensões (props estáveis:
 *   `rootPath`, `agentsNode`; `onOpenFile`/`readEditorState` estão obsoletas).
 * - `ExtensionWebview` — um webview de extensão já resolvido (`WebviewInfo`)
 *   num <iframe> com o relay seguro; use para montar a UI em outro layout.
 * - `ExtensionHostRuntime` — montado UMA vez no App (já está): editor, diffs,
 *   terminais, diálogos, saída, barra de status e deep links.
 * - `ExtensionStatusItems` — itens de barra de status das extensões.
 *
 * Funções (singleton `extHost` por janela):
 * - `listHostedExtensions()` — extensões suportadas instaladas (sobe o host se preciso).
 * - `openExtensionView(id)` — ativa a extensão e resolve a webview view
 *   preferida → `WebviewInfo` para o `<ExtensionWebview>`.
 * - `prewarmExtension(id)` — ativa em segundo plano (ex.: hover na aba).
 * - `restartExtensionHost()` — "Reiniciar Host de Extensões".
 * - `onExtensionHostEvent(listener)` — eventos crus do host (ver protocol.ts).
 * - `extensionPaletteCommands()` — comandos contribuídos para a Paleta.
 */
import { useEffect, useState } from "react";
import { extHost } from "./client";
import { removeWebviewPanel } from "./webviewTabs";
import { keybindingFor } from "../keybindingLabel";
import type { HostEvent, InstalledExtension, WebviewInfo } from "./protocol";

export { ExtensionDock } from "./ExtensionDock";
export { ExtensionWebview } from "./ExtensionWebview";
export { ExtensionHostRuntime, type ExtensionHostRuntimeProps } from "./ExtensionHostRuntime";
export { ExtensionStatusItems } from "./ExtensionStatusItems";
export { useExtensionDiffs } from "./useExtensionDiffs";
export { bindExtDiffEditor } from "./diffBinding";
export { ExtensionWebviewTab } from "./ExtensionWebviewTab";
export { isWebviewTabPath, handleOfWebviewTab, webviewTabPath, targetForViewColumn } from "./webviewTabs";

/**
 * A aba de um painel de webview sumiu da grade (fechada em todos os grupos):
 * descarta o painel no host (`WebviewPanel.onDidDispose` da extensão).
 */
export function disposeWebviewTab(handle: string): void {
  if (!removeWebviewPanel(handle)) return; // a extensão já descartou
  void extHost.notify("disposeWebview", { handle });
}
export { OUTPUT_CHANNEL as EXTENSIONS_OUTPUT_CHANNEL } from "./client";
export type { HostEvent, InstalledExtension, WebviewInfo } from "./protocol";

export async function listHostedExtensions(rootPath: string | null): Promise<InstalledExtension[]> {
  const r = await extHost.ensureStarted(rootPath);
  return r.extensions.filter((e) => e.supported);
}

export async function openExtensionView(id: string, rootPath: string | null = null): Promise<WebviewInfo> {
  const r = await extHost.ensureStarted(rootPath);
  const ext = r.extensions.find((e) => e.id === id);
  if (!ext) throw new Error(`Extensão não instalada: ${id}`);
  const loaded = await extHost.loadExtension(id);
  const viewId = ext.viewIds.find((v) => loaded.views.some((x) => x.id === v)) ?? loaded.views[0]?.id;
  if (!viewId) throw new Error("A extensão não contribui nenhuma view de webview.");
  return extHost.resolveView(viewId);
}

export function prewarmExtension(id: string): void {
  extHost.prewarm(id);
}

export function restartExtensionHost(): Promise<void> {
  return extHost.restart();
}

export function onExtensionHostEvent(listener: (e: HostEvent) => void): () => void {
  return extHost.on(listener);
}

export interface ExtensionPaletteCommand {
  id: string;
  title: string;
  detail: string;
  keybinding?: string;
  run: () => void;
}

/**
 * Comandos contribuídos (`contributes.commands`, sem os escondidos por
 * `commandPalette: false`) das extensões suportadas instaladas. Executar
 * ativa a extensão se preciso (onCommand), como no VS Code.
 */
export function extensionPaletteCommands(installed: InstalledExtension[], onError: (message: string) => void): ExtensionPaletteCommand[] {
  return installed.flatMap((ext) =>
    (ext.commands ?? [])
      .filter((c) => !c.paletteWhen || !/^false$/.test(c.paletteWhen.trim()))
      .map((c) => ({
        id: `ext:${c.command}`,
        title: c.category ? `${c.category}: ${c.title}` : c.title,
        detail: ext.label,
        // Atalho contribuído pela extensão (package.json → keybindings).
        keybinding: keybindingFor(c.command, ext.keybindings),
        run: () => {
          void (async () => {
            await extHost.loadExtension(ext.id);
            await extHost.call("executeCommand", { command: c.command, args: [] });
          })().catch((err) => onError(err instanceof Error ? err.message : String(err)));
        },
      })),
  );
}

/** Extensões suportadas instaladas, conforme o host as listou (vazio até subir). */
export function useHostedExtensions(): InstalledExtension[] {
  const read = () => (extHost.info?.extensions ?? []).filter((e) => e.supported);
  const [list, setList] = useState<InstalledExtension[]>(read);
  useEffect(() => {
    setList(read());
    return extHost.on((e) => {
      if (e.event === "hostReady" || e.event === "hostExit") setList(read());
    });
  }, []);
  return list;
}
