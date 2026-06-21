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

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  status?: "streaming" | "done" | "error";
}

export interface AgentConversation {
  id: string;
  agentId: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
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
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
