import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { fontStacks } from "../platform/fonts";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { termCreate, termWrite, termResize, termClose, type TermSpawnOptions } from "../api";
import { terminalTheme } from "../theme/palette";
import "@xterm/xterm/css/xterm.css";
import { pseudoAttach, pseudoInput, pseudoResize } from "../extensions/pseudoTerminal";

interface TerminalViewProps {
  id: string;
  cwd: string;
  /** SSH connection id when this terminal belongs to a remote workspace root. */
  connId?: string;
  /** When set, the PTY runs this command line on start (used by "Run"). */
  command?: string | null;
  /** Shell/env of a terminal requested by a hosted VS Code extension. */
  spawn?: TermSpawnOptions | null;
  /**
   * The PTY already exists in the backend (an ACP agent's `terminal/create`):
   * attach to it — replay what it printed so far, then stream — instead of
   * spawning a shell.
   */
  attach?: boolean;
  /**
   * Pseudoterminal of a hosted VS Code extension (`createTerminal({ pty })`,
   * `CustomExecution` tasks): no PTY — output/input go through the extension
   * host (src/extensions/pseudoTerminal.ts).
   */
  pseudo?: boolean;
  /** The PTY exists (pid when known). */
  onReady?: (pid: number | null) => void;
  /** The PTY process exited (exit code when known). */
  onExit?: (code: number | null) => void;
}

interface TermDataPayload {
  id: string;
  data: string;
  /** Bytes emitted so far (attached PTYs only), to skip what the replay covered. */
  seq?: number;
}

export function TerminalView({ id, cwd, connId, command, spawn, attach, pseudo, onReady, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Callbacks lidos por ref: não recriam o PTY quando o pai re-renderiza.
  const cbRef = useRef({ onReady, onExit });
  cbRef.current = { onReady, onExit };
  const spawnRef = useRef(spawn);
  const attachRef = useRef(attach);
  const pseudoRef = useRef(pseudo);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      // Shared palette so the terminal stays in sync with the token layer
      // (F2-AUD-001); also fills in the previously-missing ANSI red/green/
      // yellow/magenta so colored CLI output renders correctly.
      theme: { ...terminalTheme },
      // Mono do SO (Cascadia / SF Mono / JetBrains Mono → DejaVu Sans Mono).
      fontFamily: fontStacks().mono,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    let disposed = false;
    let created = false;
    let unlistenFn: (() => void) | undefined;
    let detachPseudo: (() => void) | undefined;
    const isPseudo = !!pseudoRef.current;

    const onData = term.onData((data) => {
      if (isPseudo) pseudoInput(id, data);
      else termWrite(id, data).catch(console.error);
    });

    /** Fits only when the container is actually laid out; returns success. */
    const safeFit = (): boolean => {
      const el = containerRef.current;
      if (!el || el.offsetWidth < 2 || el.offsetHeight < 2) return false;
      fitAddon.fit();
      return true;
    };

    // Create the PTY only once the container has a real size, so the shell starts
    // with correct cols/rows. The FIRST terminal opens while the panel is still
    // laying out — fitting too early gives a tiny size and the shell prints a
    // garbled, truncated prompt that a later resize can't fix.
    // Attached PTY: replay its captured output, then live events past it.
    let replayedSeq = -1;
    const early: TermDataPayload[] = [];
    const attachToPty = () => {
      created = true;
      void invoke<{ text: string; seq: number } | null>("acp_terminal_snapshot", { id })
        .then((snap) => {
          if (disposed) return;
          if (snap) term.write(snap.text);
          replayedSeq = snap?.seq ?? 0;
          for (const ev of early.splice(0)) if ((ev.seq ?? Infinity) > replayedSeq) term.write(ev.data);
          if (safeFit() && term.cols > 0 && term.rows > 0) termResize(id, term.cols, term.rows).catch(() => {});
        })
        .catch(() => {
          replayedSeq = 0;
        });
    };

    const startWhenSized = () => {
      if (disposed || created) return;
      if (isPseudo) {
        if (!safeFit()) {
          requestAnimationFrame(startWhenSized);
          return;
        }
        created = true;
        detachPseudo = pseudoAttach(id, term.cols, term.rows, {
          write: (d) => term.write(d),
          exit: (code) => cbRef.current.onExit?.(code),
        });
        cbRef.current.onReady?.(null);
        return;
      }
      if (attachRef.current) {
        attachToPty();
        return;
      }
      if (!safeFit()) {
        requestAnimationFrame(startWhenSized);
        return;
      }
      created = true;
      const { cols, rows } = term;
      termCreate(id, cwd, cols, rows, command, spawnRef.current, connId)
        .then((pid) => {
          if (!disposed) cbRef.current.onReady?.(pid ?? null);
        })
        .catch((err) => {
          console.error(err);
          term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
          cbRef.current.onExit?.(null);
        });
    };

    // Register the output listener BEFORE creating the PTY so no early bytes
    // (the initial prompt) are missed.
    listen<TermDataPayload>("term-data", (event) => {
      if (event.payload.id === id) {
        if (attachRef.current) {
          if (replayedSeq < 0) {
            early.push(event.payload);
            return;
          }
          if (event.payload.seq !== undefined && event.payload.seq <= replayedSeq) return;
        }
        term.write(event.payload.data);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlistenFn = fn;
      requestAnimationFrame(startWhenSized);
    });
    let unlistenExit: (() => void) | undefined;
    listen<{ id: string; code: number | null }>("term-exit", (event) => {
      if (event.payload.id === id) cbRef.current.onExit?.(event.payload.code ?? null);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });

    const ro = new ResizeObserver(() => {
      if (!created || !safeFit()) return;
      const { cols, rows } = term;
      if (isPseudo) pseudoResize(id, cols, rows);
      else if (cols > 0 && rows > 0) termResize(id, cols, rows).catch(console.error);
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      disposed = true;
      onData.dispose();
      unlistenFn?.();
      unlistenExit?.();
      ro.disconnect();
      detachPseudo?.();
      if (created && !isPseudo) termClose(id).catch(console.error);
      term.dispose();
    };
  }, [id, cwd, connId, command]);

  return <div ref={containerRef} className="xterm-container" />;
}
