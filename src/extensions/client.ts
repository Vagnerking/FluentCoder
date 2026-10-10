/**
 * Cliente do host de extensões VS Code (PoC). Singleton por janela: sobe o
 * sidecar via Tauri (`ext_host_start`), faz o `initialize` e expõe
 * `call`/`notify` + assinatura de eventos. Webviews registram um "sink" por
 * handle; mensagens da extensão que chegam antes do iframe ficar pronto são
 * retidas (PendingQueue) — igual ao VS Code.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EditorStatePayload,
  HostEvent,
  InitializeResult,
  LoadedExtension,
  WebviewInfo,
} from "./protocol";
import { PendingQueue } from "./relay";
import { readFluentThemeVars } from "./theme";

interface StartInfo {
  started: boolean;
  pid: number;
  dataDir: string;
  script: string;
}

type Listener = (e: HostEvent) => void;

/** Log de desenvolvimento do relay (prova do round trip no console do app). */
export const EXT_DEBUG = import.meta.env.DEV;

export function extLog(...args: unknown[]): void {
  if (EXT_DEBUG) console.debug("[ext-host]", ...args);
}

class ExtHostClient {
  private nextId = 1;
  private waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private queues = new Map<string, PendingQueue<unknown>>();
  private sinks = new Map<string, (message: unknown) => void>();
  private loaded = new Map<string, Promise<LoadedExtension>>();
  private unlisten: UnlistenFn[] = [];
  private initPromise: Promise<InitializeResult> | null = null;
  private workspace: string | null = null;
  /** Contadores do relay (exibidos no rodapé de debug do painel). */
  readonly stats = { up: 0, down: 0, lastUp: "", lastDown: "" };

  /** Sobe (se preciso) e inicializa o host. Idempotente. */
  ensureStarted(workspace: string | null): Promise<InitializeResult> {
    if (this.initPromise && this.workspace !== workspace && workspace) {
      void this.notify("setWorkspaceFolders", { folders: [workspace] });
      this.workspace = workspace;
    }
    if (!this.initPromise) {
      this.workspace = workspace;
      this.initPromise = this.start(workspace).catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async start(workspace: string | null): Promise<InitializeResult> {
    if (this.unlisten.length === 0) {
      this.unlisten.push(
        await listen<string>("ext-host://message", (e) => this.onLine(e.payload)),
        await listen<number>("ext-host://exit", () => this.onExit()),
      );
    }
    const info = await invoke<StartInfo>("ext_host_start");
    extLog("sidecar", info);
    const result = (await this.call("initialize", {
      workspaceFolders: workspace ? [workspace] : [],
      dataDir: info.dataDir,
      language: "pt-br",
      debugWebviews: EXT_DEBUG,
    })) as InitializeResult;
    // Tema já no 1º HTML servido (evita "piscar" com as cores do VS Code).
    void this.notify("setTheme", { vars: readFluentThemeVars(), kind: "dark" });
    return result;
  }

  private onExit(): void {
    extLog("sidecar encerrou");
    this.initPromise = null;
    this.loaded.clear();
    for (const w of this.waiters.values()) w.reject(new Error("O host de extensões foi encerrado."));
    this.waiters.clear();
    this.emit({ event: "hostExit" });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.waiters.has(msg.id)) {
      const w = this.waiters.get(msg.id)!;
      this.waiters.delete(msg.id);
      if (msg.error) w.reject(new Error((msg.error as { message: string }).message));
      else w.resolve(msg.result);
      return;
    }
    if (typeof msg.event !== "string") return;
    const ev = msg as HostEvent;
    if (ev.event === "postMessage") {
      const { handle, message } = ev as { handle: string; message: unknown };
      this.stats.down++;
      this.stats.lastDown = describe(message);
      extLog(`ext→webview ${handle}`, this.stats.lastDown);
      this.queueFor(handle).push(message);
    } else if (ev.event === "log") {
      extLog((ev as { message: string }).message);
    }
    this.emit(ev);
  }

  private emit(ev: HostEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(ev);
      } catch (err) {
        console.error("[ext-host] listener falhou", err);
      }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      invoke("ext_host_send", { line: JSON.stringify({ id, method, params }) }).catch((err) => {
        this.waiters.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return invoke<void>("ext_host_send", { line: JSON.stringify({ method, params }) }).catch((err) => {
      extLog(`falha ao enviar ${method}`, err);
    });
  }

  /** Carrega + ativa uma extensão instalada (uma vez por sessão do host). */
  loadExtension(id: string): Promise<LoadedExtension> {
    let p = this.loaded.get(id);
    if (!p) {
      p = this.call("loadExtension", { id }) as Promise<LoadedExtension>;
      p.catch(() => this.loaded.delete(id));
      this.loaded.set(id, p);
    }
    return p;
  }

  resolveView(viewId: string): Promise<WebviewInfo> {
    return this.call("resolveView", { viewId }) as Promise<WebviewInfo>;
  }

  /** webview → extensão (acquireVsCodeApi().postMessage). */
  sendToExtension(handle: string, message: unknown): void {
    this.stats.up++;
    this.stats.lastUp = describe(message);
    extLog(`webview→ext ${handle}`, this.stats.lastUp);
    void this.notify("webviewMessage", { handle, message });
  }

  private queueFor(handle: string): PendingQueue<unknown> {
    let q = this.queues.get(handle);
    if (!q) {
      q = new PendingQueue((m) => this.sinks.get(handle)?.(m));
      this.queues.set(handle, q);
    }
    return q;
  }

  /** Liga o iframe (já pronto) ao handle e entrega o que estava retido. */
  attachSink(handle: string, sink: (message: unknown) => void): () => void {
    this.sinks.set(handle, sink);
    const q = this.queueFor(handle);
    q.open();
    return () => {
      if (this.sinks.get(handle) === sink) this.sinks.delete(handle);
      q.close();
    };
  }

  publishEditorState(state: EditorStatePayload): void {
    if (!this.initPromise) return;
    void this.notify("editorState", state);
  }

  get running(): boolean {
    return this.initPromise !== null;
  }
}

function describe(message: unknown): string {
  if (!message || typeof message !== "object") return String(message);
  const m = message as Record<string, unknown>;
  const inner = m.message && typeof m.message === "object" ? (m.message as Record<string, unknown>) : null;
  const req = inner?.request && typeof inner.request === "object" ? (inner.request as Record<string, unknown>) : null;
  const reqOuter = m.request && typeof m.request === "object" ? (m.request as Record<string, unknown>) : null;
  const resp = inner?.response && typeof inner.response === "object" ? (inner.response as Record<string, unknown>) : null;
  return [m.type, inner?.type, req?.type ?? reqOuter?.type, resp?.type].filter(Boolean).join("/");
}

export const extHost = new ExtHostClient();
