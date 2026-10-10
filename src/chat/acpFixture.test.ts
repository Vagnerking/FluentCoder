/**
 * Contrato do agente ACP falso (tools/acp-fixture/fake-agent.mjs) no nível do
 * protocolo: garante que o fixture usado pelo `cargo test` (cliente Rust) e
 * pelo teste manual (`FLUENT_ACP_FAKE=1`) fala ACP como os CLIs reais.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../tools/acp-fixture/fake-agent.mjs", import.meta.url));

type Message = Record<string, any>;

function connect() {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "inherit"] });
  const queue: Message[] = [];
  const waiters: ((message: Message) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const next = () =>
    new Promise<Message>((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });
  let id = 0;
  const send = (message: Message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = async (method: string, params: Message, onMessage?: (message: Message) => void) => {
    const requestId = ++id;
    send({ id: requestId, method, params });
    for (;;) {
      const message = await next();
      if (message.id === requestId && !message.method) return message;
      onMessage?.(message);
    }
  };
  return { child, send, request };
}

test("fixture ACP: initialize → session/new → prompt com permissão", async () => {
  const { child, send, request } = connect();
  try {
    const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(init.result.protocolVersion, 1);
    assert.equal(init.result.agentCapabilities.loadSession, true);

    const session = await request("session/new", {
      cwd: "/tmp",
      mcpServers: [{ name: "fluent-knowledge", command: "x", args: [], env: [] }],
    });
    const sessionId = session.result.sessionId as string;
    assert.ok(sessionId);
    assert.ok(session.result.configOptions.some((option: Message) => option.category === "mode"));

    const updates: string[] = [];
    let text = "";
    const response = await request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: "editar notas" }] },
      (message) => {
        if (message.method === "session/update") {
          const update = message.params.update;
          updates.push(update.sessionUpdate);
          if (update.sessionUpdate === "agent_message_chunk") text += update.content.text;
        } else if (message.method === "session/request_permission") {
          assert.deepEqual(
            message.params.options.map((option: Message) => option.kind),
            ["allow_once", "allow_always", "reject_once"],
          );
          assert.equal(message.params.toolCall.content[0].type, "diff");
          send({ id: message.id, result: { outcome: { outcome: "selected", optionId: "always" } } });
        }
      },
    );
    assert.equal(response.result.stopReason, "end_turn");
    assert.ok(updates.includes("agent_thought_chunk"));
    assert.ok(updates.includes("tool_call"));
    assert.ok(updates.includes("tool_call_update"));
    assert.ok(updates.includes("usage_update"));
    assert.match(text, /Recebido: editar notas/);
    assert.match(text, /permissão: always/);
    assert.match(text, /mcp=fluent-knowledge/);
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test("fixture ACP: session/cancel encerra o turno como cancelled", async () => {
  const { child, send, request } = connect();
  try {
    await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const { result } = await request("session/new", { cwd: "/tmp", mcpServers: [] });
    const response = await request(
      "session/prompt",
      { sessionId: result.sessionId, prompt: [{ type: "text", text: "editar" }] },
      (message) => {
        if (message.method === "session/request_permission") {
          send({ method: "session/cancel", params: { sessionId: result.sessionId } });
          send({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
        }
      },
    );
    assert.equal(response.result.stopReason, "cancelled");
  } finally {
    child.stdin.end();
    child.kill();
  }
});
