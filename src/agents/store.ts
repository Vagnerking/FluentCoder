import type {
  AgentConversation,
  AgentDefinition,
  AgentMessage,
  AgentStore,
} from "./types";

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

/** Drops malformed messages so a single corrupt entry can't break the conversation. */
function normalizeConversation(
  conversation: AgentConversation,
): AgentConversation {
  const messages = conversation.messages.filter(isMessage);
  return messages.length === conversation.messages.length
    ? conversation
    : { ...conversation, messages };
}

/**
 * Fallback de contexto completo, usado apenas quando a conversa ainda não tem
 * uma sessão nativa retomável no provedor (primeira mensagem, ou sessão nativa
 * perdida). Com sessão nativa, só a nova mensagem é enviada.
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
  return [
    initialPrompt ? `CONTEXTO INICIAL DO AGENTE\n${initialPrompt}\n` : "",
    "RESTRIÇÃO OBRIGATÓRIA DE WORKSPACE",
    `Trabalhe somente dentro deste workspace: ${agent.workspacePath}`,
    "Não solicite, leia ou infira conteúdo de paths externos ao workspace.",
    transcript ? `\nHISTÓRICO DA CONVERSA\n${transcript}` : "",
    `\nNOVA MENSAGEM DO USUÁRIO\n${userMessage.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
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
