/**
 * Parser das sequências OSC 633 da shell integration (formato do VS Code),
 * emitidas pelos scripts de `src-tauri/shell-integration/` nos terminais das
 * extensões:
 *
 * - `ESC ] 633 ; A BEL` prompt começou · `B` prompt terminou
 * - `E ; <linha escapada> [; <nonce>]` linha de comando
 * - `C` execução começou (a saída do comando vem depois)
 * - `D [; <código>]` execução terminou
 * - `P ; Cwd=<pasta escapada>` pasta atual
 *
 * Também aceita o terminador ST (`ESC \`). Sequências podem chegar partidas
 * entre pedaços do PTY: o resto fica guardado até o próximo `feed`. O xterm.js
 * ignora OSC desconhecidos, então o terminal não precisa filtrá-las.
 */

export type ShellEvent =
  | { type: "promptStart" }
  | { type: "commandStart" }
  | { type: "commandLine"; value: string; nonce?: string }
  | { type: "executed" }
  | { type: "finished"; exitCode?: number }
  | { type: "cwd"; value: string };

export type ShellItem = { kind: "data"; text: string } | { kind: "event"; event: ShellEvent };

const OSC_PREFIX = "\x1b]633;";
const MAX_PENDING = 64 * 1024;

/** Desfaz o escape do VS Code (`\\` e `\xHH`). */
export function unescapeOsc633(s: string): string {
  return s.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, a: string, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : a));
}

export function parseOsc633Payload(payload: string): ShellEvent | null {
  const code = payload[0];
  const rest = payload.length > 1 && payload[1] === ";" ? payload.slice(2) : "";
  switch (code) {
    case "A":
      return { type: "promptStart" };
    case "B":
      return { type: "commandStart" };
    case "C":
      return { type: "executed" };
    case "D": {
      const n = rest === "" ? NaN : Number(rest);
      return Number.isFinite(n) ? { type: "finished", exitCode: n } : { type: "finished" };
    }
    case "E": {
      // A linha escapada não contém `;` cru: o 1º `;` separa o nonce.
      const i = rest.indexOf(";");
      const value = unescapeOsc633(i === -1 ? rest : rest.slice(0, i));
      const nonce = i === -1 ? undefined : rest.slice(i + 1) || undefined;
      return { type: "commandLine", value, nonce };
    }
    case "P": {
      if (rest.startsWith("Cwd=")) return { type: "cwd", value: unescapeOsc633(rest.slice(4)) };
      return null;
    }
    default:
      return null;
  }
}

export class ShellIntegrationParser {
  private pending = "";

  /** Quebra o pedaço em dados + eventos, na ordem em que aparecem. */
  feed(chunk: string): ShellItem[] {
    let s = this.pending + chunk;
    this.pending = "";
    const out: ShellItem[] = [];
    const pushData = (text: string) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.kind === "data") last.text += text;
      else out.push({ kind: "data", text });
    };
    for (;;) {
      const start = s.indexOf(OSC_PREFIX);
      if (start === -1) {
        // Um prefixo partido no fim do pedaço (ESC, ESC], …) espera o próximo.
        const tail = partialPrefixLength(s);
        pushData(s.slice(0, s.length - tail));
        this.pending = s.slice(s.length - tail);
        break;
      }
      pushData(s.slice(0, start));
      const body = start + OSC_PREFIX.length;
      const bel = s.indexOf("\x07", body);
      const st = s.indexOf("\x1b\\", body);
      let end = -1;
      let termLen = 0;
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel;
        termLen = 1;
      } else if (st !== -1) {
        end = st;
        termLen = 2;
      }
      if (end === -1) {
        // Sequência incompleta: guarda (com teto, para não crescer sem fim).
        const rest = s.slice(start);
        if (rest.length > MAX_PENDING) pushData(rest);
        else this.pending = rest;
        break;
      }
      const ev = parseOsc633Payload(s.slice(body, end));
      if (ev) out.push({ kind: "event", event: ev });
      s = s.slice(end + termLen);
    }
    return out;
  }
}

function partialPrefixLength(s: string): number {
  const max = Math.min(OSC_PREFIX.length - 1, s.length);
  for (let n = max; n > 0; n--) {
    if (OSC_PREFIX.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}
