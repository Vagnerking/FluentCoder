import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { termCreate, termWrite, termResize, termClose } from "../api";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  id: string;
  cwd: string;
}

interface TermDataPayload {
  id: string;
  data: string;
}

export function TerminalView({ id, cwd }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#1f1f1f",
        foreground: "#cccccc",
        cursor: "#60cdff",
        selectionBackground: "rgba(96,205,255,0.3)",
      },
      fontFamily: '"Cascadia Code", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
      const { cols, rows } = term;
      termCreate(id, cwd, cols, rows).catch(console.error);
    });

    const onData = term.onData((data) => {
      termWrite(id, data).catch(console.error);
    });

    let unlistenFn: (() => void) | undefined;
    listen<TermDataPayload>("term-data", (event) => {
      if (event.payload.id === id) {
        term.write(event.payload.data);
      }
    }).then((fn) => { unlistenFn = fn; });

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      const { cols, rows } = term;
      termResize(id, cols, rows).catch(console.error);
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      onData.dispose();
      unlistenFn?.();
      ro.disconnect();
      termClose(id).catch(console.error);
      term.dispose();
    };
  }, [id, cwd]);

  return <div ref={containerRef} className="xterm-container" />;
}
