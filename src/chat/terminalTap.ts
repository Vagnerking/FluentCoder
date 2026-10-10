/**
 * Escuta global da saída do terminal integrado (evento `term-data` emitido
 * pelo backend para cada PTY) — alimenta o `#terminal` do Fluent Chat sem
 * acoplar o `TerminalView`. Inicia uma vez, na primeira montagem do chat.
 */
import { listen } from "@tauri-apps/api/event";
import { TerminalBuffer } from "./terminalBuffer";

const buffer = new TerminalBuffer();
let started = false;

export function startTerminalTap(): void {
  if (started) return;
  started = true;
  void listen<{ id: string; data: string }>("term-data", (event) => {
    buffer.append(event.payload.id, event.payload.data);
  }).catch(() => {
    started = false;
  });
}

export function recentTerminalOutput(): string {
  return buffer.recent();
}
