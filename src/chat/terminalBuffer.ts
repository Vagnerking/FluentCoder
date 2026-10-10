/**
 * Buffer da saída recente do terminal integrado para o `#terminal` do Fluent
 * Chat. A parte pura (remoção de ANSI + janela deslizante) é testável; a
 * escuta dos eventos `term-data` do backend fica em `startTerminalTap`.
 */

const MAX_CHARS = 32_000;

// CSI (cores, cursor), OSC (título/hiperlinks) e escapes simples.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Remove sequências ANSI e normaliza quebras/retornos de carro. */
export function stripAnsi(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    // `\r` sozinho reescreve a linha (barras de progresso): fica o último.
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export class TerminalBuffer {
  private readonly byTerminal = new Map<string, string>();
  private lastActive: string | null = null;

  append(id: string, data: string): void {
    const next = (this.byTerminal.get(id) ?? "") + data;
    this.byTerminal.set(id, next.length > MAX_CHARS * 2 ? next.slice(-MAX_CHARS * 2) : next);
    this.lastActive = id;
  }

  /** Saída limpa do terminal mais recente (ou de `id`). */
  recent(id?: string): string {
    const key = id ?? this.lastActive;
    if (!key) return "";
    const clean = stripAnsi(this.byTerminal.get(key) ?? "");
    return clean.length > MAX_CHARS ? clean.slice(-MAX_CHARS) : clean;
  }

  clear(): void {
    this.byTerminal.clear();
    this.lastActive = null;
  }
}
