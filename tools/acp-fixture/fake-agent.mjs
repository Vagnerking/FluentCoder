#!/usr/bin/env node
// Agente ACP FALSO (Agent Client Protocol, JSON-RPC 2.0 por stdio, NDJSON)
// para testar o cliente do Fluent Chat sem CLIs reais nem chamadas pagas.
//
// Usado por:
//   - `cargo test` (src-tauri/src/agents/acp.rs → fake_agent_end_to_end);
//   - `src/chat/acpFixture.test.ts` (protocolo cru);
//   - teste manual no app: `FLUENT_ACP_FAKE=1 npm run tauri dev` faz o
//     "Agente ACP de teste" aparecer no seletor de agentes do Fluent Chat.
//
// Comportamento (determinístico):
//   - initialize: loadSession=true, sem auth;
//   - session/new: devolve sessionId + configOptions (modos e modelos);
//   - session/load: reenvia um trecho de histórico (o cliente deve ignorar);
//   - session/prompt: pensa, "lê" um arquivo (tool_call read), e
//       * se o texto contém "editar": propõe uma edição (tool_call edit com
//         diff) e pede permissão; responde "permissão: <optionId|cancelled>";
//     ecoa "Recebido: <texto>", informa modo/mcp, reporta uso e encerra;
//       * se o texto contém "cliente": exercita as capacidades de CLIENTE
//         anunciadas no initialize — fs/write_text_file + fs/read_text_file
//         (com line/limit) num arquivo da pasta da sessão, e terminal/create →
//         wait_for_exit → output → release com um `node -e` que sai com 5;
//         responde "cliente: fs=<…> terminal=<…>";
//   - session/cancel: encerra o turno com stopReason "cancelled".
import readline from "node:readline";
import path from "node:path";

const sessions = new Map(); // sessionId -> { mode, model, mcp }
let nextSession = 1;
let nextRequest = 1000;
const pendingClientRequests = new Map(); // id -> resolve
let active = null; // { sessionId, cancelled, resolveCancel }
let clientCapabilities = {};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId, update) {
  send({ method: "session/update", params: { sessionId, update } });
}

function requestClient(method, params) {
  const id = nextRequest++;
  return new Promise((resolve) => {
    pendingClientRequests.set(id, resolve);
    send({ id, method, params });
  });
}

/** Pedido ao cliente que pode falhar: devolve { result } ou { error }. */
function requestClientRaw(method, params) {
  const id = nextRequest++;
  return new Promise((resolve) => {
    pendingClientRequests.set(id, (result, error) => resolve(error ? { error } : { result }));
    send({ id, method, params });
  });
}

/** Exercita fs/* e terminal/* do cliente (só o que ele anunciou). */
async function exerciseClient(sessionId, cwd) {
  const parts = [];
  if (clientCapabilities.fs?.readTextFile && clientCapabilities.fs?.writeTextFile) {
    const file = path.join(cwd, `fluent-acp-cliente-${process.pid}`, "notas.txt");
    const w = await requestClientRaw("fs/write_text_file", { sessionId, path: file, content: "linha 1\nlinha 2\nlinha 3\n" });
    const r = await requestClientRaw("fs/read_text_file", { sessionId, path: file, line: 2, limit: 1 });
    const outside = await requestClientRaw("fs/write_text_file", { sessionId, path: path.join(path.parse(cwd).root, "fluent-fora.txt"), content: "x" });
    parts.push(`fs=${w.error ? "erro" : "ok"}:${JSON.stringify(r.result?.content ?? r.error?.message)}:fora=${outside.error ? "recusado" : "aceito"}`);
  } else parts.push("fs=sem-capacidade");
  if (clientCapabilities.terminal) {
    const created = await requestClientRaw("terminal/create", {
      sessionId,
      command: process.execPath,
      args: ["-e", "console.log('do terminal ' + process.env.FLUENT_FAKE); process.exit(5)"],
      env: [{ name: "FLUENT_FAKE", value: "ok" }],
      cwd,
      outputByteLimit: 4096,
    });
    const terminalId = created.result?.terminalId;
    if (!terminalId) parts.push(`terminal=erro:${created.error?.message}`);
    else {
      const exit = await requestClientRaw("terminal/wait_for_exit", { sessionId, terminalId });
      let output = "";
      for (let i = 0; i < 50 && !output.includes("do terminal"); i++) {
        output = (await requestClientRaw("terminal/output", { sessionId, terminalId })).result?.output ?? "";
        if (!output.includes("do terminal")) await sleep(20);
      }
      await requestClientRaw("terminal/release", { sessionId, terminalId });
      parts.push(`terminal=exit:${exit.result?.exitCode}:${JSON.stringify(output.trim())}`);
    }
  } else parts.push("terminal=sem-capacidade");
  return `cliente: ${parts.join(" ")}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configOptions(state) {
  return [
    {
      id: "mode",
      name: "Modo",
      category: "mode",
      type: "select",
      currentValue: state.mode,
      options: [
        { value: "default", name: "Padrão" },
        { value: "read-only", name: "Somente leitura" },
        { value: "plan", name: "Planejar" },
        { value: "auto_edit", name: "Editar automaticamente" },
        { value: "yolo", name: "YOLO" },
      ],
    },
    {
      id: "model",
      name: "Modelo",
      category: "model",
      type: "select",
      currentValue: state.model,
      options: [
        { value: "fake-large", name: "Fake Large" },
        { value: "fake-small", name: "Fake Small" },
      ],
    },
  ];
}

async function prompt(id, params) {
  const { sessionId } = params;
  const state = sessions.get(sessionId);
  if (!state) {
    send({ id, error: { code: -32602, message: `sessão desconhecida: ${sessionId}` } });
    return;
  }
  const text = (params.prompt ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  active = { sessionId, cancelled: false };
  const finish = (stopReason) => {
    active = null;
    send({ id, result: { stopReason } });
  };

  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Analisando o pedido…" },
  });
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "read-1",
    title: "Ler README.md",
    kind: "read",
    status: "in_progress",
    locations: [{ path: "README.md", line: 1 }],
  });
  await sleep(5);
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "# Projeto" } }],
  });

  let permission = null;
  if (text.includes("editar")) {
    const toolCall = {
      toolCallId: "edit-1",
      title: "Editar notas.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path: "notas.txt" }],
      content: [{ type: "diff", path: "notas.txt", oldText: "antigo", newText: "novo" }],
    };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const response = await requestClient("session/request_permission", {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = response?.outcome;
    permission = outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: permission === "allow" || permission === "always" ? "completed" : "failed",
    });
  }

  const clientReport = text.includes("cliente") ? await exerciseClient(sessionId, state.cwd) : null;

  if (active?.cancelled || permission === "cancelled") {
    finish("cancelled");
    return;
  }

  const parts = [`Recebido: ${text}`];
  if (permission) parts.push(`permissão: ${permission}`);
  if (clientReport) parts.push(clientReport);
  parts.push(`modo=${state.mode}`);
  parts.push(`mcp=${state.mcp.join(",") || "nenhum"}`);
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: parts.join("\n") },
  });
  update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0.0012, currency: "USD" } });
  finish("end_turn");
}

function handle(message) {
  // Resposta a um pedido nosso (request_permission).
  if (message.id !== undefined && !message.method) {
    const resolve = pendingClientRequests.get(message.id);
    pendingClientRequests.delete(message.id);
    resolve?.(message.result ?? null, message.error);
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      clientCapabilities = params.clientCapabilities ?? {};
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
          agentInfo: { name: "fake-agent", title: "Agente ACP de teste", version: "1.0.0" },
          authMethods: [],
        },
      });
      return;
    case "session/new": {
      const sessionId = `fake-session-${nextSession++}`;
      const state = {
        mode: "default",
        model: "fake-large",
        mcp: (params.mcpServers ?? []).map((server) => server.name),
        cwd: params.cwd ?? process.cwd(),
      };
      sessions.set(sessionId, state);
      send({ id, result: { sessionId, configOptions: configOptions(state) } });
      return;
    }
    case "session/load": {
      const state = sessions.get(params.sessionId) ?? {
        mode: "default",
        model: "fake-large",
        mcp: (params.mcpServers ?? []).map((server) => server.name),
        cwd: params.cwd ?? process.cwd(),
      };
      sessions.set(params.sessionId, state);
      update(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "HISTÓRICO pergunta antiga" },
      });
      update(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "HISTÓRICO resposta antiga" },
      });
      send({ id, result: { configOptions: configOptions(state) } });
      return;
    }
    case "session/set_config_option": {
      const state = sessions.get(params.sessionId);
      if (state && params.configId === "mode") state.mode = params.value;
      if (state && params.configId === "model") state.model = params.value;
      send({ id, result: { configOptions: state ? configOptions(state) : [] } });
      return;
    }
    case "session/prompt":
      void prompt(id, params);
      return;
    case "session/cancel":
      if (active && active.sessionId === params.sessionId) active.cancelled = true;
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `método não suportado: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (error) {
    process.stderr.write(`[fake-agent] mensagem inválida: ${error}\n`);
  }
});
rl.on("close", () => process.exit(0));
