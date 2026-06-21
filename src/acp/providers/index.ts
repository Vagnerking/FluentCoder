import type { AgentProviderId } from "../../agents/types";

export interface AcpProviderDefinition {
  id: AgentProviderId;
  label: string;
  description: string;
}

/**
 * Registro plugável de provedores ACP. Novos adaptadores entram aqui sem
 * alterar os formulários ou o painel de agentes.
 */
export const ACP_PROVIDERS: Record<AgentProviderId, AcpProviderDefinition> = {
  codex: {
    id: "codex",
    label: "Codex",
    description: "Codex CLI via adaptador ACP oficial do ecossistema.",
  },
  claude: {
    id: "claude",
    label: "Claude",
    description: "Claude Agent via adaptador ACP oficial do ecossistema.",
  },
};

export function acpProviders(): AcpProviderDefinition[] {
  return Object.values(ACP_PROVIDERS);
}

export function acpProvider(id: AgentProviderId): AcpProviderDefinition {
  return ACP_PROVIDERS[id];
}
