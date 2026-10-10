/**
 * Diffs abertos por extensões (`vscode.diff` — ex.: edição proposta pelo Claude
 * Code) na MESMA revisão do Monaco da ponte IDE (`ClaudeDiffReview`), em vez de
 * um modal somente leitura. Aceitar/Rejeitar chamam `diffAction` no host, que
 * executa os comandos da PRÓPRIA extensão (menu `editor/title` com `when`
 * válido) — o mesmo que os botões do VS Code fazem. A revisão some quando a
 * extensão fecha a aba do diff (`closeDiff`).
 */
import type { ExtensionDiffEvent } from "./protocol";

export interface ExtPendingDiff {
  /** Mesmo formato do PendingDiff da ponte IDE (ClaudeDiffReview). */
  id: string;
  tabName: string;
  oldPath: string;
  newPath: string;
  original: string;
  proposed: string;
  isNewFile: boolean;
  error?: string;
  /** Extensão dona (rótulo na revisão). */
  sourceLabel: string;
  extensionId?: string;
  readonly?: boolean;
  /** Uri do lado direito no host (threads de comentário/decorações dele). */
  rightUri: string;
}

let diffs: ExtPendingDiff[] = [];
const listeners = new Set<() => void>();

function set(next: ExtPendingDiff[]) {
  diffs = next;
  listeners.forEach((l) => l());
}

export function diffFromEvent(e: ExtensionDiffEvent): ExtPendingDiff {
  return {
    id: e.diffId,
    tabName: e.title,
    oldPath: e.left.path ?? e.filePath,
    newPath: e.filePath,
    original: e.left.content,
    proposed: e.right.content,
    isNewFile: e.isNewFile,
    sourceLabel: e.extensionName ?? "extensão",
    extensionId: e.extensionId,
    readonly: e.right.readonly,
    rightUri: e.right.uri,
  };
}

export function addExtDiff(e: ExtensionDiffEvent): void {
  const d = diffFromEvent(e);
  set([...diffs.filter((x) => x.id !== d.id), d]);
}

export function removeExtDiff(id: string): void {
  if (diffs.some((d) => d.id === id)) set(diffs.filter((d) => d.id !== id));
}

export function setExtDiffError(id: string, error: string | undefined): void {
  set(diffs.map((d) => (d.id === id ? { ...d, error } : d)));
}

export function clearExtDiffs(): void {
  if (diffs.length) set([]);
}

export function extDiffsSnapshot(): ExtPendingDiff[] {
  return diffs;
}

export function subscribeExtDiffs(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
