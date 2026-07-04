export type AgentProviderId = "codex" | "claude";

export interface AgentDefinition {
  id: string;
  name: string;
  color: string;
  initialPrompt: string;
  provider: AgentProviderId;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentMessageRole = "user" | "assistant";

/**
 * Operating mode for a send, enforced client-side so it doesn't depend on each
 * provider's native modes:
 * - `ask`:  read-only. The agent may only answer; no file writes.
 * - `plan`: read-only for code, but may write `.md` plan files.
 * - `dev`:  read/write inside the workspace; native provider sandbox stays on.
 */
export type AgentMode = "ask" | "plan" | "dev";

export const AGENT_MODES: AgentMode[] = ["ask", "plan", "dev"];

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
}

export type AcpEvent =
  | { type: "text"; content: string }
  | { type: "status"; message: string }
  | { type: "session"; sessionId: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
