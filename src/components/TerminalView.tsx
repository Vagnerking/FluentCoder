import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { termCreate, termWrite, termResize, termClose, type TermSpawnOptions } from "../api";
import { terminalTheme } from "../theme/palette";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  id: string;
  cwd: string;
  /** SSH connection id when this terminal belongs to a remote workspace root. */
  connId?: string;
  /** When set, the PTY runs this command line on start (used by "Run"). */
  command?: string | null;
  /** Shell/env of a terminal requested by a hosted VS Code extension. */
  spawn?: TermSpawnOptions | null;
  /** The PTY exists (pid when known). */
  onReady?: (pid: number | null) => void;
  /** The PTY process exited (exit code when known). */
  onExit?: (code: number | null) => void;
}

interface TermDataPayload {
  id: string;
  data: string;
}

export function TerminalView({ id, cwd, connId, command, spawn, onReady, onExit }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Callbacks lidos por ref: não recriam o PTY quando o pai re-renderiza.
  const cbRef = useRef({ onReady, onExit });
  cbRef.current = { onReady, onExit };
  const spawnRef = useRef(spawn);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      // Shared palette so the terminal stays in sync with the token layer
      // (F2-AUD-001); also fills in the previously-missing ANSI red/green/
      // yellow/magenta so colored CLI output renders correctly.
      theme: { ...terminalTheme },
      fontFamily: '"Cascadia Code", "Consolas", monospace',
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

    const onData = term.onData((data) => {
      termWrite(id, data).catch(console.error);
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
    const startWhenSized = () => {
      if (disposed || created) return;
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
      if (cols > 0 && rows > 0) termResize(id, cols, rows).catch(console.error);
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      disposed = true;
      onData.dispose();
      unlistenFn?.();
      unlistenExit?.();
      ro.disconnect();
      if (created) termClose(id).catch(console.error);
      term.dispose();
    };
  }, [id, cwd, connId, command]);

  return <div ref={containerRef} className="xterm-container" />;
}
