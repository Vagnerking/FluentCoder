import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRunOptions,
  buildAgentPrompt,
  capToolCall,
  EMPTY_AGENT_STORE,
  normalizeGlobalAgents,
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
    version: 2,
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

test("migra agents.json v1 → v2 sem perder dados", () => {
  const v1 = {
    version: 1,
    agents: [{ ...agent, model: "gpt-5.5" }],
    conversations: [
      {
        id: "conversation-1",
        agentId: agent.id,
        title: "Antiga",
        nativeSessionId: "thread-1",
        messages: [
          { id: "m1", role: "user", content: "Oi", createdAt: agent.createdAt, mode: "ask" },
          { id: "m2", role: "assistant", content: "Olá", createdAt: agent.createdAt, status: "done" },
        ],
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
    ],
  };
  const store = normalizeAgentStore(v1);
  assert.equal(store.version, 2);
  assert.deepEqual(store.agents[0], { ...agent, model: "gpt-5.5" });
  assert.equal(store.conversations[0].nativeSessionId, "thread-1");
  assert.equal(store.conversations[0].messages.length, 2);
  // Um store v1 válido sai idêntico, só com a versão nova.
  assert.deepEqual(store.conversations, v1.conversations);
});

test("v2 aceita provedores do registro e campos de agente personalizado", () => {
  const store = normalizeAgentStore({
    version: 2,
    agents: [
      {
        ...agent,
        id: "a2",
        provider: "gemini",
        description: "Revisor de PR",
        icon: "agentShield",
        defaultMode: "dev",
        contextPresets: ["graph", "invalido", "problems"],
        allowedTools: ["Read", "", 3],
        disallowedTools: [],
        networkAccess: true,
        scope: "workspace",
      },
      { ...agent, id: "a3", provider: "" },
    ],
    conversations: [
      {
        id: "c1",
        agentId: "provider:codex",
        title: "Direto",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "x",
            createdAt: "",
            toolCalls: [{ id: "t1", kind: "edit" }, { kind: "sem id" }],
            usage: { inputTokens: 3 },
          },
        ],
        createdAt: "",
        updatedAt: "",
      },
    ],
  });
  assert.equal(store.agents.length, 1, "provider vazio é descartado");
  const custom = store.agents[0];
  assert.equal(custom.provider, "gemini");
  assert.equal(custom.defaultMode, "bypass");
  assert.deepEqual(custom.contextPresets, ["graph", "problems"]);
  assert.deepEqual(custom.allowedTools, ["Read"]);
  assert.equal(custom.disallowedTools, undefined);
  assert.equal(custom.scope, undefined, "workspace é o padrão implícito");
  const message = store.conversations[0].messages[0];
  assert.deepEqual(message.toolCalls, [{ id: "t1", kind: "edit", textOffset: 0 }]);
  assert.deepEqual(message.usage, { inputTokens: 3 });
});

test("agentes globais vêm marcados com scope global", () => {
  const agents = normalizeGlobalAgents({ version: 2, agents: [agent, { nome: "lixo" }] });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].scope, "global");
  assert.deepEqual(normalizeGlobalAgents(null), []);
});

test("restrições do agente para o backend têm padrão seguro", () => {
  assert.deepEqual(agentRunOptions(null), { allowedTools: [], disallowedTools: [], networkAccess: false });
  assert.deepEqual(agentRunOptions({ allowedTools: ["Read"], networkAccess: true }), {
    allowedTools: ["Read"],
    disallowedTools: [],
    networkAccess: true,
  });
});

test("diffs enormes são cortados antes de persistir", () => {
  const call = capToolCall({
    id: "t",
    textOffset: 0,
    diffs: [{ path: "a", newText: "x".repeat(30_000) }],
  });
  assert.ok(call.diffs![0].newText!.length < 21_000);
  assert.ok(call.diffs![0].newText!.endsWith("…(truncado)"));
});
