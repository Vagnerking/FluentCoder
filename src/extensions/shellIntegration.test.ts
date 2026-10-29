import assert from "node:assert/strict";
import test from "node:test";
import { ShellIntegrationParser, parseOsc633Payload, unescapeOsc633 } from "./shellIntegration.ts";
import { __resetTerminalBridge, configureTerminalBridge, feedPtyData, handleTerminalEvent, ptyReady } from "./terminalBridge.ts";

const osc = (p: string) => `\x1b]633;${p}\x07`;

test("unescape e payloads OSC 633", () => {
  assert.equal(unescapeOsc633("echo a\\x3b b \\\\n"), "echo a; b \\n");
  assert.deepEqual(parseOsc633Payload("D;127"), { type: "finished", exitCode: 127 });
  assert.deepEqual(parseOsc633Payload("D"), { type: "finished" });
  assert.deepEqual(parseOsc633Payload("E;ls\\x3b pwd;abc"), { type: "commandLine", value: "ls; pwd", nonce: "abc" });
  assert.deepEqual(parseOsc633Payload("P;Cwd=/home/u/meu\\x3bdir"), { type: "cwd", value: "/home/u/meu;dir" });
  assert.equal(parseOsc633Payload("P;Outro=1"), null);
  assert.equal(parseOsc633Payload("Z"), null);
});

test("parser separa dados e eventos, inclusive sequência partida entre pedaços e ST", () => {
  const p = new ShellIntegrationParser();
  const a = p.feed(`${osc("A")}$ ${osc("B")}${osc("E;ls;n")}${osc("C")}a.txt\r\n\x1b]63`);
  assert.deepEqual(a, [
    { kind: "event", event: { type: "promptStart" } },
    { kind: "data", text: "$ " },
    { kind: "event", event: { type: "commandStart" } },
    { kind: "event", event: { type: "commandLine", value: "ls", nonce: "n" } },
    { kind: "event", event: { type: "executed" } },
    { kind: "data", text: "a.txt\r\n" },
  ]);
  const b = p.feed("3;D;0\x1b\\fim\x1b");
  assert.deepEqual(b, [
    { kind: "event", event: { type: "finished", exitCode: 0 } },
    { kind: "data", text: "fim" },
  ]);
  // ESC sozinho no fim era só um ESC (cor ANSI): sai no próximo pedaço.
  assert.deepEqual(p.feed("[0m"), [{ kind: "data", text: "\x1b[0m" }]);
  // Outros OSC (título da janela) passam como dados.
  assert.deepEqual(p.feed("\x1b]0;título\x07x"), [{ kind: "data", text: "\x1b]0;título\x07x" }]);
});

test("terminalBridge: OSC 633 do PTY vira terminalShell no host (só com a integração pedida)", () => {
  __resetTerminalBridge();
  const sent: [string, Record<string, unknown>][] = [];
  configureTerminalBridge({ write: () => {}, notify: (m, p) => sent.push([m, p as Record<string, unknown>]) });
  handleTerminalEvent({ event: "terminalCreate", id: "t1", name: "Claude", shellIntegration: true }, () => {});
  handleTerminalEvent({ event: "terminalCreate", id: "t2", name: "Tarefa" }, () => {});
  ptyReady("ext-t1", 10);
  assert.deepEqual(sent.at(-1), ["terminalOpened", { id: "t1", pid: 10, shellIntegration: true }]);
  feedPtyData("ext-t2", osc("C"));
  assert.equal(sent.filter(([m]) => m === "terminalShell").length, 0);
  feedPtyData("ext-t1", `${osc("P;Cwd=/w")}${osc("A")}$ ${osc("E;make")}${osc("C")}ok\r\n`);
  feedPtyData("ext-t1", `${osc("D;2")}${osc("A")}$ `);
  assert.deepEqual(
    sent.filter(([m]) => m === "terminalShell").map(([, p]) => p),
    [
      { id: "t1", type: "ready" },
      { id: "t1", type: "cwd", cwd: "/w" },
      { id: "t1", type: "start", commandLine: "make" },
      { id: "t1", type: "data", data: "ok\r\n" },
      { id: "t1", type: "end", exitCode: 2 },
    ],
  );
  __resetTerminalBridge();
});
