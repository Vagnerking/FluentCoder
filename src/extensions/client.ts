/**
 * Cliente do host de extensões VS Code. Singleton por janela: sobe o sidecar
 * via Tauri (`ext_host_start`), faz o `initialize` e expõe `call`/`notify` +
 * assinatura de eventos. Webviews registram um "sink" por handle; mensagens da
 * extensão que chegam antes do iframe ficar pronto são retidas (PendingQueue) —
 * igual ao VS Code.
 *
 * Robustez: queda do processo que não foi pedida → reinício automático com
 * backoff (1 s, 2 s, 4 s… até 30 s; desiste após 5 quedas em 2 min) e o evento
 * `hostRestarted` para as views se re-resolverem. `restart()` é o comando
 * "Reiniciar Host de Extensões" da Paleta.
 *
 * Várias janelas compartilham o MESMO sidecar (o evento Tauri chega a todas):
 * os ids das chamadas levam um prefixo aleatório por janela, então uma janela
 * nunca resolve a promise de outra.
 */
import { decodeBinary, encodeBinary } from "./bincodec";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  HostEvent,
  InitializeResult,
  InstalledExtension,
  LoadedExtension,
  WebviewInfo,
} from "./protocol";
import { PendingQueue } from "./relay";
import { readFluentThemeVars } from "./theme";
import { appendOutput } from "../output/outputStore";

interface StartInfo {
  started: boolean;
  pid: number;
  dataDir: string;
  /** Pasta de extensões gerenciada pelo app (`<app_data>/extensions`). */
  extensionsDir?: string;
  script: string;
  node: string;
  secrets: string;
}

type Listener = (e: HostEvent) => void;

/** Canal da aba "Saída" com o ciclo de vida do host e os logs dele. */
export const OUTPUT_CHANNEL = "Extensões";

/** Log de desenvolvimento do relay (prova do round trip no console do app). */
export const EXT_DEBUG = !!import.meta.env?.DEV;

export function extLog(...args: unknown[]): void {
  if (EXT_DEBUG) console.debug("[ext-host]", ...args);
}

function now(): string {
  return new Date().toLocaleTimeString("pt-BR", { hour12: false });
}

/** Linha na saída "Extensões" (sempre; não só em dev). */
export function hostOutput(message: string): void {
  appendOutput(OUTPUT_CHANNEL, `[${now()}] ${message}`);
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const CRASH_WINDOW_MS = 2 * 60 * 1000;
const MAX_CRASHES = 5;

class ExtHostClient {
  private readonly windowTag = Math.random().toString(36).slice(2, 8);
  private nextId = 1;
  private waiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private queues = new Map<string, PendingQueue<unknown>>();
  private sinks = new Map<string, (message: unknown) => void>();
  private loaded = new Map<string, Promise<LoadedExtension>>();
  private unlisten: UnlistenFn[] = [];
  private initPromise: Promise<InitializeResult> | null = null;
  private workspace: string | null = null;
  private stopping = false;
  private crashes: number[] = [];
  private restartTimer: number | undefined;
  private lastInit: InitializeResult | null = null;
  private pid: number | null = null;
  /** Extensões ativadas nesta sessão do host (reativadas após um reinício). */
  private active = new Set<string>();
  /** Contadores do relay (exibidos no rodapé de debug do painel). */
  readonly stats = { up: 0, down: 0, lastUp: "", lastDown: "" };
  /** Tempos medidos (ms) para diagnóstico/aceite de desempenho. */
  readonly timings: Record<string, number> = {};

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
        hostOutput(`Falha ao iniciar o host: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      });
    }
    return this.initPromise;
  }

  private initHooks = new Set<(info: InitializeResult) => Promise<void> | void>();

  /** Roda após cada `initialize` (startup/reinício), antes do `hostReady`. */
  onInitialized(hook: (info: InitializeResult) => Promise<void> | void): () => void {
    this.initHooks.add(hook);
    return () => this.initHooks.delete(hook);
  }

  /** Resultado do último `initialize` (null se o host não subiu). */
  get info(): InitializeResult | null {
    return this.lastInit;
  }

  private async start(workspace: string | null): Promise<InitializeResult> {
    const t0 = performance.now();
    if (this.unlisten.length === 0) {
      this.unlisten.push(
        await listen<string>("ext-host://message", (e) => this.onLine(e.payload)),
        await listen<number>("ext-host://exit", (e) => {
          // Só a saída do processo ATUAL conta (um reinício já pode ter subido outro).
          if (this.pid !== null && e.payload === this.pid) this.onExit();
        }),
      );
    }
    this.stopping = false;
    const info = await invoke<StartInfo>("ext_host_start");
    this.pid = info.pid;
    extLog("sidecar", info);
    if (info.started) hostOutput(`Host iniciado (pid ${info.pid}, ${info.node}).`);
    const result = (await this.call("initialize", {
      workspaceFolders: workspace ? [workspace] : [],
      dataDir: info.dataDir,
      extensionsDir: info.extensionsDir,
      language: "pt-br",
      secrets: info.secrets,
      debugWebviews: EXT_DEBUG,
    })) as InitializeResult;
    // Tema já no 1º HTML servido (evita "piscar" com as cores do VS Code).
    void this.notify("setTheme", { vars: readFluentThemeVars(), kind: "dark" });
    this.timings.hostStartMs = Math.round(performance.now() - t0);
    this.lastInit = result;
    // Ganchos que precisam chegar ao host ANTES de qualquer extensão ativar
    // (ex.: o snapshot das configurações — src/settings/extHostBridge.ts).
    for (const hook of [...this.initHooks]) {
      try {
        await hook(result);
      } catch (err) {
        extLog("gancho de inicialização falhou", err);
      }
    }
    queueMicrotask(() => this.emit({ event: "hostReady" }));
    if (info.started) {
      const supported = result.extensions.filter((e) => e.supported).map((e) => `${e.label} ${e.version}`);
      hostOutput(
        `Pronto em ${this.timings.hostStartMs} ms — ${result.origin}${result.compileCache ? " · cache de compilação ativo" : ""}. Extensões: ${supported.join(", ") || "nenhuma suportada instalada"}.`,
      );
    }
    return result;
  }

  private onExit(): void {
    const wasRunning = this.initPromise !== null;
    this.initPromise = null;
    this.pid = null;
    this.lastInit = null;
    this.loaded.clear();
    for (const w of this.waiters.values()) w.reject(new Error("O host de extensões foi encerrado."));
    this.waiters.clear();
    this.emit({ event: "hostExit" });
    if (this.stopping || !wasRunning) return;
    // Queda não pedida: reinicia com backoff.
    const t = Date.now();
    this.crashes = [...this.crashes.filter((c) => t - c < CRASH_WINDOW_MS), t];
    if (this.crashes.length > MAX_CRASHES) {
      hostOutput(`O host caiu ${this.crashes.length} vezes em 2 minutos; reinício automático suspenso. Use "Reiniciar Host de Extensões" na Paleta.`);
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)];
    hostOutput(`O host encerrou inesperadamente; reiniciando em ${delay / 1000} s…`);
    window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => void this.revive(), delay);
  }

  /** Sobe de novo e reativa as extensões que estavam ativas. */
  private async revive(): Promise<void> {
    try {
      await this.ensureStarted(this.workspace);
      for (const id of [...this.active]) await this.loadExtension(id).catch(() => this.active.delete(id));
      this.emit({ event: "hostRestarted" });
    } catch (err) {
      hostOutput(`Falha ao reiniciar o host: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** "Reiniciar Host de Extensões": encerra (deactivate das extensões) e sobe de novo. */
  async restart(): Promise<void> {
    window.clearTimeout(this.restartTimer);
    this.crashes = [];
    this.stopping = true;
    hostOutput("Reiniciando o host de extensões…");
    await invoke("ext_host_stop").catch(() => {});
    // O evento de saída chega pelo leitor do stdout; garante o estado limpo.
    if (this.initPromise) this.onExit();
    this.stopping = false;
    await this.revive();
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const key = String(msg.id);
      const w = this.waiters.get(key);
      if (w) {
        this.waiters.delete(key);
        if (msg.error) w.reject(new Error((msg.error as { message: string }).message));
        else w.resolve(msg.result);
      }
      return; // resposta de outra janela: ignora
    }
    if (typeof msg.event !== "string") return;
    const ev = msg as HostEvent;
    if (ev.event === "postMessage") {
      const { handle, message } = ev as { handle: string; message: unknown };
      this.stats.down++;
      this.stats.lastDown = describe(message);
      extLog(`ext→webview ${handle}`, this.stats.lastDown);
      this.queueFor(handle).push(decodeBinary(message));
    } else if (ev.event === "log") {
      const e = ev as { message: string; level?: string };
      extLog(e.message);
      // O tráfego do relay (debugWebviews, só em dev) fica no console, não na Saída.
      if (!/^(webview→ext|ext→webview) /.test(e.message)) hostOutput(e.level === "error" ? `ERRO: ${e.message}` : e.message);
    } else if (ev.event === "extensionActivated") {
      const e = ev as { extension: LoadedExtension; ms?: number };
      this.active.add(e.extension.id);
      if (e.ms !== undefined) this.timings[`activate:${e.extension.id}`] = e.ms;
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
    const id = `${this.windowTag}:${this.nextId++}`;
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
      const t0 = performance.now();
      p = this.call("loadExtension", { id }) as Promise<LoadedExtension>;
      p.then(
        (ext) => {
          this.active.add(ext.id);
          this.timings[`load:${id}`] = Math.round(performance.now() - t0);
          if (ext.activationMs !== undefined) hostOutput(`${ext.displayName} ${ext.version} ativada em ${ext.activationMs} ms.`);
        },
        (err) => {
          this.loaded.delete(id);
          hostOutput(`Falha ao ativar ${id}: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
      this.loaded.set(id, p);
    }
    return p;
  }

  /**
   * Relê as extensões instaladas (após instalar/atualizar/habilitar na view
   * Extensões) sem reiniciar o host. Extensões novas ficam carregáveis na
   * hora; as que JÁ estavam ativas só trocam de versão com "Reiniciar Host
   * de Extensões" (o Node não descarrega um módulo carregado).
   */
  async refreshInstalled(): Promise<InstalledExtension[]> {
    if (!this.initPromise) return [];
    await this.initPromise;
    const list = (await this.call("listInstalled")) as InstalledExtension[];
    if (this.lastInit) this.lastInit = { ...this.lastInit, extensions: list };
    this.emit({ event: "installedChanged" });
    return list;
  }

  /** Ativa em segundo plano (ex.: ponteiro sobre a aba) — o clique encontra pronto. */
  prewarm(id: string): void {
    if (!this.initPromise || this.loaded.has(id)) return;
    void this.loadExtension(id).catch(() => {});
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  get anyActive(): boolean {
    return this.active.size > 0;
  }

  resolveView(viewId: string): Promise<WebviewInfo> {
    return this.call("resolveView", { viewId }) as Promise<WebviewInfo>;
  }

  /** webview → extensão (acquireVsCodeApi().postMessage). */
  sendToExtension(handle: string, message: unknown): void {
    this.stats.up++;
    this.stats.lastUp = describe(message);
    extLog(`webview→ext ${handle}`, this.stats.lastUp);
    void this.notify("webviewMessage", { handle, message: encodeBinary(message) });
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
