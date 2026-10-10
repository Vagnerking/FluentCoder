import assert from "node:assert/strict";
import test from "node:test";
import { __resetTerminalBridge, configureTerminalBridge, handleTerminalEvent, ptyClosed, ptyReady, subscribeExtTerminals } from "./terminalBridge.ts";
import { __resetPseudoTerminals, pseudoAttach, pseudoInput, pseudoResize } from "./pseudoTerminal.ts";
import type { HostEvent } from "./protocol.ts";

test("pseudoterminal: aba sem PTY dirigida pelo host (escrita retida, entrada, resize, saída)", () => {
  __resetTerminalBridge();
  __resetPseudoTerminals();
  const sent: [string, unknown][] = [];
  configureTerminalBridge({ write: () => assert.fail("pseudo não escreve em PTY"), notify: (m, p) => sent.push([m, p]) });
  const actions: unknown[] = [];
  subscribeExtTerminals((a) => actions.push(a));
  handleTerminalEvent({ event: "terminalCreate", id: "t9", name: "Tarefa: Build", pseudo: true } as HostEvent, () => {});
  assert.deepEqual((actions[0] as { spec: { pseudo: boolean } }).spec.pseudo, true);
  // Escrita antes do xterm montar fica retida.
  handleTerminalEvent({ event: "terminalPtyWrite", id: "t9", data: "olá\r\n" } as HostEvent, () => {});
  const out: string[] = [];
  let exitCode: number | null | undefined;
  const detach = pseudoAttach("ext-t9", 80, 24, { write: (d) => out.push(d), exit: (c) => (exitCode = c) });
  assert.deepEqual(sent[0], ["terminalOpened", { id: "t9", cols: 80, rows: 24 }]);
  ptyReady("ext-t9", null);
  assert.equal(sent.length, 1, "ptyReady não duplica o terminalOpened do pseudo");
  assert.deepEqual(out, ["olá\r\n"]);
  handleTerminalEvent({ event: "terminalPtyWrite", id: "t9", data: "mais" } as HostEvent, () => {});
  assert.deepEqual(out, ["olá\r\n", "mais"]);
  pseudoInput("ext-t9", "l");
  pseudoResize("ext-t9", 100, 30);
  assert.deepEqual(sent.slice(1), [
    ["terminalInput", { id: "t9", data: "l" }],
    ["terminalResize", { id: "t9", cols: 100, rows: 30 }],
  ]);
  handleTerminalEvent({ event: "terminalRename", id: "t9", name: "Novo" } as HostEvent, () => {});
  assert.deepEqual(actions.at(-1), { type: "rename", ptyId: "ext-t9", name: "Novo" });
  // Tarefa: encerra e a aba fica (exited); entrada depois disso não vai ao host.
  handleTerminalEvent({ event: "terminalPtyExit", id: "t9", exitCode: 2, close: false } as HostEvent, () => {});
  assert.equal(exitCode, 2);
  assert.deepEqual(actions.at(-1), { type: "exited", ptyId: "ext-t9" });
  pseudoInput("ext-t9", "x");
  assert.equal(sent.length, 3);
  detach();
  ptyClosed("ext-t9", 2);
  assert.deepEqual(sent.at(-1), ["terminalClosed", { id: "t9", exitCode: 2 }]);
  // Terminal comum: pty encerrou → a aba fecha.
  handleTerminalEvent({ event: "terminalCreate", id: "t10", name: "P", pseudo: true } as HostEvent, () => {});
  handleTerminalEvent({ event: "terminalPtyExit", id: "t10", close: true } as HostEvent, () => {});
  assert.deepEqual(actions.at(-1), { type: "dispose", ptyId: "ext-t10" });
});
