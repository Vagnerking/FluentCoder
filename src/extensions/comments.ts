/**
 * Threads de comentário das extensões (`vscode.comments`) — store sem React,
 * alimentado pelos eventos `commentThread` / `commentThreadDisposed` do host.
 * Os widgets do Monaco (`commentWidgets.tsx`) assinam e desenham os threads do
 * documento do editor (arquivo `file://` ou o lado direito de um diff virtual).
 *
 * Uso real: a barra Aceitar/Rejeitar por hunk do Claude Code no diff proposto
 * pelo chat (controller `claude-code-hunks`).
 */
import type { PlainRange } from "./protocol";

export interface CommentAction {
  command: string;
  title: string;
  /** Codicon (`$(check)` → `check`), quando a extensão declara. */
  icon?: string;
  group?: string;
}

export interface CommentInfo {
  index: number;
  body: string;
  author: string;
  label?: string;
  contextValue?: string;
  mode?: number;
  timestamp?: string;
  reactions: { label: string; count: number; authorHasReacted: boolean }[];
  actions: CommentAction[];
  contextActions: CommentAction[];
}

export interface CommentThreadInfo {
  handle: string;
  extensionId: string;
  controllerId: string;
  controllerLabel?: string;
  /** Uri do documento no host (`file:///…` ou `_claude_vscode_fs_right:/…`). */
  uri: string;
  /** Caminho do arquivo quando `file://`. */
  path?: string;
  /** `null` = comentário do arquivo inteiro (mostrado no topo). */
  range: PlainRange | null;
  label?: string;
  contextValue?: string;
  /** 0 = recolhido, 1 = expandido. */
  collapsibleState: number;
  canReply: boolean;
  state?: number;
  comments: CommentInfo[];
  /** Menu `comments/commentThread/title` (botões do cabeçalho). */
  actions: CommentAction[];
  /** Menu `comments/commentThread/context` (botões da resposta). */
  replyActions: CommentAction[];
  canReact: boolean;
}

const threads = new Map<string, CommentThreadInfo>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  listeners.forEach((l) => l());
}

export function upsertCommentThread(t: CommentThreadInfo): void {
  threads.set(t.handle, t);
  changed();
}

export function removeCommentThread(handle: string): void {
  if (threads.delete(handle)) changed();
}

export function clearCommentThreads(): void {
  if (threads.size) {
    threads.clear();
    changed();
  }
}

export function commentThreads(): CommentThreadInfo[] {
  return [...threads.values()];
}

export function commentThreadsVersion(): number {
  return version;
}

export function subscribeCommentThreads(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Linha (1-based, Monaco) depois da qual o widget do thread aparece. */
export function threadAnchorLine(t: Pick<CommentThreadInfo, "range">): number {
  // Como no VS Code: o widget fica ABAIXO da última linha da faixa; sem faixa
  // (comentário do arquivo) fica no topo.
  if (!t.range) return 0;
  return t.range.end.line + 1;
}

/** Ações em linha (grupo `inline*`) primeiro, na ordem do `@n`. */
export function sortActions(actions: CommentAction[]): CommentAction[] {
  const order = (a: CommentAction) => {
    const m = /^(.*?)(?:@(\d+))?$/.exec(a.group ?? "");
    const inline = m && m[1].startsWith("inline") ? 0 : 1;
    return inline * 1000 + (m && m[2] ? Number(m[2]) : 500);
  };
  return [...actions].sort((a, b) => order(a) - order(b));
}

/** Rótulo visível do thread (o Claude usa um espaço: a barra fica só com os botões). */
export function threadTitle(t: Pick<CommentThreadInfo, "label">): string {
  return (t.label ?? "").trim();
}

/** Só para testes. */
export function __resetComments(): void {
  threads.clear();
  listeners.clear();
  version = 0;
}
