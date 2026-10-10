/**
 * `window.withProgress` das extensões — store sem React alimentado pelos
 * eventos `progress`/`progressEnd` do host:
 *
 * - `notification` → aviso no canto (ExtProgressToasts) com barra (percentual
 *   quando a extensão informa `increment`, indeterminada senão) e **Cancelar**
 *   quando `cancellable`;
 * - `window`/`scm` → item com spinner na barra de status (statusBar.ts),
 *   clicável para cancelar quando `cancellable`.
 *
 * Cancelar = `cancelProgress` → o CancellationToken da tarefa dispara no host.
 */

export interface ExtProgress {
  id: string;
  extensionId: string;
  extensionName: string;
  location: "notification" | "window" | "scm";
  title: string;
  message: string;
  /** 0–100 quando a extensão reporta `increment`. */
  percent?: number;
  cancellable: boolean;
  /** Cancelamento pedido (aguardando a extensão encerrar a tarefa). */
  cancelling?: boolean;
}

const items = new Map<string, ExtProgress>();
const listeners = new Set<() => void>();
let snapshot: ExtProgress[] = [];

function changed() {
  snapshot = [...items.values()];
  listeners.forEach((l) => l());
}

/** Normaliza o evento do host (dados vindos do processo Node). */
export function progressFromEvent(e: Record<string, unknown>): ExtProgress | null {
  if (typeof e.id !== "string" || !e.id) return null;
  const loc = e.location === "notification" || e.location === "scm" ? e.location : "window";
  const pct = typeof e.percent === "number" && Number.isFinite(e.percent) ? Math.max(0, Math.min(100, e.percent)) : undefined;
  return {
    id: e.id,
    extensionId: String(e.extensionId ?? ""),
    extensionName: String(e.extensionName ?? e.extensionId ?? ""),
    location: loc,
    title: String(e.title ?? ""),
    message: String(e.message ?? ""),
    percent: pct,
    cancellable: e.cancellable === true,
  };
}

export function upsertProgress(p: ExtProgress): void {
  const cur = items.get(p.id);
  items.set(p.id, { ...p, cancelling: cur?.cancelling });
  changed();
}

export function endProgress(id: string): void {
  if (items.delete(id)) changed();
}

export function markCancelling(id: string): void {
  const cur = items.get(id);
  if (!cur || cur.cancelling) return;
  items.set(id, { ...cur, cancelling: true });
  changed();
}

export function clearProgress(): void {
  if (items.size) {
    items.clear();
    changed();
  }
}

export function progressSnapshot(): ExtProgress[] {
  return snapshot;
}

export function subscribeProgress(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Texto do progresso: "Título: mensagem" (como o VS Code), sem duplicar. */
export function progressLabel(p: Pick<ExtProgress, "title" | "message" | "extensionName">): string {
  return [p.title, p.message].filter(Boolean).join(": ") || p.extensionName || "Trabalhando…";
}
