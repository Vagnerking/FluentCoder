import { test } from "node:test";
import assert from "node:assert/strict";
import { BreakpointStore } from "./breakpointStore.ts";

test("toggle liga e desliga um breakpoint simples", () => {
  const s = new BreakpointStore();
  s.toggleBreakpoint("/a.cs", 10);
  assert.deepEqual(s.breakpointsFor("/a.cs"), [{ line: 10 }]);
  s.toggleBreakpoint("/a.cs", 10);
  assert.deepEqual(s.breakpointsFor("/a.cs"), []);
  // Arquivo sem breakpoint some da lista de paths.
  assert.deepEqual(s.paths(), []);
});

test("breakpointsFor vem ordenado por linha", () => {
  const s = new BreakpointStore();
  s.toggleBreakpoint("/a.cs", 30);
  s.toggleBreakpoint("/a.cs", 5);
  s.toggleBreakpoint("/a.cs", 12);
  assert.deepEqual(
    s.breakpointsFor("/a.cs").map((b) => b.line),
    [5, 12, 30]
  );
});

test("setBreakpointSpec limpa campos vazios e mantém o breakpoint ligado", () => {
  const s = new BreakpointStore();
  s.setBreakpointSpec("/a.cs", 7, { condition: "  x > 1 ", logMessage: "  ", hitCondition: "" });
  assert.deepEqual(s.breakpointsFor("/a.cs"), [{ line: 7, condition: "x > 1" }]);
  // Um set com spec toda vazia ainda deixa o breakpoint ligado (spec = {}).
  s.setBreakpointSpec("/a.cs", 9, { condition: "  " });
  assert.deepEqual(
    s.breakpointsFor("/a.cs").map((b) => b.line),
    [7, 9]
  );
});

test("os breakpoints são por arquivo (multi-arquivo isolado)", () => {
  const s = new BreakpointStore();
  s.toggleBreakpoint("/a.cs", 1);
  s.toggleBreakpoint("/b.cs", 2);
  assert.deepEqual(s.breakpointsFor("/a.cs"), [{ line: 1 }]);
  assert.deepEqual(s.breakpointsFor("/b.cs"), [{ line: 2 }]);
  assert.deepEqual(new Set(s.paths()), new Set(["/a.cs", "/b.cs"]));
});

test("subscribe é notificado com o caminho que mudou; unsubscribe para", () => {
  const s = new BreakpointStore();
  const seen: string[] = [];
  const off = s.subscribe((p) => seen.push(p));
  s.toggleBreakpoint("/a.cs", 1);
  s.setBreakpointSpec("/b.cs", 2, { condition: "y" });
  off();
  s.toggleBreakpoint("/c.cs", 3); // não observado
  assert.deepEqual(seen, ["/a.cs", "/b.cs"]);
});

test("toRecord espelha o store como record ordenado (feeds DebugState)", () => {
  const s = new BreakpointStore();
  s.toggleBreakpoint("/a.cs", 20);
  s.toggleBreakpoint("/a.cs", 4);
  s.setBreakpointSpec("/b.cs", 1, { logMessage: "hit {x}" });
  const rec = s.toRecord();
  assert.deepEqual(rec["/a.cs"].map((b) => b.line), [4, 20]);
  assert.deepEqual(rec["/b.cs"], [{ line: 1, logMessage: "hit {x}" }]);
});
