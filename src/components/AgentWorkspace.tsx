import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { acpProvider, acpProviders } from "../acp/providers";
import type {
  AgentDefinition,
  AgentDraft,
  AgentMessage,
  AgentMode,
  AgentSelection,
  AgentStore,
} from "../agents/types";
import { AGENT_MODES } from "../agents/types";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";

/** UI metadata for each operating mode, shown in the composer's mode picker. */
const MODE_META: Record<
  AgentMode,
  { label: string; hint: string; icon: IconAction }
> = {
  ask: {
    label: "Ask",
    hint: "Somente leitura — o agente apenas responde.",
    icon: "modeAsk",
  },
  plan: {
    label: "Plan",
    hint: "Investiga e escreve apenas arquivos .md de plano.",
    icon: "modePlan",
  },
  dev: {
    label: "Dev",
    hint: "O agente pode criar e editar arquivos dentro do workspace.",
    icon: "modeDev",
  },
};

interface AgentWorkspaceProps {
  rootPath: string | null;
  store: AgentStore;
  selection: AgentSelection;
  busy: boolean;
  status: string | null;
  error: string | null;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onCreate: () => void;
  onSaveAgent: (draft: AgentDraft) => void;
  onCancelConfig: () => void;
  onSendMessage: (message: string, mode: AgentMode) => Promise<void>;
  onStop: () => void;
  onRevert: (conversationId: string, userMessageId: string) => Promise<void>;
}

const EMPTY_DRAFT: AgentDraft = {
  name: "",
  color: "#60cdff",
  initialPrompt: "",
  provider: "codex",
};

export function AgentWorkspace({
  rootPath,
  store,
  selection,
  busy,
  status,
  error,
  mode,
  onModeChange,
  onCreate,
  onSaveAgent,
  onCancelConfig,
  onSendMessage,
  onStop,
  onRevert,
}: AgentWorkspaceProps) {
  if (!rootPath) {
    return (
      <AgentEmpty
        title="Abra um workspace"
        description="Os agentes e seus históricos são vinculados à pasta aberta."
      />
    );
  }

  if (selection?.kind === "config") {
    const agent =
      store.agents.find((candidate) => candidate.id === selection.agentId) ?? null;
    return (
      <AgentConfiguration
        agent={agent}
        workspacePath={rootPath}
        onSave={onSaveAgent}
        onCancel={onCancelConfig}
      />
    );
  }

  if (selection?.kind === "chat") {
    const agent = store.agents.find(
      (candidate) => candidate.id === selection.agentId,
    );
    const conversation = store.conversations.find(
      (candidate) => candidate.id === selection.conversationId,
    );
    if (agent && conversation) {
      return (
        <AgentChat
          agent={agent}
          conversationId={conversation.id}
          messages={conversation.messages}
          busy={busy}
          status={status}
          error={error}
          mode={mode}
          onModeChange={onModeChange}
          onSend={onSendMessage}
          onStop={onStop}
          onRevert={onRevert}
        />
      );
    }
  }

  return (
    <AgentEmpty
      title="Converse com agentes no editor"
      description="Crie um agente ou selecione um existente na barra lateral."
      actionLabel="Criar agente"
      onAction={onCreate}
    />
  );
}

function AgentConfiguration({
  agent,
  workspacePath,
  onSave,
  onCancel,
}: {
  agent: AgentDefinition | null;
  workspacePath: string;
  onSave: (draft: AgentDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    setDraft(
      agent
        ? {
            id: agent.id,
            name: agent.name,
            color: agent.color,
            initialPrompt: agent.initialPrompt,
            provider: agent.provider,
          }
        : { ...EMPTY_DRAFT },
    );
    setValidation(null);
  }, [agent]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim()) {
      setValidation("Informe um nome para identificar o agente.");
      return;
    }
    if (!draft.initialPrompt.trim()) {
      setValidation("Informe o prompt de contexto inicial.");
      return;
    }
    onSave({
      ...draft,
      name: draft.name.trim(),
      initialPrompt: draft.initialPrompt.trim(),
    });
  }

  return (
    <div className="agent-config-page">
      <form className="agent-config-card" onSubmit={submit}>
        <div className="agent-config-heading">
          <div>
            <span className="agent-eyebrow">Configuração do agente</span>
            <h1>{agent ? "Editar agente" : "Novo agente"}</h1>
            <p>
              A configuração e o histórico ficam salvos localmente neste
              workspace.
            </p>
          </div>
          <span
            className="agent-config-color-preview"
            style={{ backgroundColor: draft.color }}
            aria-hidden="true"
          />
        </div>

        <label className="agent-field">
          <span>Nome</span>
          <input
            value={draft.name}
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Ex.: Revisor de segurança"
            autoFocus
          />
        </label>

        <label className="agent-field agent-color-field">
          <span>Cor identificadora</span>
          <input
            type="color"
            value={draft.color}
            onChange={(event) =>
              setDraft((current) => ({ ...current, color: event.target.value }))
            }
            aria-label="Cor identificadora do agente"
          />
          <code>{draft.color}</code>
        </label>

        <label className="agent-field">
          <span>Prompt de contexto inicial</span>
          <textarea
            value={draft.initialPrompt}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                initialPrompt: event.target.value,
              }))
            }
            placeholder="Defina papel, objetivos e regras permanentes deste agente."
            rows={8}
          />
        </label>

        <label className="agent-field">
          <span>Provedor</span>
          <select
            value={draft.provider}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                provider: event.target.value as AgentDraft["provider"],
              }))
            }
          >
            {acpProviders().map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
          <small>{acpProvider(draft.provider).description}</small>
        </label>

        <div className="agent-workspace-boundary">
          <Codicon name="folderOpened" size={16} />
          <div>
            <strong>Workspace permitido</strong>
            <span>{workspacePath}</span>
          </div>
        </div>

        {validation && (
          <div className="agent-form-error" role="alert">
            <Codicon name="error" size={15} />
            {validation}
          </div>
        )}

        <div className="agent-form-actions">
          <button type="button" className="agent-button secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="agent-button primary">
            Salvar e abrir chat
          </button>
        </div>
      </form>
    </div>
  );
}

function AgentChat({
  agent,
  conversationId,
  messages,
  busy,
  status,
  error,
  mode,
  onModeChange,
  onSend,
  onStop,
  onRevert,
}: {
  agent: AgentDefinition;
  conversationId: string;
  messages: AgentStore["conversations"][number]["messages"];
  busy: boolean;
  status: string | null;
  error: string | null;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onSend: (message: string, mode: AgentMode) => Promise<void>;
  onStop: () => void;
  onRevert: (conversationId: string, userMessageId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const provider = useMemo(() => acpProvider(agent.provider), [agent.provider]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    await onSend(message, mode);
  }

  return (
    <div className="agent-chat">
      <header className="agent-chat-header">
        <span
          className="agent-color-dot large"
          style={{ backgroundColor: agent.color }}
          aria-hidden="true"
        />
        <div>
          <h1>{agent.name}</h1>
          <span>
            {provider.label} · contexto restrito ao workspace
          </span>
        </div>
      </header>

      <div className="agent-messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="agent-chat-welcome">
            <Codicon name="agents" size={28} />
            <h2>Chat pronto</h2>
            <p>Envie uma mensagem para iniciar esta conversa.</p>
          </div>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`agent-message ${message.role} ${
              message.status === "error" ? "error" : ""
            }`}
          >
            <div className="agent-message-head">
              <span className="agent-message-role">
                {message.role === "user" ? "Você" : agent.name}
              </span>
              {message.role === "user" && message.mode && (
                <span className={`agent-message-mode mode-${message.mode}`}>
                  {MODE_META[message.mode].label}
                </span>
              )}
              {message.role === "user" && message.revert && (
                <button
                  type="button"
                  className="agent-revert-button"
                  disabled={busy || message.revert.reverted}
                  onClick={() => onRevert(conversationId, message.id)}
                  title={
                    message.revert.reverted
                      ? "Já revertido para antes deste pedido"
                      : "Reverter o código para antes deste pedido"
                  }
                >
                  <Codicon name="discard" size={13} />
                  {message.revert.reverted ? "Revertido" : "Reverter"}
                </button>
              )}
            </div>
            <MessageBody message={message} />
          </article>
        ))}
        {status && busy && (
          <div className="agent-chat-status" role="status">
            <Codicon name="loading" size={14} />
            {status}
          </div>
        )}
        {error && (
          <div className="agent-chat-error" role="alert">
            <Codicon name="error" size={15} />
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="agent-composer" onSubmit={submit}>
        <div className="agent-mode-bar" role="radiogroup" aria-label="Modo do agente">
          {AGENT_MODES.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={`agent-mode-option ${mode === id ? "active" : ""}`}
              onClick={() => onModeChange(id)}
              disabled={busy}
              title={MODE_META[id].hint}
            >
              <Codicon name={MODE_META[id].icon} size={13} />
              {MODE_META[id].label}
            </button>
          ))}
          <span className="agent-mode-hint">{MODE_META[mode].hint}</span>
        </div>
        <div className="agent-composer-row">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Mensagem para ${agent.name}`}
            aria-label={`Mensagem para ${agent.name}`}
            rows={3}
            disabled={busy}
          />
          {busy ? (
            <button
              className="agent-send-button stop"
              type="button"
              onClick={onStop}
              aria-label="Parar execução do agente"
              title="Parar execução do agente"
            >
              <Codicon name="stop" size={18} />
            </button>
          ) : (
            <button
              className="agent-send-button"
              type="submit"
              disabled={!draft.trim()}
              aria-label="Enviar mensagem"
              title="Enviar mensagem (Enter)"
            >
              <Codicon name="send" size={18} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * Renders a chat message. Assistant replies come back as Markdown (bold, lists,
 * code, tables…) so they're rendered with react-markdown + GFM. HTML is NOT
 * enabled (no rehype-raw): the content is untrusted LLM output, so we keep the
 * sanitized default to avoid XSS. User messages stay plain text, preserving the
 * exact whitespace they typed.
 */
function MessageBody({ message }: { message: AgentMessage }) {
  if (!message.content) {
    return (
      <p className="agent-message-placeholder">
        {message.status === "streaming" ? "Pensando…" : ""}
      </p>
    );
  }

  if (message.role === "user") {
    return <p className="agent-message-text">{message.content}</p>;
  }

  return (
    <div className="agent-message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Open links in the user's browser, never navigate the app shell.
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}

function AgentEmpty({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="agent-empty-state">
      <Codicon name="agents" size={40} />
      <h1>{title}</h1>
      <p>{description}</p>
      {actionLabel && onAction && (
        <button className="agent-button primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
