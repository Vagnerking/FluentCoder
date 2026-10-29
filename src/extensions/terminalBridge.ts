/**
 * `window.createTerminal` das extensões → terminal integrado REAL do app
 * (TerminalPanel + PTY do `src-tauri/src/terminal.rs`). Store sem React: o
 * runtime alimenta com os eventos do host (`terminalCreate/Show/SendText/
 * Dispose`) e o TerminalPanel assina para criar/focar/fechar as abas.
 *
 * O texto enviado antes do PTY existir (o painel ainda não tinha tamanho) fica
 * retido e sai quando o TerminalView avisa que criou o PTY (`ptyReady`).
 */
import type { HostEvent } from "./protocol";
import { ShellIntegrationParser } from "./shellIntegration.ts";
import { configurePseudoTerminals, pseudoExit, pseudoForget, pseudoWrite } from "./pseudoTerminal.ts";

export interface ExtTerminalSpec {
  /** Id do terminal no host (o PTY usa `ext-<id>`). */
  hostId: string;
  ptyId: string;
  name: string;
  cwd?: string;
  env?: Record<string, string>;
  strictEnv?: boolean;
  shellPath?: string;
  shellArgs?: string[];
  extensionId?: string;
  hideFromUser?: boolean;
  /** Pedir a shell integration (OSC 633) ao PTY (bash/zsh/fish). */
  shellIntegration?: boolean;
  /** Pseudoterminal da extensão (sem PTY; dirigido pelo host — pseudoTerminal.ts). */
  pseudo?: boolean;
}

type Action =
  | { type: "create"; spec: ExtTerminalSpec }
  | { type: "show"; ptyId: string; preserveFocus: boolean }
  | { type: "dispose"; ptyId: string }
  | { type: "rename"; ptyId: string; name: string }
  | { type: "exited"; ptyId: string };

type Listener = (a: Action) => void;

const specs = new Map<string, ExtTerminalSpec>(); // ptyId → spec
const pendingWrites = new Map<string, string[]>();
const ready = new Set<string>();
const listeners = new Set<Listener>();
let writer: (ptyId: string, data: string) => void = () => {};
let notifyHost: (method: string, params: unknown) => void = () => {};
/** Estado da shell integration por PTY (parser OSC 633 + execução corrente). */
interface ShellState {
  parser: ShellIntegrationParser;
  ready: boolean;
  commandLine?: string;
  executing: boolean;
}
const shells = new Map<string, ShellState>();
/** Teto de saída repassada ao host por execução (`execution.read()`). */
const MAX_EXEC_OUTPUT = 4 * 1024 * 1024;
const execBytes = new Map<string, number>();

/** Ações que chegaram antes de o painel assinar (ex.: painel ainda não montado). */
const backlog: Action[] = [];

export const ptyIdFor = (hostId: string) => `ext-${hostId}`;

function emit(a: Action) {
  if (listeners.size === 0) {
    backlog.push(a);
    return;
  }
  listeners.forEach((l) => l(a));
}

/** O TerminalPanel assina; recebe o backlog na hora. */
export function subscribeExtTerminals(l: Listener): () => void {
  listeners.add(l);
  backlog.splice(0).forEach((a) => l(a));
  return () => listeners.delete(l);
}

export function extTerminalSpec(ptyId: string): ExtTerminalSpec | undefined {
  return specs.get(ptyId);
}

/** Como escrever no PTY e avisar o host (o runtime injeta `termWrite` e `extHost.notify`). */
export function configureTerminalBridge(opts: {
  write: (ptyId: string, data: string) => void;
  notify: (method: string, params: unknown) => void;
}): void {
  writer = opts.write;
  notifyHost = opts.notify;
  configurePseudoTerminals(opts.notify);
}

/** TerminalView criou o PTY de um terminal de extensão. */
export function ptyReady(ptyId: string, pid: number | null): void {
  const spec = specs.get(ptyId);
  if (!spec) return;
  ready.add(ptyId);
  // Pseudoterminal: o `terminalOpened` (com cols/rows) sai do pseudoAttach.
  if (spec.pseudo) return;
  notifyHost("terminalOpened", { id: spec.hostId, pid: pid ?? undefined, shellIntegration: !!spec.shellIntegration });
  const queued = pendingWrites.get(ptyId);
  pendingWrites.delete(ptyId);
  queued?.forEach((d) => writer(ptyId, d));
}

/** O terminal saiu (processo terminou ou o usuário fechou a aba). */
export function ptyClosed(ptyId: string, exitCode: number | null): void {
  const spec = specs.get(ptyId);
  if (!spec) return;
  specs.delete(ptyId);
  ready.delete(ptyId);
  pendingWrites.delete(ptyId);
  pseudoForget(ptyId);
  shells.delete(ptyId);
  execBytes.delete(ptyId);
  notifyHost("terminalClosed", { id: spec.hostId, exitCode: exitCode ?? undefined });
}

/**
 * Saída do PTY (evento `term-data`): nos terminais de extensão com shell
 * integration, as sequências OSC 633 viram eventos do host —
 * `terminalShell` (ready/cwd/start/data/end) → onDidStart/EndTerminalShellExecution,
 * `execution.read()` e `shellIntegration.cwd`.
 */
export function feedPtyData(ptyId: string, data: string): void {
  const spec = specs.get(ptyId);
  if (!spec?.shellIntegration) return;
  let st = shells.get(ptyId);
  if (!st) {
    st = { parser: new ShellIntegrationParser(), ready: false, executing: false };
    shells.set(ptyId, st);
  }
  const id = spec.hostId;
  for (const item of st.parser.feed(data)) {
    if (item.kind === "data") {
      if (!st.executing) continue;
      const used = execBytes.get(ptyId) ?? 0;
      if (used >= MAX_EXEC_OUTPUT) continue;
      const text = item.text.slice(0, MAX_EXEC_OUTPUT - used);
      execBytes.set(ptyId, used + text.length);
      notifyHost("terminalShell", { id, type: "data", data: text });
      continue;
    }
    const ev = item.event;
    if (!st.ready) {
      st.ready = true;
      notifyHost("terminalShell", { id, type: "ready" });
    }
    switch (ev.type) {
      case "cwd":
        notifyHost("terminalShell", { id, type: "cwd", cwd: ev.value });
        break;
      case "commandLine":
        st.commandLine = ev.value;
        break;
      case "executed":
        st.executing = true;
        execBytes.set(ptyId, 0);
        notifyHost("terminalShell", { id, type: "start", commandLine: st.commandLine ?? "" });
        st.commandLine = undefined;
        break;
      case "finished":
        if (st.executing) notifyHost("terminalShell", { id, type: "end", exitCode: ev.exitCode });
        st.executing = false;
        break;
      default:
        break;
    }
  }
}

/** Eventos de terminal vindos do host. Devolve `true` se tratou. */
export function handleTerminalEvent(ev: HostEvent, onShowPanel: () => void): boolean {
  switch (ev.event) {
    case "terminalCreate": {
      const e = ev as unknown as Omit<ExtTerminalSpec, "hostId" | "ptyId"> & { id: string };
      const spec: ExtTerminalSpec = {
        hostId: e.id,
        ptyId: ptyIdFor(e.id),
        name: e.name,
        cwd: e.cwd,
        env: e.env,
        strictEnv: e.strictEnv,
        shellPath: e.shellPath,
        shellArgs: e.shellArgs,
        extensionId: e.extensionId,
        hideFromUser: e.hideFromUser,
        shellIntegration: e.shellIntegration,
        pseudo: e.pseudo === true,
      };
      specs.set(spec.ptyId, spec);
      emit({ type: "create", spec });
      return true;
    }
    case "terminalShow": {
      const e = ev as { id: string; preserveFocus: boolean };
      onShowPanel();
      emit({ type: "show", ptyId: ptyIdFor(e.id), preserveFocus: e.preserveFocus });
      return true;
    }
    case "terminalSendText": {
      const e = ev as { id: string; text: string };
      const ptyId = ptyIdFor(e.id);
      if (ready.has(ptyId)) writer(ptyId, e.text);
      else pendingWrites.set(ptyId, [...(pendingWrites.get(ptyId) ?? []), e.text]);
      return true;
    }
    case "terminalPtyWrite": {
      const e = ev as unknown as { id: string; data: string };
      pseudoWrite(ptyIdFor(e.id), String(e.data ?? ""));
      return true;
    }
    case "terminalPtyExit": {
      const e = ev as unknown as { id: string; exitCode?: number; close?: boolean };
      const ptyId = ptyIdFor(e.id);
      pseudoExit(ptyId, typeof e.exitCode === "number" ? e.exitCode : null);
      // Terminal comum: o pty encerrou → a aba fecha (como no VS Code).
      // Tarefa: a aba fica com a saída, marcada como encerrada.
      emit(e.close ? { type: "dispose", ptyId } : { type: "exited", ptyId });
      return true;
    }
    case "terminalRename": {
      const e = ev as unknown as { id: string; name: string };
      if (typeof e.name === "string" && e.name) emit({ type: "rename", ptyId: ptyIdFor(e.id), name: e.name.slice(0, 200) });
      return true;
    }
    case "terminalDispose": {
      const ptyId = ptyIdFor((ev as { id: string }).id);
      emit({ type: "dispose", ptyId });
      // Fechar a aba mata o PTY; o TerminalView chama ptyClosed.
      if (!ready.has(ptyId)) ptyClosed(ptyId, null);
      return true;
    }
    case "hostExit":
      // Terminais continuam abertos no app; só deixam de estar ligados ao host.
      specs.clear();
      ready.clear();
      pendingWrites.clear();
      shells.clear();
      execBytes.clear();
      return false;
    default:
      return false;
  }
}

/** Só para testes. */
export function __resetTerminalBridge(): void {
  specs.clear();
  pendingWrites.clear();
  ready.clear();
  shells.clear();
  execBytes.clear();
  listeners.clear();
  backlog.length = 0;
  writer = () => {};
  notifyHost = () => {};
}
