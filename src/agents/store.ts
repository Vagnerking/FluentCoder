// Extensão explícita: este import carrega valor em runtime e os testes rodam
// no Node com strip-types, que não resolve import sem extensão.
import {
  AGENT_STORE_VERSION,
  CONTEXT_PRESETS,
  normalizeAgentMode,
  type AgentConversation,
  type AgentDefinition,
  type AgentEditorContext,
  type AgentMessage,
  type AgentRunOptions,
  type AgentStore,
  type ChatToolCall,
  type ContextPreset,
} from "./types.ts";

export const EMPTY_AGENT_STORE: AgentStore = {
  version: AGENT_STORE_VERSION,
  agents: [],
  conversations: [],
};

/** Teto de caracteres por texto de diff persistido (o `agents.json` não incha). */
const MAX_DIFF_CHARS = 20_000;

export function createLocalId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

/**
 * Normaliza (e migra) o `.project/agents.json`.
 *
 * - v1 → v2: o `provider` deixa de ser só `codex|claude` (registro multi-CLI);
 *   agentes ganham campos opcionais (descrição, ícone, modo padrão, presets de
 *   contexto, ferramentas, rede); conversas podem apontar para um provedor
 *   direto (`provider:<id>`); mensagens ganham `toolCalls`/`usage`/
 *   `attachments`. Nada é removido de um v1 válido — a migração é aditiva.
 * - Entradas malformadas são descartadas sem derrubar o resto.
 */
export function normalizeAgentStore(value: unknown): AgentStore {
  if (!value || typeof value !== "object") return { ...EMPTY_AGENT_STORE };
  const candidate = value as Partial<AgentStore>;
  return {
    version: AGENT_STORE_VERSION,
    agents: Array.isArray(candidate.agents)
      ? candidate.agents.filter(isAgentDefinition).map(normalizeAgent)
      : [],
    conversations: Array.isArray(candidate.conversations)
      ? candidate.conversations.filter(isConversation).map(normalizeConversation)
      : [],
  };
}

/** Agentes globais (dados do app): mesmo formato, sem conversas. */
export function normalizeGlobalAgents(value: unknown): AgentDefinition[] {
  if (!value || typeof value !== "object") return [];
  const agents = (value as { agents?: unknown }).agents;
  return Array.isArray(agents)
    ? agents
        .filter(isAgentDefinition)
        .map((agent) => ({ ...normalizeAgent(agent), scope: "global" as const }))
    : [];
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function normalizeAgent(agent: AgentDefinition): AgentDefinition {
  const next: AgentDefinition = { ...agent };
  const mode = normalizeAgentMode(agent.defaultMode);
  if (mode) next.defaultMode = mode;
  else delete next.defaultMode;
  const presets = Array.isArray(agent.contextPresets)
    ? agent.contextPresets.filter((preset): preset is ContextPreset =>
        CONTEXT_PRESETS.includes(preset),
      )
    : [];
  if (presets.length) next.contextPresets = presets;
  else delete next.contextPresets;
  const allowed = stringList(agent.allowedTools);
  if (allowed) next.allowedTools = allowed;
  else delete next.allowedTools;
  const disallowed = stringList(agent.disallowedTools);
  if (disallowed) next.disallowedTools = disallowed;
  else delete next.disallowedTools;
  if (typeof agent.description !== "string") delete next.description;
  if (typeof agent.icon !== "string") delete next.icon;
  if (typeof agent.networkAccess !== "boolean") delete next.networkAccess;
  if (agent.scope !== "global") delete next.scope;
  return next;
}

function capText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_DIFF_CHARS
    ? `${value.slice(0, MAX_DIFF_CHARS)}\n…(truncado)`
    : value;
}

function normalizeToolCalls(value: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.filter(
    (call): call is ChatToolCall =>
      !!call &&
      typeof call === "object" &&
      typeof (call as ChatToolCall).id === "string",
  );
  return calls.length
    ? calls.map((call) => ({
        ...call,
        textOffset:
          typeof call.textOffset === "number" && call.textOffset >= 0
            ? call.textOffset
            : 0,
      }))
    : undefined;
}

/**
 * Drops malformed messages so a single corrupt entry can't break the
 * conversation, e migra o modo legado `dev` → `bypass` nas mensagens salvas.
 */
function normalizeConversation(
  conversation: AgentConversation,
): AgentConversation {
  const messages = conversation.messages.filter(isMessage).map((message) => {
    let next = message;
    const mode = normalizeAgentMode(message.mode);
    if (mode !== message.mode) {
      if (mode === undefined) {
        const { mode: _dropped, ...rest } = message;
        next = rest;
      } else {
        next = { ...message, mode };
      }
    }
    if (message.toolCalls !== undefined) {
      const toolCalls = normalizeToolCalls(message.toolCalls);
      if (toolCalls) next = { ...next, toolCalls };
      else {
        const { toolCalls: _dropped, ...rest } = next;
        next = rest;
      }
    }
    return next;
  });
  const untouched =
    messages.length === conversation.messages.length &&
    messages.every((message, index) => message === conversation.messages[index]);
  return untouched ? conversation : { ...conversation, messages };
}

/** Limita diffs grandes (ex.: `Write` de um arquivo inteiro) antes de persistir. */
export function capToolCall(call: ChatToolCall): ChatToolCall {
  if (!call.diffs?.length) return call;
  return {
    ...call,
    diffs: call.diffs.map((diff) => ({
      ...diff,
      oldText: capText(diff.oldText),
      newText: capText(diff.newText),
      unified: capText(diff.unified),
    })),
  };
}

/** Caminho do arquivo relativo ao workspace (com separador POSIX), p/ referências. */
export function relativeToWorkspace(workspacePath: string, filePath: string): string {
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
 * possíveis são as instruções que o usuário definiu no agente e o histórico da
 * UI (reenviado só quando a sessão nativa se perdeu). Sem eles, a mensagem vai
 * crua ao provedor — permissões são responsabilidade das flags nativas do CLI,
 * não de texto no prompt.
 */
export function buildAgentPrompt(
  agent: Pick<AgentDefinition, "initialPrompt">,
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

/** Restrições do agente para o backend (`RunOptions`). */
export function agentRunOptions(
  agent: Pick<AgentDefinition, "allowedTools" | "disallowedTools" | "networkAccess"> | null,
): AgentRunOptions {
  return {
    allowedTools: agent?.allowedTools ?? [],
    disallowedTools: agent?.disallowedTools ?? [],
    networkAccess: agent?.networkAccess ?? false,
  };
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
    typeof agent.provider === "string" &&
    agent.provider.trim() !== "" &&
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
