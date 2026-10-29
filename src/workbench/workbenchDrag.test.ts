import assert from "node:assert/strict";
import test from "node:test";
import { createDragRegistry, DRAG_POINTER_CLASS, DRAG_ROOT_CLASS, type DragEnv } from "./workbenchDrag.ts";

function fakeEnv() {
  const classes = new Set<string>();
  const style = new Map<string, string>();
  const handlers = new Map<string, Set<(e: Event) => void>>();
  const env: DragEnv = {
    classList: {
      add: (...t) => t.forEach((c) => classes.add(c)),
      remove: (...t) => t.forEach((c) => classes.delete(c)),
    },
    setRootStyle: (n, v) => (v == null ? style.delete(n) : style.set(n, v)),
    addEventListener: (type, fn) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener: (type, fn) => handlers.get(type)?.delete(fn),
  };
  const fire = (type: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    const ev = {
      type,
      ...extra,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    } as unknown as Event;
    for (const fn of [...(handlers.get(type) ?? [])]) fn(ev);
    return prevented;
  };
  const count = (type: string) => handlers.get(type)?.size ?? 0;
  return { env, classes, style, fire, count };
}

test("begin/end liga e desliga as classes de raiz e o bloqueio de selectstart", () => {
  const f = fakeEnv();
  const reg = createDragRegistry(f.env);
  const s = reg.begin("panel", { cursor: "grabbing" });
  assert.ok(f.classes.has(DRAG_ROOT_CLASS));
  assert.ok(f.classes.has(`${DRAG_ROOT_CLASS}-panel`));
  assert.ok(f.classes.has(DRAG_POINTER_CLASS));
  assert.equal(f.style.get("--workbench-drag-cursor"), "grabbing");
  assert.equal(f.fire("selectstart"), true, "selectstart é bloqueado durante o arraste");
  s.end();
  assert.equal(f.classes.size, 0);
  assert.equal(f.style.has("--workbench-drag-cursor"), false);
  assert.equal(f.fire("selectstart"), false);
  assert.equal(f.count("keydown"), 0);
  assert.equal(f.count("blur"), 0);
});

test("arraste de aba/nativo não blinda o Monaco (drop-capture precisa do drop)", () => {
  const f = fakeEnv();
  const reg = createDragRegistry(f.env);
  const s = reg.begin("tab", { cancelOnBlur: false, cancelOnEscape: false });
  assert.ok(f.classes.has(DRAG_ROOT_CLASS));
  assert.equal(f.classes.has(DRAG_POINTER_CLASS), false);
  assert.equal(f.count("blur"), 0);
  s.end();
});

test("Escape e blur cancelam e chamam onCancel uma única vez", () => {
  for (const trigger of ["keydown", "blur"] as const) {
    const f = fakeEnv();
    const reg = createDragRegistry(f.env);
    let cancels = 0;
    const s = reg.begin("resize", { onCancel: () => cancels++ });
    f.fire(trigger, { key: "Escape" });
    assert.equal(s.active, false);
    assert.equal(cancels, 1);
    s.end();
    s.cancel();
    assert.equal(cancels, 1);
    assert.equal(f.classes.size, 0);
  }
});

test("outras teclas não cancelam", () => {
  const f = fakeEnv();
  const reg = createDragRegistry(f.env);
  const s = reg.begin("resize");
  f.fire("keydown", { key: "a" });
  assert.equal(s.active, true);
  s.end();
});

test("sessões aninhadas: a raiz só limpa quando a última termina", () => {
  const f = fakeEnv();
  const reg = createDragRegistry(f.env);
  const a = reg.begin("native", { cancelOnBlur: false, cancelOnEscape: false });
  const b = reg.begin("resize");
  assert.ok(reg.isActive("resize"));
  b.end();
  assert.ok(f.classes.has(DRAG_ROOT_CLASS));
  assert.equal(f.classes.has(DRAG_POINTER_CLASS), false);
  assert.equal(reg.isActive("resize"), false);
  assert.ok(reg.isActive());
  a.end();
  assert.equal(reg.isActive(), false);
  assert.equal(f.classes.size, 0);
});

test("subscribe notifica mudanças e reset encerra tudo", () => {
  const f = fakeEnv();
  const reg = createDragRegistry(f.env);
  let n = 0;
  const off = reg.subscribe(() => n++);
  reg.begin("panel");
  reg.reset();
  assert.equal(reg.isActive(), false);
  assert.equal(f.classes.size, 0);
  assert.ok(n >= 2);
  off();
});

test("sem ambiente (SSR/teste) a fábrica não quebra", () => {
  const reg = createDragRegistry(null);
  const s = reg.begin("panel");
  assert.ok(reg.isActive());
  s.end();
  assert.equal(reg.isActive(), false);
});
