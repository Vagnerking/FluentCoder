/**
 * Minimal Debug Adapter Protocol client (roadmap csharp-ide-parity, Fase B).
 *
 * Talks to the Rust `dap::bridge` over its loopback WebSocket: each WS text
 * frame is exactly ONE unframed DAP JSON message (the bridge owns the
 * `Content-Length` framing toward the adapter's stdio). This client only does
 * seq bookkeeping — request/response matching by `request_seq` and event
 * fan-out — with no protocol opinions; the session layer owns the DAP dance.
 */

export interface DapEvent {
  type: "event";
  event: string;
  body?: unknown;
}

interface DapResponse {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

type Pending = {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
};

export class DapClient {
  private ws: WebSocket;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private eventListeners = new Map<string, Set<(body: unknown) => void>>();
  private closeListeners = new Set<() => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => this.onClose();
    ws.onerror = () => this.onClose();
  }

  /** Connects to the bridge; resolves once the socket is open. */
  static connect(port: number, token: string): Promise<DapClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
      ws.onopen = () => resolve(new DapClient(ws));
      ws.onerror = () => reject(new Error("DAP bridge connection failed"));
    });
  }

  /** Sends a DAP request; resolves with the response body (rejects on !success). */
  request<T = unknown>(command: string, args?: unknown, timeoutMs = 15_000): Promise<T> {
    const seq = this.seq++;
    const msg = { seq, type: "request", command, arguments: args };
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (body) => {
          window.clearTimeout(timer);
          resolve(body as T);
        },
        reject: (err) => {
          window.clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Subscribes to a DAP event (`stopped`, `output`, `terminated`, …). */
  on(event: string, listener: (body: unknown) => void): () => void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  /** Fires when the socket closes (adapter died / session torn down). */
  onceClosed(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  private onMessage(text: string): void {
    let msg: DapResponse | DapEvent;
    try {
      msg = JSON.parse(text) as DapResponse | DapEvent;
    } catch {
      return; // not JSON — ignore
    }
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body);
      else p.reject(new Error(msg.message || `DAP '${msg.command}' failed`));
      return;
    }
    if (msg.type === "event") {
      const set = this.eventListeners.get(msg.event);
      if (set) for (const l of [...set]) l(msg.body);
    }
  }

  private onClose(): void {
    for (const [, p] of this.pending) p.reject(new Error("DAP connection closed"));
    this.pending.clear();
    for (const l of [...this.closeListeners]) l();
    this.closeListeners.clear();
  }
}
