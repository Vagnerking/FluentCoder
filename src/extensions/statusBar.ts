/**
 * Itens de barra de status das extensões (`window.createStatusBarItem`,
 * `setStatusBarMessage`, `withProgress`) — store sem React, alimentado pelo
 * runtime com os eventos do host e lido pela barra de status do app.
 */
import type { StatusBarItemEvent } from "./protocol";

export interface ExtStatusItem {
  id: string;
  extensionId: string;
  alignment: "left" | "right";
  priority: number;
  text: string;
  tooltip?: string;
  command?: { command: string; title?: string; arguments?: unknown[] };
  color?: string;
  progress?: boolean;
  /** `withProgress` cancelável (Window/SCM): clicar cancela este progresso. */
  cancelProgress?: string;
}

const items = new Map<string, ExtStatusItem>();
const listeners = new Set<() => void>();
let version = 0;
let snapshot: ExtStatusItem[] = [];

function changed() {
  version++;
  // Maior prioridade primeiro (mais à esquerda no lado esquerdo, como no VS Code).
  snapshot = [...items.values()].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  listeners.forEach((l) => l());
}

export function applyStatusBarItem(e: StatusBarItemEvent, resolveColor: (c: StatusBarItemEvent["color"]) => string | undefined): void {
  if (!e.visible || !e.text) {
    if (items.delete(e.id)) changed();
    return;
  }
  items.set(e.id, {
    id: e.id,
    extensionId: e.extensionId,
    alignment: e.alignment,
    priority: e.priority,
    text: e.text,
    tooltip: e.tooltip,
    command: e.command,
    color: resolveColor(e.color),
  });
  changed();
}

export function applyStatusMessage(e: { id: string; extensionId: string; text: string | null; progress?: boolean }): void {
  if (!e.text) {
    if (items.delete(e.id)) changed();
    return;
  }
  items.set(e.id, { id: e.id, extensionId: e.extensionId, alignment: "left", priority: -1000, text: e.progress ? `$(sync~spin) ${e.text}` : e.text, progress: e.progress });
  changed();
}

/** `withProgress` em Window/SourceControl: spinner na barra; cancelável = clicável. */
export function applyProgressItem(p: { id: string; extensionId: string; label: string; cancellable: boolean } | { id: string; end: true }): void {
  const id = `progress:${p.id}`;
  if ("end" in p) {
    if (items.delete(id)) changed();
    return;
  }
  items.set(id, {
    id,
    extensionId: p.extensionId,
    alignment: "left",
    priority: -1000,
    text: `$(sync~spin) ${p.label}`,
    tooltip: p.cancellable ? `${p.label} — clique para cancelar` : p.label,
    progress: true,
    cancelProgress: p.cancellable ? p.id : undefined,
  });
  changed();
}

export function clearStatusItems(): void {
  if (items.size) {
    items.clear();
    changed();
  }
}

export function subscribeStatusItems(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function statusItemsSnapshot(): ExtStatusItem[] {
  return snapshot;
}

export function statusItemsVersion(): number {
  return version;
}

/** "$(sync~spin) Texto $(check)" → partes texto/ícone. */
export function parseStatusText(text: string): ({ kind: "text"; value: string } | { kind: "icon"; name: string; spin: boolean })[] {
  const out: ({ kind: "text"; value: string } | { kind: "icon"; name: string; spin: boolean })[] = [];
  const re = /\$\(([a-z0-9-]+)(~spin)?\)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
    out.push({ kind: "icon", name: m[1].toLowerCase(), spin: !!m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}
