import assert from "node:assert/strict";
import test from "node:test";
import { stripAnsi, TerminalBuffer } from "./terminalBuffer.ts";

test("remove cores, títulos OSC e reescritas com \\r", () => {
  assert.equal(stripAnsi("\x1b[31merro\x1b[0m ok"), "erro ok");
  assert.equal(stripAnsi("\x1b]0;titulo\x07$ ls"), "$ ls");
  assert.equal(stripAnsi("10%\r50%\r100%\r\nfim"), "100%\nfim");
});

test("guarda a saída do terminal mais recente", () => {
  const buffer = new TerminalBuffer();
  assert.equal(buffer.recent(), "");
  buffer.append("t1", "um\r\n");
  buffer.append("t2", "\x1b[32mdois\x1b[0m");
  assert.equal(buffer.recent(), "dois");
  assert.equal(buffer.recent("t1"), "um\n");
  buffer.append("t1", "x".repeat(100_000));
  assert.ok(buffer.recent().length <= 32_000);
});
