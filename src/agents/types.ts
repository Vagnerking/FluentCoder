/**
 * Id de um provedor do Fluent Chat (registro do backend: `claude`, `codex`,
 * `gemini`, `opencode`, `qwen`, `copilot`, `goose`…). String livre para que
 * novos CLIs entrem pelo registro sem mudar tipos.
 */
export type AgentProviderId = string;

/** Contexto que um agente personalizado anexa sempre (preset). */
export type ContextPreset = "graph" | "context" | "workspace" | "problems" | "selection";

export const CONTEXT_PRESETS: ContextPreset[] = [
  "graph",
  "context",
  "workspace",
  "problems",
  "selection",
];

export interface AgentDefinition {
  id: string;
  name: string;
  color: string;
  /**
   * Instruções do agente (prompt inicial definido pelo USUÁRIO). Vai apenas no
   * `contextPrompt` de sessão nova — nunca um prompt de aplicativo.
   */
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
  /** Descrição curta exibida no seletor e na lista de agentes (v2). */
  description?: string;
  /** Codicon do agente (v2). */
  icon?: string;
  /** Modo aplicado ao escolher o agente no composer (v2). */
  defaultMode?: AgentMode;
  /** Contexto anexado automaticamente a cada envio (v2). */
  contextPresets?: ContextPreset[];
  /** Claude: `--allowedTools` (v2). */
  allowedTools?: string[];
  /** Claude: `--disallowedTools` (v2). */
  disallowedTools?: string[];
  /** Codex: rede liberada no sandbox `workspace-write` (v2). */
  networkAccess?: boolean;
  /** Onde o agente vive: no workspace (`.project/agents.json`) ou global (v2). */
  scope?: "workspace" | "global";
}

export type AgentMessageRole = "user" | "assistant";

/**
 * Modo de permissão de um envio, espelhando os modos nativos do Claude Code e
 * mapeado para o equivalente de cada provedor (Claude: `--permission-mode`;
 * Codex: sandbox + approvalPolicy; ACP: modo nativo + política de aprovação).
 * Na UI (estilo Copilot): Perguntar, Planejar, Editar, Agente, Bypass.
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

/** Diff de arquivo reportado por uma ferramenta (Edit/Write, fileChange, ACP). */
export interface ChatFileDiff {
  path: string;
  oldText?: string;
  newText?: string;
  /** Patch unificado (Codex), quando não há os textos completos. */
  unified?: string;
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Uma chamada de ferramenta no transcript (cartão colapsável). */
export interface ChatToolCall {
  id: string;
  kind?: string;
  title?: string;
  status?: ToolCallStatus;
  detail?: string;
  output?: string;
  locations?: string[];
  diffs?: ChatFileDiff[];
  /** Posição no texto da resposta onde a chamada aconteceu (intercalação). */
  textOffset: number;
}

/** Consumo de um turno, quando o provedor reporta. */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  contextWindow?: number;
  contextUsed?: number;
}

/** Chip de contexto exibido na mensagem do usuário (só o rótulo). */
export interface ChatAttachmentLabel {
  kind: string;
  label: string;
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
   * could change files and the workspace is a git repo. Lets the user roll
   * the working tree back to the pre-request state.
   */
  revert?: RevertPoint;
  /** Contexto anexado ao envio (mensagens do usuário, v2). */
  attachments?: ChatAttachmentLabel[];
  /** Chamadas de ferramenta da resposta (mensagens do agente, v2). */
  toolCalls?: ChatToolCall[];
  /** Consumo do turno (mensagens do agente, v2). */
  usage?: ChatUsage;
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
  /**
   * Alvo da conversa: id de um agente personalizado ou `provider:<id>` para o
   * chat direto com um provedor (zero-setup, v2).
   */
  agentId: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
  /**
   * Session/thread id da conversa no provedor (session do Claude Code, thread
   * do Codex, sessão ACP). Permite retomar a conversa nativamente — sem
   * reenviar o histórico inteiro a cada reinício do app/processo.
   */
  nativeSessionId?: string;
}

export const AGENT_STORE_VERSION = 2;

export interface AgentStore {
  version: typeof AGENT_STORE_VERSION;
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
  description?: string;
  icon?: string;
  defaultMode?: AgentMode;
  contextPresets?: ContextPreset[];
  allowedTools?: string[];
  disallowedTools?: string[];
  networkAccess?: boolean;
  scope?: "workspace" | "global";
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

export interface ApprovalOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export type AcpEvent =
  | { type: "text"; content: string }
  /** Delta do raciocínio do modelo — exibido ao vivo, nunca persistido. */
  | { type: "thought"; content: string }
  | { type: "status"; message: string }
  | { type: "session"; sessionId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string }
  | ({ type: "toolCall" } & Omit<ChatToolCall, "textOffset">)
  | {
      type: "approval";
      requestId: string;
      title: string;
      detail?: string;
      toolKind: string;
      options: ApprovalOption[];
      diffs?: ChatFileDiff[];
    }
  | { type: "approvalResolved"; requestId: string }
  | ({ type: "usage" } & ChatUsage)
  | { type: "models"; models: { id: string; label: string }[]; current?: string };

/** Pedido de aprovação pendente (efêmero, fora do store). */
export interface ChatApproval {
  conversationId: string;
  requestId: string;
  title: string;
  detail?: string;
  toolKind: string;
  options: ApprovalOption[];
  diffs?: ChatFileDiff[];
}

/** Restrições do agente passadas ao backend (`RunOptions` no Rust). */
export interface AgentRunOptions {
  allowedTools: string[];
  disallowedTools: string[];
  networkAccess: boolean;
}
