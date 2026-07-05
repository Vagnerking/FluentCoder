import type { AgentProviderId } from "../../agents/types";

/** Um modelo selecionável de um provedor (id = valor passado ao CLI). */
export interface AcpModelDefinition {
  /** Id enviado ao CLI (`--model` no Claude, `model` no Codex). */
  id: string;
  /** Nome curto exibido no seletor. */
  label: string;
  /** Descrição de uma linha (velocidade × capacidade). */
  hint: string;
}

export interface AcpProviderDefinition {
  id: AgentProviderId;
  label: string;
  description: string;
  /** Modelos oferecidos pelo provedor; o primeiro é o padrão. */
  models: AcpModelDefinition[];
}

/**
 * Registro plugável de provedores ACP. Novos adaptadores entram aqui sem
 * alterar os formulários ou o painel de agentes.
 *
 * ATENÇÃO — ids de modelo são validados contra os CLIs reais e regridem quando
 * os provedores atualizam a linha de modelos (um id removido faz o turno
 * falhar). Como validar:
 * - Codex: `codex app-server` → request `model/list` (ids/labels/descrições
 *   vêm de lá; validado no CLI 0.136.0).
 * - Claude: `--model` aceita o nome completo do modelo (ids da família atual;
 *   validado no CLI 2.1.162).
 * Ids antigos persistidos em agents.json caem no padrão via `acpResolveModel`.
 */
export const ACP_PROVIDERS: Record<AgentProviderId, AcpProviderDefinition> = {
  codex: {
    id: "codex",
    label: "Codex",
    description: "Agente de código da OpenAI.",
    models: [
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        hint: "Modelo de fronteira para código complexo, pesquisa e trabalho real.",
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        hint: "Modelo forte para o código do dia a dia.",
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        hint: "Pequeno, rápido e econômico para tarefas simples.",
      },
    ],
  },
  claude: {
    id: "claude",
    label: "Claude",
    description: "Agente de código da Anthropic.",
    models: [
      {
        id: "claude-opus-4-8",
        label: "Opus 4.8",
        hint: "Máxima capacidade para tarefas complexas.",
      },
      {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        hint: "Equilíbrio entre qualidade e velocidade.",
      },
      {
        id: "claude-haiku-4-5",
        label: "Haiku 4.5",
        hint: "Mais rápido e econômico para respostas curtas.",
      },
    ],
  },
};

export function acpProviders(): AcpProviderDefinition[] {
  return Object.values(ACP_PROVIDERS);
}

export function acpProvider(id: AgentProviderId): AcpProviderDefinition {
  return ACP_PROVIDERS[id];
}

/** Modelos disponíveis para um provedor (o primeiro é o padrão). */
export function acpModels(id: AgentProviderId): AcpModelDefinition[] {
  return ACP_PROVIDERS[id].models;
}

/** Modelo padrão de um provedor (o primeiro do catálogo). */
export function acpDefaultModel(id: AgentProviderId): string {
  return ACP_PROVIDERS[id].models[0].id;
}

/**
 * Resolve o modelo efetivo de um agente: o salvo, se ainda existir no catálogo
 * do provedor; senão o padrão. Blinda contra ids antigos/removidos.
 */
export function acpResolveModel(
  provider: AgentProviderId,
  model: string | undefined,
): string {
  const catalog = ACP_PROVIDERS[provider].models;
  if (model && catalog.some((candidate) => candidate.id === model)) {
    return model;
  }
  return catalog[0].id;
}
