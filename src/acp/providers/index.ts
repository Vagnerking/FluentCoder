import type { AgentProviderId } from "../../agents/types";

/** Um modelo selecionável de um provedor (id = valor passado ao CLI). */
export interface AcpModelDefinition {
  /** Id enviado ao CLI (`--model` no Claude, `model` no Codex, ACP set_model). */
  id: string;
  /** Nome curto exibido no seletor. */
  label: string;
  /** Descrição de uma linha (velocidade × capacidade). */
  hint: string;
}

/** Protocolo de integração (espelha `ProviderProtocol` do backend). */
export type ProviderProtocol = "claude-stream-json" | "codex-app-server" | "acp";

export interface AcpProviderDefinition {
  id: AgentProviderId;
  label: string;
  description: string;
  protocol: ProviderProtocol;
  /** Codicon do provedor no seletor. */
  icon: string;
  /** Modelos oferecidos pelo provedor; o primeiro é o padrão. */
  models: AcpModelDefinition[];
  /** Como instalar o CLI (exibido quando ele não está no PATH). */
  installHint: string;
  docsUrl: string;
  /** Integração em prévia (flag/protocolo experimental no CLI). */
  preview: boolean;
}

/** Provedor + disponibilidade (status vindo do backend `chat_providers`). */
export interface ProviderStatus extends AcpProviderDefinition {
  installed: boolean;
}

/** Item "modelo padrão" para provedores sem catálogo (ACP). */
export const DEFAULT_MODEL: AcpModelDefinition = {
  id: "",
  label: "Padrão do agente",
  hint: "Usa o modelo configurado no próprio CLI.",
};

/**
 * Catálogo estático dos provedores conhecidos. O backend (`chat_providers`) é
 * a fonte da verdade de quais existem e estão instalados; este catálogo dá
 * rótulos/modelos quando o backend ainda não respondeu (ou em testes).
 *
 * ATENÇÃO — ids de modelo são validados contra os CLIs reais e regridem quando
 * os provedores atualizam a linha de modelos (um id removido faz o turno
 * falhar). Como validar (sem custo):
 * - Codex: `codex app-server` → request `model/list` (validado no 0.162.1);
 * - Claude: `claude -p --input-format stream-json --output-format stream-json
 *   --verbose --permission-prompt-tool stdio` + `control_request` `initialize`
 *   → campo `models[].value` (validado no 2.1.296). Usamos os aliases do
 *   próprio seletor do CLI (`opus`, `sonnet`…), estáveis entre versões.
 * - Agentes ACP: os modelos chegam por sessão (`session/new.models` /
 *   `configOptions` de categoria `model`) e são mesclados em runtime.
 * Ids antigos persistidos em agents.json caem no padrão via `acpResolveModel`.
 */
export const ACP_PROVIDERS: Record<string, AcpProviderDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    description: "Agente de código da Anthropic.",
    protocol: "claude-stream-json",
    icon: "sparkle",
    installHint: "npm install -g @anthropic-ai/claude-code",
    docsUrl: "https://docs.claude.com/en/docs/claude-code",
    preview: false,
    models: [
      { id: "opus", label: "Opus 5.5", hint: "Para trabalho complexo e o dia a dia." },
      { id: "fable", label: "Fable 5.1", hint: "Para os desafios mais difíceis." },
      { id: "sonnet", label: "Sonnet 5.5", hint: "Mais eficiente para tarefas simples." },
      { id: "haiku", label: "Haiku 5.5", hint: "O mais rápido para respostas curtas." },
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    description: "Agente de código da OpenAI.",
    protocol: "codex-app-server",
    icon: "agents",
    installHint: "npm install -g @openai/codex",
    docsUrl: "https://developers.openai.com/codex/cli",
    preview: false,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", hint: "Modelo mais recente para código e o dia a dia." },
      { id: "gpt-6-astra", label: "GPT-6-Astra", hint: "Inteligência de fronteira para o trabalho mais exigente." },
      { id: "gpt-6-sol", label: "GPT-6-Sol", hint: "Geração anterior do modelo de trabalho." },
      { id: "gpt-6-luna", label: "GPT-6-Luna", hint: "Rápido e econômico para tarefas simples." },
    ],
  },
  gemini: acp("gemini", "Gemini CLI", "Agente de código do Google (Gemini).", "npm install -g @google/gemini-cli", "https://geminicli.com/docs/cli/acp-mode/"),
  copilot: acp("copilot", "GitHub Copilot CLI", "Agente do GitHub Copilot no terminal.", "npm install -g @github/copilot", "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server"),
  opencode: acp("opencode", "opencode", "Agente de código aberto multi-provedor.", "npm install -g opencode-ai", "https://opencode.ai/docs/acp/"),
  qwen: acp("qwen", "Qwen Code", "Agente de código da Alibaba (Qwen).", "npm install -g @qwen-code/qwen-code", "https://github.com/QwenLM/qwen-code"),
  goose: acp("goose", "Goose", "Agente de código aberto da Block.", "brew install block-goose-cli", "https://block.github.io/goose/"),
  kimi: acp("kimi", "Kimi CLI", "Agente de código da Moonshot AI.", "uv tool install kimi-cli", "https://github.com/MoonshotAI/kimi-cli"),
  auggie: acp("auggie", "Augment (auggie)", "Agente de código da Augment.", "npm install -g @augmentcode/auggie", "https://docs.augmentcode.com/cli/acp"),
  "cursor-agent": acp("cursor-agent", "Cursor Agent", "Agente de código do Cursor no terminal.", "curl https://cursor.com/install -fsS | bash", "https://cursor.com/cli"),
};

function acp(
  id: string,
  label: string,
  description: string,
  installHint: string,
  docsUrl: string,
): AcpProviderDefinition {
  return {
    id,
    label,
    description,
    protocol: "acp",
    icon: "robot",
    installHint,
    docsUrl,
    preview: true,
    models: [],
  };
}

/** Provedores nativos (sempre listados, mesmo antes do backend responder). */
export const NATIVE_PROVIDER_IDS = ["claude", "codex"];

export function acpProviders(): AcpProviderDefinition[] {
  return Object.values(ACP_PROVIDERS);
}

/**
 * Definição de um provedor; ids desconhecidos (vindos de um backend mais novo
 * ou de um store antigo) viram um provedor ACP genérico, sem quebrar a UI.
 */
export function acpProvider(id: AgentProviderId): AcpProviderDefinition {
  return ACP_PROVIDERS[id] ?? acp(id, id, "Agente compatível com ACP.", "", "");
}

/**
 * Funde o status do backend com o catálogo estático (rótulos/modelos locais
 * prevalecem; disponibilidade e dicas vêm do backend).
 */
export function mergeProviderStatuses(
  statuses: Partial<ProviderStatus>[],
): ProviderStatus[] {
  return statuses
    .filter((status): status is Partial<ProviderStatus> & { id: string } =>
      typeof status.id === "string",
    )
    .map((status) => {
      const known = ACP_PROVIDERS[status.id];
      const base = known ?? acpProvider(status.id);
      return {
        ...base,
        label: known?.label ?? status.label ?? base.label,
        description: known?.description ?? status.description ?? base.description,
        installHint: status.installHint || base.installHint,
        docsUrl: status.docsUrl || base.docsUrl,
        protocol: (status.protocol as ProviderProtocol) ?? base.protocol,
        preview: status.preview ?? base.preview,
        installed: status.installed === true,
      };
    });
}

/** Modelos disponíveis para um provedor (o primeiro é o padrão). */
export function acpModels(
  id: AgentProviderId,
  dynamic?: AcpModelDefinition[],
): AcpModelDefinition[] {
  const catalog = acpProvider(id).models;
  if (catalog.length) return catalog;
  return [DEFAULT_MODEL, ...(dynamic ?? [])];
}

/** Modelo padrão de um provedor (o primeiro do catálogo; `""` = padrão do CLI). */
export function acpDefaultModel(id: AgentProviderId): string {
  return acpModels(id)[0].id;
}

/**
 * Resolve o modelo efetivo de um agente: o salvo, se ainda existir no catálogo
 * do provedor; senão o padrão. Blinda contra ids antigos/removidos.
 */
export function acpResolveModel(
  provider: AgentProviderId,
  model: string | undefined,
  dynamic?: AcpModelDefinition[],
): string {
  const catalog = acpModels(provider, dynamic);
  if (model && catalog.some((candidate) => candidate.id === model)) {
    return model;
  }
  return catalog[0].id;
}
