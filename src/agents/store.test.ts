import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentPrompt,
  EMPTY_AGENT_STORE,
  formatEditorContextReference,
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

test("descarta mensagens malformadas sem perder a conversa", () => {
  const store = normalizeAgentStore({
    version: 1,
    agents: [agent],
    conversations: [
      {
        id: "conversation-1",
        agentId: agent.id,
        title: "Com lixo",
        messages: [
          {}, // malformada: sem id/role/content
          {
            id: "message-1",
            role: "user",
            content: "Mensagem válida.",
            createdAt: agent.createdAt,
          },
        ],
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
    ],
  });

  const conversation = store.conversations[0];
  assert.equal(store.conversations.length, 1);
  assert.equal(conversation?.messages.length, 1);
  assert.equal(conversation?.messages[0]?.content, "Mensagem válida.");

  // O prompt não deve lançar TypeError em message.content.trim().
  assert.doesNotThrow(() =>
    buildAgentPrompt(agent, conversation!.messages, "Continue."),
  );
});

test("o prompt inclui o prompt inicial do agente e o histórico", () => {
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

  assert.match(prompt, /CONTEXTO INICIAL DO AGENTE\nRevise o código com foco em segurança/);
  assert.match(prompt, /Agente: Encontrei um problema/);
  assert.match(prompt, /NOVA MENSAGEM DO USUÁRIO\nMostre a correção/);
});

test("sem prompt inicial nem histórico a mensagem vai crua, sem scaffolding", () => {
  const prompt = buildAgentPrompt(
    { ...agent, initialPrompt: "" },
    [],
    "Oi.",
  );

  // Nenhum prompt de aplicativo antes do chat: nada de seções, fronteira de
  // workspace ou <system-reminder> — permissões são flags nativas do CLI.
  assert.equal(prompt, "Oi.");
});

test("referência do editor com seleção traz caminho relativo, linhas e trecho", () => {
  const ref = formatEditorContextReference("C:\\repo", {
    path: "C:\\repo\\src\\Views\\Pdf.cshtml",
    name: "Pdf.cshtml",
    selectionText: "<style>\n  html { font-family: sans-serif; }\n</style>",
    startLine: 13,
    endLine: 16,
  });

  assert.match(ref, /CONTEXTO DO EDITOR/);
  // caminho relativo ao workspace, com separador POSIX
  assert.match(ref, /`src\/Views\/Pdf\.cshtml` \(linhas 13-16\)/);
  assert.match(ref, /font-family: sans-serif/);
});

test("referência do editor sem seleção cita só o arquivo em foco", () => {
  const ref = formatEditorContextReference("C:\\repo", {
    path: "C:\\repo\\src\\App.tsx",
    name: "App.tsx",
  });

  assert.match(ref, /Arquivo em foco: `src\/App\.tsx`/);
  assert.doesNotMatch(ref, /linhas/);
  assert.doesNotMatch(ref, /Trecho selecionado/);
});

test("uma única linha selecionada não vira intervalo", () => {
  const ref = formatEditorContextReference("C:\\repo", {
    path: "C:\\repo\\a.ts",
    name: "a.ts",
    selectionText: "const x = 1;",
    startLine: 42,
    endLine: 42,
  });

  assert.match(ref, /\(linhas 42\)/);
});

test("sem contexto anexado a referência é vazia", () => {
  assert.equal(formatEditorContextReference("C:\\repo", null), "");
  assert.equal(formatEditorContextReference("C:\\repo", undefined), "");
});

test("migra o modo legado `dev` das mensagens salvas para `bypass`", () => {
  const store = normalizeAgentStore({
    version: 1,
    agents: [agent],
    conversations: [
      {
        id: "conversation-1",
        agentId: agent.id,
        title: "Legada",
        messages: [
          {
            id: "message-1",
            role: "user",
            content: "Implemente X.",
            createdAt: agent.createdAt,
            mode: "dev",
          },
          {
            id: "message-2",
            role: "user",
            content: "Explique Y.",
            createdAt: agent.createdAt,
            mode: "ask",
          },
        ],
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
    ],
  });

  const messages = store.conversations[0]!.messages;
  assert.equal(messages[0]?.mode, "bypass");
  assert.equal(messages[1]?.mode, "ask");
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
