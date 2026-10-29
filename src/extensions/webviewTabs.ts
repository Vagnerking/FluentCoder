/**
 * Painéis de webview das extensões (`window.createWebviewPanel`, custom
 * editors) como ABAS reais da grade de editores — como no VS Code. As views de
 * sidebar continuam no dock do Fluent Chat.
 *
 * Cada painel vira um `OpenFile` com caminho sintético `extwebview:<handle>` e
 * `mode: "webview"` (nunca salvo nem restaurado na sessão). Este store guarda o
 * `WebviewInfo` de cada handle (URL, título) para o grupo renderizar o iframe.
 */
import type { WebviewInfo } from "./protocol";

export const WEBVIEW_TAB_PREFIX = "extwebview:";

export function webviewTabPath(handle: string): string {
  return `${WEBVIEW_TAB_PREFIX}${handle}`;
}

export function isWebviewTabPath(path: string | null | undefined): boolean {
  return !!path && path.startsWith(WEBVIEW_TAB_PREFIX);
}

export function handleOfWebviewTab(path: string): string | null {
  return isWebviewTabPath(path) ? path.slice(WEBVIEW_TAB_PREFIX.length) : null;
}

/** `ViewColumn` do VS Code → onde abrir: grupo N (1-based), "beside" ou o ativo. */
export function targetForViewColumn(viewColumn: number | undefined, groupCount: number, activeIndex: number): { kind: "active" } | { kind: "group"; index: number } | { kind: "beside" } {
  if (viewColumn === undefined || viewColumn === -1 || viewColumn === 0) return { kind: "active" };
  if (viewColumn === -2) return activeIndex + 1 < groupCount ? { kind: "group", index: activeIndex + 1 } : { kind: "beside" };
  if (viewColumn >= 1 && viewColumn <= groupCount) return { kind: "group", index: viewColumn - 1 };
  // Coluna além das existentes: abre ao lado (nova coluna), como o VS Code.
  return viewColumn > groupCount ? { kind: "beside" } : { kind: "active" };
}

const panels = new Map<string, WebviewInfo>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, WebviewInfo> = new Map();

function changed() {
  snapshot = new Map(panels);
  listeners.forEach((l) => l());
}

export function upsertWebviewPanel(info: WebviewInfo): void {
  panels.set(info.handle, { ...panels.get(info.handle), ...info });
  changed();
}

export function patchWebviewPanel(handle: string, patch: Partial<WebviewInfo>): void {
  const cur = panels.get(handle);
  if (!cur) return;
  panels.set(handle, { ...cur, ...patch });
  changed();
}

export function removeWebviewPanel(handle: string): boolean {
  const had = panels.delete(handle);
  if (had) changed();
  return had;
}

export function clearWebviewPanels(): string[] {
  const handles = [...panels.keys()];
  if (handles.length) {
    panels.clear();
    changed();
  }
  return handles;
}

export function hasWebviewPanel(handle: string): boolean {
  return panels.has(handle);
}

export function webviewPanelsSnapshot(): ReadonlyMap<string, WebviewInfo> {
  return snapshot;
}

export function subscribeWebviewPanels(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
