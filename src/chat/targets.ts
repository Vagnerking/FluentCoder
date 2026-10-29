/**
 * Alvos do seletor "provedor/agente" do composer: os provedores do registro
 * (chat direto, sem precisar criar agente) + os agentes personalizados.
 *
 * Uma conversa guarda o alvo em `agentId`: o id do agente personalizado ou
 * `provider:<id>` para o chat direto com um provedor.
 */
import { acpProvider, type ProviderStatus } from "../acp/providers/index.ts";
import type { AgentDefinition, AgentMode } from "../agents/types.ts";

export const PROVIDER_TARGET_PREFIX = "provider:";

export function providerTargetId(provider: string): string {
  return `${PROVIDER_TARGET_PREFIX}${provider}`;
}

export function isProviderTarget(targetId: string): boolean {
  return targetId.startsWith(PROVIDER_TARGET_PREFIX);
}

export interface ChatTarget {
  /** `provider:<id>` ou id do agente personalizado. */
  id: string;
  kind: "provider" | "agent";
  provider: string;
  label: string;
  description: string;
  /** IconAction do alvo. */
  icon: string;
  color?: string;
  /** Agente personalizado (ausente no chat direto). */
  agent?: AgentDefinition;
  installed: boolean;
  installHint: string;
  defaultMode?: AgentMode;
}

function providerInstalled(providers: ProviderStatus[], id: string): ProviderStatus | undefined {
  return providers.find((provider) => provider.id === id);
}

export function providerTarget(
  provider: string,
  providers: ProviderStatus[],
): ChatTarget {
  const status = providerInstalled(providers, provider);
  const definition = status ?? acpProvider(provider);
  return {
    id: providerTargetId(provider),
    kind: "provider",
    provider,
    label: definition.label,
    description: definition.description,
    icon: definition.icon,
    installed: status?.installed ?? false,
    installHint: definition.installHint,
  };
}

export function agentTarget(
  agent: AgentDefinition,
  providers: ProviderStatus[],
): ChatTarget {
  const status = providerInstalled(providers, agent.provider);
  const definition = status ?? acpProvider(agent.provider);
  return {
    id: agent.id,
    kind: "agent",
    provider: agent.provider,
    label: agent.name,
    description: agent.description?.trim() || `Agente personalizado · ${definition.label}`,
    icon: agent.icon || "agentHubot",
    color: agent.color,
    agent,
    installed: status?.installed ?? false,
    installHint: definition.installHint,
    defaultMode: agent.defaultMode,
  };
}

/**
 * Lista do seletor: provedores instalados primeiro (nativos antes dos ACP,
 * na ordem do registro), depois os não instalados, depois os agentes
 * personalizados.
 */
export function buildTargets(
  providers: ProviderStatus[],
  agents: AgentDefinition[],
): ChatTarget[] {
  const providerTargets = providers.map((provider) => providerTarget(provider.id, providers));
  const installed = providerTargets.filter((target) => target.installed);
  const missing = providerTargets.filter((target) => !target.installed);
  return [
    ...installed,
    ...missing,
    ...agents.map((agent) => agentTarget(agent, providers)),
  ];
}

/** Resolve o alvo de uma conversa (agente apagado ⇒ `null`). */
export function resolveTarget(
  targetId: string,
  providers: ProviderStatus[],
  agents: AgentDefinition[],
): ChatTarget | null {
  if (isProviderTarget(targetId)) {
    return providerTarget(targetId.slice(PROVIDER_TARGET_PREFIX.length), providers);
  }
  const agent = agents.find((candidate) => candidate.id === targetId);
  return agent ? agentTarget(agent, providers) : null;
}

/** Primeiro alvo utilizável: o último usado (se válido) ou o 1º instalado. */
export function defaultTargetId(
  targets: ChatTarget[],
  lastUsed: string | null,
): string {
  if (lastUsed && targets.some((target) => target.id === lastUsed)) return lastUsed;
  return (
    targets.find((target) => target.kind === "provider" && target.installed)?.id ??
    providerTargetId("claude")
  );
}
