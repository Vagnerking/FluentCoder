import { useId, useMemo, useState, type FormEvent } from "react";
import { acpModels, acpProvider, acpResolveModel, type ProviderStatus } from "../../acp/providers";
import {
  AGENT_MODES,
  CONTEXT_PRESETS,
  type AgentDefinition,
  type AgentDraft,
  type AgentMode,
  type ContextPreset,
} from "../../agents/types";
import { MODE_META } from "../../chat/modes";
import { providerTargetId } from "../../chat/targets";
import type { FluentChatState } from "../../chat/useFluentChat";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Button, Checkbox, IconButton, Select, Switch } from "../ui";
import "./fluentChat.css";

const AGENT_ICONS: IconAction[] = [
  "agentHubot",
  "agentRobot",
  "agentSparkle",
  "agentShield",
  "agentBug",
  "agentBeaker",
  "agentBook",
  "agentRocket",
  "agentTools",
  "agentLaw",
  "agentMortarBoard",
  "agentPulse",
  "agentDatabase",
  "agentPaintcan",
  "agentGlobe",
  "agentOrganization",
];

const COLORS = ["#60cdff", "#73c991", "#e2c08d", "#f1707b", "#c586c0", "#4fc1ff", "#ce9178", "#b5cea8"];

const PRESET_LABEL: Record<ContextPreset, { label: string; hint: string }> = {
  graph: { label: "#grafo", hint: "Arquivo ativo + vizinhos no grafo de conhecimento" },
  context: { label: "#contexto", hint: "Arquivos relevantes à pergunta" },
  workspace: { label: "@workspace", hint: "Busca no projeto guiada pelo grafo" },
  problems: { label: "#problemas", hint: "Erros e avisos do workspace" },
  selection: { label: "#seleção", hint: "Trecho selecionado no editor (quando houver)" },
};

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyDraft(provider: string): AgentDraft {
  return {
    name: "",
    color: COLORS[0],
    initialPrompt: "",
    provider,
    model: acpResolveModel(provider, undefined),
    icon: "agentHubot",
    description: "",
    contextPresets: [],
  };
}

function toDraft(agent: AgentDefinition): AgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    color: agent.color,
    initialPrompt: agent.initialPrompt,
    provider: agent.provider,
    model: agent.model,
    description: agent.description ?? "",
    icon: agent.icon ?? "agentHubot",
    defaultMode: agent.defaultMode,
    contextPresets: agent.contextPresets ?? [],
    allowedTools: agent.allowedTools ?? [],
    disallowedTools: agent.disallowedTools ?? [],
    networkAccess: agent.networkAccess ?? false,
    scope: agent.scope ?? "workspace",
  };
}

/** Formulário de criação/edição de agente personalizado. */
function AgentEditor({
  initial,
  providers,
  dynamicModels,
  onSave,
  onCancel,
}: {
  initial: AgentDraft;
  providers: ProviderStatus[];
  dynamicModels: Record<string, { id: string; label: string; hint: string }[]>;
  onSave: (draft: AgentDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [allowed, setAllowed] = useState((initial.allowedTools ?? []).join(", "));
  const [disallowed, setDisallowed] = useState((initial.disallowedTools ?? []).join(", "));
  const [validation, setValidation] = useState<string | null>(null);
  const fieldId = useId();
  const provider = acpProvider(draft.provider);
  const models = acpModels(draft.provider, dynamicModels[draft.provider]);
  const patch = (update: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...update }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) {
      setValidation("Informe um nome para identificar o agente.");
      return;
    }
    onSave({
      ...draft,
      name: draft.name.trim(),
      description: draft.description?.trim(),
      initialPrompt: draft.initialPrompt.trim(),
      allowedTools: splitList(allowed),
      disallowedTools: splitList(disallowed),
    });
  };

  return (
    <form className="fc-agent-form" onSubmit={submit} aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`} className="fc-form-title">
        {initial.id ? "Editar agente" : "Novo agente"}
      </h3>

      <label className="fc-field">
        <span>Nome</span>
        <input
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="Ex.: Revisor de segurança"
          autoFocus
          aria-invalid={!!validation || undefined}
        />
      </label>

      <label className="fc-field">
        <span>Descrição (opcional)</span>
        <input
          value={draft.description ?? ""}
          onChange={(event) => patch({ description: event.target.value })}
          placeholder="Aparece no seletor do chat"
        />
      </label>

      <fieldset className="fc-field">
        <legend>Ícone e cor</legend>
        <div className="fc-icon-grid" role="radiogroup" aria-label="Ícone do agente">
          {AGENT_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={draft.icon === icon}
              aria-label={icon.replace("agent", "")}
              className={`fc-icon-choice${draft.icon === icon ? " active" : ""}`}
              onClick={() => patch({ icon })}
              style={draft.icon === icon ? { color: draft.color } : undefined}
            >
              <Codicon name={icon} size={16} />
            </button>
          ))}
        </div>
        <div className="fc-color-row" role="radiogroup" aria-label="Cor do agente">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={draft.color === color}
              aria-label={`Cor ${color}`}
              className={`fc-color-choice${draft.color === color ? " active" : ""}`}
              style={{ backgroundColor: color }}
              onClick={() => patch({ color })}
            />
          ))}
          <input
            type="color"
            value={draft.color}
            onChange={(event) => patch({ color: event.target.value })}
            aria-label="Cor personalizada"
          />
        </div>
      </fieldset>

      <div className="fc-field">
        <span id={`${fieldId}-provider`}>Provedor base</span>
        <Select
          ariaLabelledBy={`${fieldId}-provider`}
          value={draft.provider}
          onChange={(value) => patch({ provider: value, model: acpResolveModel(value, undefined) })}
          options={providers.map((status) => ({
            value: status.id,
            label: status.installed ? status.label : `${status.label} (não instalado)`,
          }))}
        />
        <small>{provider.description}</small>
      </div>

      <div className="fc-field-row">
        <div className="fc-field">
          <span id={`${fieldId}-model`}>Modelo</span>
          <Select
            ariaLabelledBy={`${fieldId}-model`}
            value={acpResolveModel(draft.provider, draft.model, dynamicModels[draft.provider]) || "__default"}
            onChange={(value) => patch({ model: value === "__default" ? "" : value })}
            options={models.map((model) => ({ value: model.id || "__default", label: model.label }))}
          />
        </div>
        <div className="fc-field">
          <span id={`${fieldId}-mode`}>Modo padrão</span>
          <Select
            ariaLabelledBy={`${fieldId}-mode`}
            value={draft.defaultMode ?? "__keep"}
            onChange={(value) => patch({ defaultMode: value === "__keep" ? undefined : (value as AgentMode) })}
            options={[
              { value: "__keep", label: "Manter o atual" },
              ...AGENT_MODES.map((mode) => ({ value: mode, label: MODE_META[mode].label })),
            ]}
          />
        </div>
      </div>

      <label className="fc-field">
        <span>Instruções (opcional)</span>
        <textarea
          value={draft.initialPrompt}
          onChange={(event) => patch({ initialPrompt: event.target.value })}
          placeholder="Papel, objetivos e regras permanentes deste agente. Enviadas no início de cada conversa nova."
          rows={6}
        />
      </label>

      <fieldset className="fc-field">
        <legend>Contexto sempre anexado</legend>
        {CONTEXT_PRESETS.map((preset) => (
          <Checkbox
            key={preset}
            label={
              <span>
                <code>{PRESET_LABEL[preset].label}</code> — {PRESET_LABEL[preset].hint}
              </span>
            }
            checked={draft.contextPresets?.includes(preset) ?? false}
            onChange={(event) =>
              patch({
                contextPresets: event.target.checked
                  ? [...(draft.contextPresets ?? []), preset]
                  : (draft.contextPresets ?? []).filter((item) => item !== preset),
              })
            }
          />
        ))}
      </fieldset>

      <fieldset className="fc-field">
        <legend>Ferramentas</legend>
        {provider.protocol === "claude-stream-json" ? (
          <>
            <label className="fc-field">
              <span>Permitidas sem perguntar (--allowedTools)</span>
              <input value={allowed} onChange={(event) => setAllowed(event.target.value)} placeholder="Ex.: Read, Grep, Bash(npm test:*)" />
            </label>
            <label className="fc-field">
              <span>Bloqueadas (--disallowedTools)</span>
              <input value={disallowed} onChange={(event) => setDisallowed(event.target.value)} placeholder="Ex.: WebFetch, Bash(git push:*)" />
            </label>
          </>
        ) : provider.protocol === "codex-app-server" ? (
          <Switch
            checked={draft.networkAccess ?? false}
            onChange={(networkAccess) => patch({ networkAccess })}
            label="Permitir acesso à rede no sandbox (modos Editar e Agente)"
          />
        ) : (
          <small>As ferramentas deste agente são controladas pelo próprio CLI; os modos e as aprovações do chat continuam valendo.</small>
        )}
      </fieldset>

      <Switch
        checked={draft.scope === "global"}
        onChange={(global) => patch({ scope: global ? "global" : "workspace" })}
        label="Disponível em todas as pastas (agente global)"
      />

      {validation && (
        <div className="fc-error" role="alert">
          <Codicon name="error" size={14} />
          <span>{validation}</span>
        </div>
      )}

      <div className="fc-form-actions">
        <Button onClick={onCancel}>Cancelar</Button>
        <Button type="submit" variant="primary">
          Salvar agente
        </Button>
      </div>
    </form>
  );
}

/**
 * "Configurar agentes" do Fluent Chat (diálogo `AgentsSettingsDialog`): agentes personalizados (do workspace e
 * globais) e os provedores detectados com dica de instalação.
 */
export function AgentsManager({
  chat,
  onStartChat,
}: {
  chat: FluentChatState;
  onStartChat: (targetId: string) => void;
}) {
  const [editing, setEditing] = useState<AgentDraft | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const installedProvider = chat.providers.find((provider) => provider.installed)?.id ?? "claude";
  const dynamicModels = useMemo(() => {
    const out: Record<string, { id: string; label: string; hint: string }[]> = {};
    if (chat.dynamicModels) out[chat.target.provider] = chat.dynamicModels;
    return out;
  }, [chat.dynamicModels, chat.target.provider]);

  if (!chat.rootPath) {
    return <div className="fc-empty">Abra uma pasta para gerenciar os agentes.</div>;
  }

  if (editing) {
    return (
      <div className="fc-manager">
        <AgentEditor
          initial={editing}
          providers={chat.providers}
          dynamicModels={dynamicModels}
          onCancel={() => setEditing(null)}
          onSave={(draft) => {
            chat.saveAgent(draft);
            setEditing(null);
          }}
        />
      </div>
    );
  }

  const renderAgent = (agent: AgentDefinition) => {
    const provider = chat.providers.find((candidate) => candidate.id === agent.provider);
    const model = acpModels(agent.provider).find((candidate) => candidate.id === agent.model);
    return (
      <li key={agent.id} className="fc-agent-card">
        <span className="fc-agent-icon" style={{ color: agent.color }} aria-hidden="true">
          <Codicon name={(agent.icon ?? "agentHubot") as IconAction} size={18} />
        </span>
        <div className="fc-agent-info">
          <strong>{agent.name}</strong>
          {agent.description && <span className="fc-agent-desc">{agent.description}</span>}
          <span className="fc-agent-meta">
            {acpProvider(agent.provider).label}
            {model ? ` · ${model.label}` : ""}
            {agent.defaultMode ? ` · ${MODE_META[agent.defaultMode].label}` : ""}
            {provider && !provider.installed ? " · não instalado" : ""}
          </span>
        </div>
        <div className="fc-row-actions visible">
          <IconButton size="sm" icon="fluentChat" label={`Conversar com ${agent.name}`} onClick={() => onStartChat(agent.id)} />
          <IconButton size="sm" icon="rename" label={`Editar ${agent.name}`} onClick={() => setEditing(toDraft(agent))} />
          <IconButton size="sm" icon="duplicate" label={`Duplicar ${agent.name}`} onClick={() => chat.duplicateAgent(agent.id)} />
          <IconButton
            size="sm"
            icon="delete"
            label={`Excluir ${agent.name}`}
            onClick={() => {
              if (window.confirm(`Excluir o agente "${agent.name}"? As conversas dele continuam com o provedor base.`)) {
                chat.deleteAgent(agent.id);
              }
            }}
          />
        </div>
      </li>
    );
  };

  return (
    <div className="fc-manager">
      <div className="fc-manager-head">
        <div>
          <h2>Agentes personalizados</h2>
          <p>Combine provedor, modelo, modo, instruções e contexto num agente reutilizável.</p>
        </div>
        <Button variant="primary" icon="add" onClick={() => setEditing(emptyDraft(installedProvider))}>
          Novo agente
        </Button>
      </div>

      {chat.agents.length === 0 ? (
        <div className="fc-empty">
          Nenhum agente ainda. Crie um para fixar instruções, modelo e contexto — ou converse direto com um provedor
          no Fluent Chat.
        </div>
      ) : (
        <>
          {chat.workspaceAgents.length > 0 && (
            <section aria-label="Agentes deste workspace">
              <h3 className="fc-section-label">Neste workspace</h3>
              <ul className="fc-agent-list">{chat.workspaceAgents.map(renderAgent)}</ul>
            </section>
          )}
          {chat.globalAgents.length > 0 && (
            <section aria-label="Agentes globais">
              <h3 className="fc-section-label">Globais</h3>
              <ul className="fc-agent-list">{chat.globalAgents.map(renderAgent)}</ul>
            </section>
          )}
        </>
      )}

      <section className="fc-providers" aria-label="Provedores">
        <div className="fc-providers-head">
          <h3 className="fc-section-label">Provedores</h3>
          <Button
            size="sm"
            variant="subtle"
            icon="refresh"
            loading={refreshing}
            onClick={() => {
              setRefreshing(true);
              void chat.refreshProviders().finally(() => setRefreshing(false));
            }}
          >
            Detectar novamente
          </Button>
        </div>
        <ul className="fc-provider-list">
          {chat.providers.map((provider) => (
            <li key={provider.id} className="fc-provider-row">
              <Codicon name={provider.icon as IconAction} size={14} />
              <div className="fc-agent-info">
                <strong>
                  {provider.label}
                  {provider.preview && <span className="fc-badge">ACP</span>}
                </strong>
                {provider.installed ? (
                  <span className="fc-agent-meta">
                    <Codicon name="success" size={11} /> Instalado
                  </span>
                ) : (
                  <span className="fc-agent-meta">
                    Não instalado — <code>{provider.installHint}</code>
                  </span>
                )}
              </div>
              {provider.installed && (
                <IconButton
                  size="sm"
                  icon="fluentChat"
                  label={`Conversar com ${provider.label}`}
                  onClick={() => onStartChat(providerTargetId(provider.id))}
                />
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
