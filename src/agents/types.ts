export type AgentProviderId = "codex" | "claude";

export interface AgentDefinition {
  id: string;
  name: string;
  color: string;
  initialPrompt: string;
  provider: AgentProviderId;
  /**
   * Modelo escolhido para o provedor (id do catálogo em `acp/providers`).
   * Opcional para compatibilidade com stores antigos — `undefined` cai no
   * modelo padrão do provedor via `acpResolveModel`.
   */
  model?: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentMessageRole = "user" | "assistant";

/**
 * Modo de permissão de um envio, espelhando os modos nativos do Claude Code e
 * mapeado para o equivalente de cada provedor (Claude: `--permission-mode`;
 * Codex: sandbox + approvalPolicy):
 * - `ask`:    somente leitura — o agente apenas responde.
 * - `plan`:   somente leitura — explora e apresenta um plano antes de editar.
 * - `edit`:   edita arquivos do workspace automaticamente.
 * - `auto`:   o agente escolhe o nível; escalações arriscadas são negadas.
 * - `bypass`: acesso total, sem confirmações.
 *
 * `dev` é o nome legado de `bypass` (persistido em stores antigos) e é
 * migrado na normalização.
 */
export type AgentMode = "ask" | "plan" | "edit" | "auto" | "bypass";

export const AGENT_MODES: AgentMode[] = [
  "ask",
  "plan",
  "edit",
  "auto",
  "bypass",
];

/** Modos que nunca alteram arquivos (sem snapshot de reversão no envio). */
export const READ_ONLY_MODES: ReadonlySet<AgentMode> = new Set([
  "ask",
  "plan",
]);

/** Converte um modo persistido (possivelmente legado) para o vocabulário atual. */
export function normalizeAgentMode(value: unknown): AgentMode | undefined {
  if (value === "dev") return "bypass";
  return AGENT_MODES.includes(value as AgentMode)
    ? (value as AgentMode)
    : undefined;
}

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  status?: "streaming" | "done" | "error";
  /** Mode the user message was sent with (only set on user messages). */
  mode?: AgentMode;
  /**
   * Git snapshot captured right before this user message ran, when the mode
   * could change files (plan/dev) and the workspace is a git repo. Lets the
   * user roll the working tree back to the pre-request state.
   */
  revert?: RevertPoint;
}

/** A restorable workspace snapshot taken before a write-capable request. */
export interface RevertPoint {
  /** Opaque git object id (from `git stash create`) holding the snapshot. */
  snapshotId: string;
  /** HEAD commit at snapshot time, for context/diagnostics. */
  head: string;
  /** True once the user has rolled back to this point. */
  reverted?: boolean;
}

export interface AgentConversation {
  id: string;
  agentId: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
  /**
   * Session/thread id da conversa no provedor (session do Claude Code, thread
   * do Codex). Permite retomar a conversa nativamente — sem reenviar o
   * histórico inteiro a cada reinício do app/processo.
   */
  nativeSessionId?: string;
}

export interface AgentStore {
  version: 1;
  agents: AgentDefinition[];
  conversations: AgentConversation[];
}

export type AgentSelection =
  | { kind: "config"; agentId: string | null }
  | { kind: "chat"; agentId: string; conversationId: string }
  | null;

export interface AgentDraft {
  id?: string;
  name: string;
  color: string;
  initialPrompt: string;
  provider: AgentProviderId;
  /** Modelo selecionado para o provedor (vazio ⇒ padrão do provedor). */
  model?: string;
}

/**
 * Trecho do editor anexado ao envio: o arquivo ativo e, opcionalmente, a
 * seleção atual. Espelha o comportamento do Claude Code (referencia o arquivo
 * aberto / a seleção junto do prompt).
 */
export interface AgentEditorContext {
  /** Caminho absoluto do arquivo ativo. */
  path: string;
  /** Nome do arquivo (para exibição na chip). */
  name: string;
  /** Texto selecionado, quando há uma seleção não vazia. */
  selectionText?: string;
  /** Primeira linha da seleção (1-based), quando há seleção. */
  startLine?: number;
  /** Última linha da seleção (1-based), quando há seleção. */
  endLine?: number;
}

export type AcpEvent =
  | { type: "text"; content: string }
  /** Delta do raciocínio do modelo — exibido ao vivo, nunca persistido. */
  | { type: "thought"; content: string }
  | { type: "status"; message: string }
  | { type: "session"; sessionId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
