/**
 * Pseudoterminais das extensões (`createTerminal({ pty })` e tarefas
 * `CustomExecution`): a aba do TerminalPanel não tem PTY — o xterm é dirigido
 * pelo pty da extensão no host.
 *
 * host → app: `terminalPtyWrite` (texto a escrever), `terminalPtyExit`
 * (encerrou; `close` = fechar a aba). app → host: `terminalOpened` com
 * cols/rows (→ `pty.open`), `terminalInput` (→ `handleInput`),
 * `terminalResize` (→ `setDimensions`); fechar a aba = `terminalClosed`
 * (→ `pty.close`). Escritas que chegam antes do xterm montar ficam retidas.
 */

export interface PseudoSink {
  write(data: string): void;
  exit(code: number | null): void;
}

const sinks = new Map<string, PseudoSink>();
const pending = new Map<string, string[]>();
const exited = new Map<string, number | null>();
/** Teto do que fica retido antes do xterm montar (por terminal). */
const MAX_PENDING = 1024 * 1024;

let notifyHost: (method: string, params: unknown) => void = () => {};

export function configurePseudoTerminals(notify: (method: string, params: unknown) => void): void {
  notifyHost = notify;
}

const hostIdOf = (ptyId: string) => ptyId.replace(/^ext-/, "");

/** O TerminalView montou o xterm do pseudoterminal (com o tamanho real). */
export function pseudoAttach(ptyId: string, cols: number, rows: number, sink: PseudoSink): () => void {
  sinks.set(ptyId, sink);
  notifyHost("terminalOpened", { id: hostIdOf(ptyId), cols: Math.max(1, cols), rows: Math.max(1, rows) });
  const queued = pending.get(ptyId);
  pending.delete(ptyId);
  queued?.forEach((d) => sink.write(d));
  if (exited.has(ptyId)) sink.exit(exited.get(ptyId) ?? null);
  return () => {
    if (sinks.get(ptyId) === sink) sinks.delete(ptyId);
  };
}

export function pseudoInput(ptyId: string, data: string): void {
  if (!exited.has(ptyId)) notifyHost("terminalInput", { id: hostIdOf(ptyId), data });
}

export function pseudoResize(ptyId: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0 && !exited.has(ptyId)) notifyHost("terminalResize", { id: hostIdOf(ptyId), cols, rows });
}

/** `terminalPtyWrite` do host. */
export function pseudoWrite(ptyId: string, data: string): void {
  const sink = sinks.get(ptyId);
  if (sink) {
    sink.write(data);
    return;
  }
  const list = pending.get(ptyId) ?? [];
  const size = list.reduce((n, d) => n + d.length, 0);
  if (size + data.length <= MAX_PENDING) list.push(data);
  pending.set(ptyId, list);
}

/** `terminalPtyExit` do host. */
export function pseudoExit(ptyId: string, code: number | null): void {
  exited.set(ptyId, code);
  sinks.get(ptyId)?.exit(code);
}

/** A aba foi fechada: esquece o estado. */
export function pseudoForget(ptyId: string): void {
  sinks.delete(ptyId);
  pending.delete(ptyId);
  exited.delete(ptyId);
}

/** Só para testes. */
export function __resetPseudoTerminals(): void {
  sinks.clear();
  pending.clear();
  exited.clear();
  notifyHost = () => {};
}
