/**
 * Registry de sessões de debug (issue #100, multi-sessão .NET). Substitui o
 * singleton: cada sessão é um `DebugSessionManager` próprio com `sessionId`
 * único (`netcoredbg-1`, `-2`, …) — o backend Rust já é multi-sessão
 * (`DapState` = HashMap por id), então cada manager fala com o seu adaptador.
 *
 * Regras de ciclo de vida:
 * - Sempre existe pelo menos UMA sessão (a "default"), então a UI atual
 *   (launcher/toolbar) nunca fica sem alvo.
 * - Uma sessão que JÁ rodou e voltou a "idle" (fim do processo / stop) é
 *   removida da lista — a menos que seja a última, caso em que apenas volta a
 *   ser a default. Sessões em "error" ficam visíveis até o usuário agir.
 * - Trocar a ativa para longe de uma sessão recém-criada que nunca iniciou
 *   descarta essa sessão (era só um launcher aberto).
 * - Remover a ativa promove a primeira restante.
 *
 * Módulo folha puro: o manager real chega via factory (injeção), então os
 * testes rodam sem Tauri/api.ts. `import type` abaixo é apagado em runtime.
 */
import type { DebugStatus } from "./debugSession.ts";

/** O mínimo que o registry precisa de uma sessão (o manager real tem mais). */
export interface RegistrySession {
  subscribe(listener: () => void): () => void;
  getState(): { status: DebugStatus; label?: string };
  /** Liberação de recursos fora do DAP (ex.: unsubscribe do breakpointStore). */
  dispose?(): void;
}

/** Linha do seletor de sessões da UI. */
export interface SessionSummary {
  id: string;
  label: string;
  status: DebugStatus;
}

export interface RegistrySnapshot {
  sessions: SessionSummary[];
  activeId: string;
}

interface Entry<M> {
  session: M;
  /** True depois que a sessão saiu de "idle" pela primeira vez. */
  everActive: boolean;
  unsubscribe: () => void;
}

type Listener = () => void;

export class DebugSessionRegistry<M extends RegistrySession> {
  private entries = new Map<string, Entry<M>>();
  private counter = 0;
  private activeId = "";
  private listeners = new Set<Listener>();
  private snapshot: RegistrySnapshot = { sessions: [], activeId: "" };

  private factory: (sessionId: string) => M;
  private idPrefix: string;

  constructor(factory: (sessionId: string) => M, idPrefix = "netcoredbg") {
    this.factory = factory;
    this.idPrefix = idPrefix;
    this.createSession(); // garante a sessão default
  }

  // ── React wiring (useSyncExternalStore-friendly) ──────────────────────────
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Snapshot cacheado — referência estável entre notificações. */
  getSnapshot = (): RegistrySnapshot => this.snapshot;

  // ── sessões ───────────────────────────────────────────────────────────────
  /** Cria uma sessão nova (id único) e a torna ativa. */
  createSession(): M {
    const id = `${this.idPrefix}-${++this.counter}`;
    const session = this.factory(id);
    const unsubscribe = session.subscribe(() => this.onSessionChanged(id));
    this.entries.set(id, { session, everActive: false, unsubscribe });
    this.activeId = id;
    this.notify();
    return session;
  }

  /** A sessão ativa (sempre existe — o registry mantém pelo menos uma). */
  get active(): M {
    return this.entries.get(this.activeId)!.session;
  }

  get activeSessionId(): string {
    return this.activeId;
  }

  get(id: string): M | undefined {
    return this.entries.get(id)?.session;
  }

  /** Sessões vivas, na ordem de criação. */
  sessions(): M[] {
    return [...this.entries.values()].map((e) => e.session);
  }

  /** Troca a sessão ativa. Uma sessão anterior que nunca iniciou é descartada
   *  (era só um launcher aberto que o usuário abandonou). */
  setActive(id: string): void {
    if (id === this.activeId || !this.entries.has(id)) return;
    const prevId = this.activeId;
    const prev = this.entries.get(prevId);
    this.activeId = id;
    if (
      prev &&
      !prev.everActive &&
      prev.session.getState().status === "idle" &&
      this.entries.size > 1
    ) {
      this.removeEntry(prevId);
    }
    this.notify();
  }

  // ── ciclo de vida ─────────────────────────────────────────────────────────
  private onSessionChanged(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const status = entry.session.getState().status;
    if (status !== "idle") {
      entry.everActive = true;
    } else if (entry.everActive) {
      // Sessão encerrada (processo terminou / stop). Sai da lista — mas a
      // última vira a default de novo, para a UI nunca ficar sem sessão.
      if (this.entries.size > 1) this.removeEntry(id);
      else entry.everActive = false;
    }
    this.notify();
  }

  private removeEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.unsubscribe();
    entry.session.dispose?.();
    this.entries.delete(id);
    if (this.activeId === id) {
      // Promove a primeira restante (sempre há uma: só removemos com size > 1).
      this.activeId = this.entries.keys().next().value!;
    }
  }

  private notify(): void {
    this.snapshot = {
      activeId: this.activeId,
      sessions: [...this.entries.entries()].map(([id, e]) => {
        const st = e.session.getState();
        return { id, label: st.label ?? id, status: st.status };
      }),
    };
    for (const l of [...this.listeners]) l();
  }
}
