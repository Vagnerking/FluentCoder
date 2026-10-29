/**
 * Relay puro iframe ↔ app para os webviews das extensões.
 *
 * O preâmbulo injetado pelo host (`tools/ext-host/src/preamble.js`) implementa
 * `acquireVsCodeApi()` e envia ao `window.parent` objetos
 * `{ __fluentExt: 1, handle, type, … }`. Aqui validamos e traduzimos esses
 * objetos em chamadas do protocolo do host. No sentido inverso, mensagens da
 * extensão vão CRUAS ao iframe (como no VS Code) e mensagens de controle do app
 * levam `__fluentCtl: 1` (o preâmbulo as consome antes do código da extensão).
 */

export type IframeUpMessage =
  | { type: "message"; handle: string; message: unknown }
  | { type: "setState"; handle: string; state: unknown }
  | { type: "ready"; handle: string }
  | { type: "link"; handle: string; href: string }
  | { type: "pong"; handle: string; nonce: unknown }
  | {
      type: "key";
      handle: string;
      key: string;
      code?: string;
      ctrl: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
      repeat: boolean;
    }
  | { type: "clipboard"; handle: string; op: "write"; text: string }
  | { type: "clipboard"; handle: string; op: "read"; nonce: number }
  | { type: "log"; handle: string; level: "error" | "warn"; text: string };

/** Limite de uma linha de log vinda do webview. */
const MAX_LOG = 4000;

/** Limite de texto aceito do iframe para a área de transferência. */
const MAX_CLIPBOARD = 16 * 1024 * 1024;

/**
 * Valida um `MessageEvent` vindo de um iframe de webview. Só aceita mensagens
 * do `contentWindow` esperado, da origem do host (127.0.0.1:<porta>) e com o
 * `handle` do webview — qualquer outra coisa é ignorada (null).
 */
export function parseIframeMessage(
  data: unknown,
  meta: { origin: string; source: unknown },
  expected: { origin: string; source: unknown; handle: string },
): IframeUpMessage | null {
  if (meta.source !== expected.source || meta.source == null) return null;
  if (meta.origin !== expected.origin) return null;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.__fluentExt !== 1 || d.handle !== expected.handle) return null;
  switch (d.type) {
    case "message":
      return { type: "message", handle: expected.handle, message: d.message };
    case "setState":
      return { type: "setState", handle: expected.handle, state: d.state };
    case "ready":
      return { type: "ready", handle: expected.handle };
    case "link":
      return typeof d.href === "string"
        ? { type: "link", handle: expected.handle, href: d.href }
        : null;
    case "pong":
      return { type: "pong", handle: expected.handle, nonce: d.nonce };
    case "key":
      // Só o necessário para re-disparar o atalho; nada de texto livre longo.
      if (typeof d.key !== "string" || d.key.length === 0 || d.key.length > 32) return null;
      if (d.code !== undefined && (typeof d.code !== "string" || d.code.length > 32)) return null;
      return {
        type: "key",
        handle: expected.handle,
        key: d.key,
        code: d.code as string | undefined,
        ctrl: d.ctrl === true,
        shift: d.shift === true,
        alt: d.alt === true,
        meta: d.meta === true,
        repeat: d.repeat === true,
      };
    case "clipboard":
      if (d.op === "write" && typeof d.text === "string" && d.text.length <= MAX_CLIPBOARD) {
        return { type: "clipboard", handle: expected.handle, op: "write", text: d.text };
      }
      if (d.op === "read" && typeof d.nonce === "number" && Number.isFinite(d.nonce)) {
        return { type: "clipboard", handle: expected.handle, op: "read", nonce: d.nonce };
      }
      return null;
    case "log":
      if ((d.level !== "error" && d.level !== "warn") || typeof d.text !== "string") return null;
      return { type: "log", handle: expected.handle, level: d.level, text: d.text.slice(0, MAX_LOG) };
    default:
      return null;
  }
}

/** Mensagem de controle app → preâmbulo (nunca chega ao código da extensão). */
export function controlMessage(
  type: "theme" | "ping" | "clipboardText",
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return { __fluentCtl: 1, type, ...payload };
}

/** Origem (`scheme://host:porta`) de uma URL de webview servida pelo host. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Só links web/mailto saem para o navegador do sistema. */
export function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/**
 * Fila por webview: mensagens da extensão que chegam antes de o iframe estar
 * pronto (o VS Code também as retém até o webview carregar).
 */
export class PendingQueue<T> {
  private items: T[] = [];
  private ready = false;
  private readonly deliver: (item: T) => void;
  constructor(deliver: (item: T) => void) {
    this.deliver = deliver;
  }
  push(item: T): void {
    if (this.ready) this.deliver(item);
    else this.items.push(item);
  }
  /** Marca como pronto e entrega o acumulado, na ordem. */
  open(): void {
    this.ready = true;
    const items = this.items;
    this.items = [];
    for (const it of items) this.deliver(it);
  }
  /** Volta a acumular (ex.: o iframe recarregou). */
  close(): void {
    this.ready = false;
  }
  get size(): number {
    return this.items.length;
  }
}
