/**
 * Avisos do Git (canto inferior direito) no lugar de `alert()`: não bloqueiam
 * a janela, seguem o design Fluent e somem sozinhos (erros ficam mais tempo).
 */

export type GitToastSeverity = "error" | "warning" | "info";

export interface GitToast {
  id: number;
  severity: GitToastSeverity;
  title: string;
  detail?: string;
}

let toasts: GitToast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const MAX_TOASTS = 4;
const DURATION: Record<GitToastSeverity, number> = { error: 12_000, warning: 8_000, info: 4_000 };

function emit() {
  listeners.forEach((listener) => listener());
}

/** Mostra um aviso. Erros do git costumam ter várias linhas: o título é a 1ª. */
export function showGitToast(severity: GitToastSeverity, title: string, detail?: unknown): number {
  const id = nextId++;
  const text = detail == null ? undefined : String(detail).trim() || undefined;
  toasts = [...toasts, { id, severity, title, detail: text }].slice(-MAX_TOASTS);
  timers.set(
    id,
    setTimeout(() => dismissGitToast(id), DURATION[severity])
  );
  emit();
  return id;
}

export function dismissGitToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function getGitToasts(): GitToast[] {
  return toasts;
}

export function subscribeGitToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
