// Extensão explícita: este import carrega valor em runtime e os testes rodam
// no Node com strip-types, que não resolve import sem extensão.
import {
  normalizeAgentMode,
  type AgentConversation,
  type AgentDefinition,
  type AgentEditorContext,
  type AgentMessage,
  type AgentStore,
} from "./types.ts";

export const EMPTY_AGENT_STORE: AgentStore = {
  version: 1,
  agents: [],
  conversations: [],
};

export function createLocalId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function normalizeAgentStore(value: unknown): AgentStore {
  if (!value || typeof value !== "object") return { ...EMPTY_AGENT_STORE };
  const candidate = value as Partial<AgentStore>;
  return {
    version: 1,
    agents: Array.isArray(candidate.agents)
      ? candidate.agents.filter(isAgentDefinition)
      : [],
    conversations: Array.isArray(candidate.conversations)
      ? candidate.conversations.filter(isConversation).map(normalizeConversation)
      : [],
  };
}

/**
 * Drops malformed messages so a single corrupt entry can't break the
 * conversation, e migra o modo legado `dev` → `bypass` nas mensagens salvas.
 */
function normalizeConversation(
  conversation: AgentConversation,
): AgentConversation {
  const messages = conversation.messages.filter(isMessage).map((message) => {
    const mode = normalizeAgentMode(message.mode);
    if (mode === message.mode) return message;
    if (mode === undefined) {
      const { mode: _dropped, ...rest } = message;
      return rest;
    }
    return { ...message, mode };
  });
  const untouched =
    messages.length === conversation.messages.length &&
    messages.every((message, index) => message === conversation.messages[index]);
  return untouched ? conversation : { ...conversation, messages };
}

/** Caminho do arquivo relativo ao workspace (com separador POSIX), p/ referências. */
function relativeToWorkspace(workspacePath: string, filePath: string): string {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const root = normalize(workspacePath).replace(/\/+$/, "");
  const target = normalize(filePath);
  if (root && target.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return target.slice(root.length + 1);
  }
  return target;
}

/**
 * Bloco de referência do editor anexado ao envio: o arquivo ativo e, quando há
 * seleção, o intervalo de linhas + o trecho selecionado num code fence. Espelha
 * o Claude Code, que injeta o arquivo/seleção aberto junto do prompt. Retorna
 * `""` quando não há contexto.
 */
export function formatEditorContextReference(
  workspacePath: string,
  context: AgentEditorContext | null | undefined,
): string {
  if (!context) return "";
  const rel = relativeToWorkspace(workspacePath, context.path);
  const hasSelection =
    context.selectionText != null &&
    context.startLine != null &&
    context.endLine != null;
  if (hasSelection) {
    const range =
      context.startLine === context.endLine
        ? `${context.startLine}`
        : `${context.startLine}-${context.endLine}`;
    return [
      "CONTEXTO DO EDITOR",
      `Arquivo em foco: \`${rel}\` (linhas ${range})`,
      "Trecho selecionado:",
      "```",
      context.selectionText,
      "```",
    ].join("\n");
  }
  return ["CONTEXTO DO EDITOR", `Arquivo em foco: \`${rel}\``].join("\n");
}

/**
 * Fallback de contexto completo, usado apenas quando a conversa ainda não tem
 * uma sessão nativa retomável no provedor (primeira mensagem, ou sessão nativa
 * perdida). Com sessão nativa, só a nova mensagem é enviada.
 *
 * Nenhum prompt de aplicativo é injetado antes do chat: os únicos prefixos
 * possíveis são o prompt inicial que o usuário definiu ao criar o agente e o
 * histórico da UI (reenviado só quando a sessão nativa se perdeu). Sem eles, a
 * mensagem vai crua ao provedor — permissões são responsabilidade das flags
 * nativas do CLI, não de texto no prompt.
 */
export function buildAgentPrompt(
  agent: AgentDefinition,
  messages: AgentMessage[],
  userMessage: string,
): string {
  const transcript = messages
    .filter((message) => message.content.trim())
    .map((message) =>
      `${message.role === "user" ? "Usuário" : "Agente"}: ${message.content}`,
    )
    .join("\n\n");

  const initialPrompt = agent.initialPrompt.trim();
  const message = userMessage.trim();
  if (!initialPrompt && !transcript) return message;
  return [
    initialPrompt ? `CONTEXTO INICIAL DO AGENTE\n${initialPrompt}` : "",
    transcript ? `HISTÓRICO DA CONVERSA\n${transcript}` : "",
    `NOVA MENSAGEM DO USUÁRIO\n${message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function replaceConversation(
  store: AgentStore,
  conversationId: string,
  update: (conversation: AgentConversation) => AgentConversation,
): AgentStore {
  return {
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === conversationId ? update(conversation) : conversation,
    ),
  };
}

function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (!value || typeof value !== "object") return false;
  const agent = value as AgentDefinition;
  return (
    typeof agent.id === "string" &&
    typeof agent.name === "string" &&
    typeof agent.color === "string" &&
    typeof agent.initialPrompt === "string" &&
    (agent.provider === "codex" || agent.provider === "claude") &&
    typeof agent.workspacePath === "string"
  );
}

function isConversation(value: unknown): value is AgentConversation {
  if (!value || typeof value !== "object") return false;
  const conversation = value as AgentConversation;
  return (
    typeof conversation.id === "string" &&
    typeof conversation.agentId === "string" &&
    typeof conversation.title === "string" &&
    Array.isArray(conversation.messages)
  );
}

function isMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as AgentMessage;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}
