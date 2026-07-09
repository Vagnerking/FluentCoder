import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugSessionRegistry, type RegistrySession } from "./debugSessionRegistry.ts";
import type { DebugStatus } from "./debugSession.ts";

/** Fake manager: só o contrato que o registry usa, com estado controlável. */
class FakeSession implements RegistrySession {
  id: string;
  status: DebugStatus = "idle";
  label?: string;
  disposed = false;
  private listeners = new Set<() => void>();
  constructor(id: string) {
    this.id = id;
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  getState() {
    return { status: this.status, label: this.label };
  }
  dispose() {
    this.disposed = true;
  }
  /** Simula uma mudança de status disparando os observers (como o real). */
  emit(status: DebugStatus) {
    this.status = status;
    for (const l of [...this.listeners]) l();
  }
}

function makeRegistry() {
  const created: FakeSession[] = [];
  const reg = new DebugSessionRegistry<FakeSession>((id) => {
    const s = new FakeSession(id);
    created.push(s);
    return s;
  });
  return { reg, created };
}

test("começa com uma sessão default ativa", () => {
  const { reg } = makeRegistry();
  assert.equal(reg.sessions().length, 1);
  assert.equal(reg.getSnapshot().sessions.length, 1);
  assert.equal(reg.getSnapshot().activeId, reg.activeSessionId);
});

test("createSession gera ids únicos e torna a nova ativa", () => {
  const { reg } = makeRegistry();
  const first = reg.activeSessionId;
  reg.createSession();
  const second = reg.activeSessionId;
  assert.notEqual(first, second);
  assert.equal(reg.sessions().length, 2);
});

test("setActive troca a ativa e descarta um launcher idle nunca iniciado", () => {
  const { reg } = makeRegistry();
  const s1 = reg.active; // default, idle
  reg.createSession(); // s2 idle, ativa
  // Voltar para s1 descarta s2 (idle e nunca iniciou).
  reg.setActive(s1.id);
  assert.equal(reg.active.id, s1.id);
  assert.equal(reg.sessions().length, 1);
});

test("uma sessão que iniciou NÃO é descartada ao trocar de ativa", () => {
  const { reg } = makeRegistry();
  const s1 = reg.active;
  const s2 = reg.createSession();
  s2.emit("running"); // s2 já rodou
  reg.setActive(s1.id);
  // s2 continua viva (everActive), só não é mais a ativa.
  assert.equal(reg.sessions().length, 2);
  assert.equal(reg.active.id, s1.id);
});

test("sessão encerrada (idle após rodar) sai da lista quando há outra", () => {
  const { reg } = makeRegistry();
  const s1 = reg.active;
  const s2 = reg.createSession();
  s2.emit("running");
  s2.emit("idle"); // processo terminou
  assert.equal(reg.sessions().length, 1);
  assert.equal(reg.sessions()[0].id, s1.id);
  assert.ok(s2.disposed, "a sessão removida deve ter dispose() chamado");
});

test("a última sessão nunca é removida — só volta a idle", () => {
  const { reg } = makeRegistry();
  const only = reg.active;
  only.emit("running");
  only.emit("idle");
  assert.equal(reg.sessions().length, 1);
  assert.equal(reg.active.id, only.id);
  assert.ok(!only.disposed);
});

test("remover a ativa promove a primeira restante", () => {
  const { reg } = makeRegistry();
  const s1 = reg.active;
  const s2 = reg.createSession(); // ativa
  s1.emit("running");
  s2.emit("running");
  // s2 é a ativa; ao encerrar, promove s1.
  s2.emit("idle");
  assert.equal(reg.active.id, s1.id);
});

test("subscribe notifica em criação, troca e mudança de status", () => {
  const { reg } = makeRegistry();
  let n = 0;
  reg.subscribe(() => n++);
  const before = n;
  const s2 = reg.createSession(); // notifica
  s2.emit("running"); // notifica
  reg.setActive(reg.sessions()[0].id); // notifica
  assert.ok(n > before + 1);
});

test("getSnapshot expõe label e status de cada sessão", () => {
  const { reg } = makeRegistry();
  reg.active.label = "Api";
  reg.active.emit("stopped");
  const snap = reg.getSnapshot();
  const row = snap.sessions.find((s) => s.id === reg.activeSessionId)!;
  assert.equal(row.label, "Api");
  assert.equal(row.status, "stopped");
});
