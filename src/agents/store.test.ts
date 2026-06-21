import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentPrompt,
  EMPTY_AGENT_STORE,
  normalizeAgentStore,
  replaceConversation,
} from "./store.ts";
import type { AgentDefinition, AgentStore } from "./types.ts";

const agent: AgentDefinition = {
  id: "agent-1",
  name: "Revisor",
  color: "#60cdff",
  initialPrompt: "Revise o código com foco em segurança.",
  provider: "codex",
  workspacePath: "C:\\repo",
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
};

test("normaliza um arquivo de agentes inválido sem quebrar a UI", () => {
  assert.deepEqual(normalizeAgentStore(null), EMPTY_AGENT_STORE);
  assert.deepEqual(normalizeAgentStore({ agents: "x" }), EMPTY_AGENT_STORE);
});

test("o prompt inclui contexto, histórico e a fronteira do workspace", () => {
  const prompt = buildAgentPrompt(
    agent,
    [
      {
        id: "message-1",
        role: "assistant",
        content: "Encontrei um problema.",
        createdAt: agent.createdAt,
      },
    ],
    "Mostre a correção.",
  );

  assert.match(prompt, /Revise o código com foco em segurança/);
  assert.match(prompt, /C:\\repo/);
  assert.match(prompt, /Agente: Encontrei um problema/);
  assert.match(prompt, /NOVA MENSAGEM DO USUÁRIO\nMostre a correção/);
});

test("substitui apenas a conversa selecionada", () => {
  const store: AgentStore = {
    version: 1,
    agents: [agent],
    conversations: [
      {
        id: "conversation-1",
        agentId: agent.id,
        title: "Original",
        messages: [],
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
    ],
  };

  const next = replaceConversation(store, "conversation-1", (conversation) => ({
    ...conversation,
    title: "Atualizada",
  }));

  assert.equal(next.conversations[0]?.title, "Atualizada");
  assert.equal(store.conversations[0]?.title, "Original");
});
