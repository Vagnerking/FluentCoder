import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { acpProvider, acpProviders } from "../acp/providers";
import type {
  AgentConversation,
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

const EMPTY_DRAFT: AgentDraft = {
  name: "",
  color: "#60cdff",
  initialPrompt: "",
  provider: "codex",
};

interface AgentSidebarProps {
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
  onSelectAgent: (agentId: string) => void;
  onEditAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onNewConversation: (agentId: string) => void;
  onOpenConversation: (conversation: AgentConversation) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onSendMessage: (message: string, mode: AgentMode) => Promise<void>;
  onStop: () => void;
  onRevert: (conversationId: string, userMessageId: string) => Promise<void>;
}

/**
 * Painel de agentes completo na sidebar (chat, histórico e configuração),
 * no padrão das extensões de chat de IA: o editor continua visível ao lado.
 */
export function AgentSidebar(props: AgentSidebarProps) {
  const { rootPath, store, selection } = props;
  // A navegação para histórico é local ao painel; chat/config vêm da seleção.
  const [showHistory, setShowHistory] = useState(false);

  // Trocar de conversa/agente ou abrir a configuração fecha o histórico.
  useEffect(() => {
    setShowHistory(false);
  }, [selection]);

  if (!rootPath) {
    return (
      <div className="agents-panel">
        <SidebarHeader title="Agentes" />
        <div className="panel-empty">
          Abra uma pasta para conversar com agentes vinculados ao workspace.
        </div>
      </div>
    );
  }

  if (selection?.kind === "config") {
    const agent =
      store.agents.find((candidate) => candidate.id === selection.agentId) ??
      null;
    return (
      <div className="agents-panel">
        <SidebarHeader
          title={agent ? "Editar agente" : "Novo agente"}
          onBack={props.onCancelConfig}
        />
        <AgentConfigForm
          agent={agent}
          workspacePath={rootPath}
          onSave={props.onSaveAgent}
          onCancel={props.onCancelConfig}
        />
      </div>
    );
  }

  const activeAgent =
    selection?.kind === "chat"
      ? store.agents.find((candidate) => candidate.id === selection.agentId)
      : undefined;
  const activeConversation =
    selection?.kind === "chat"
      ? store.conversations.find(
          (candidate) => candidate.id === selection.conversationId,
        )
      : undefined;

  if (showHistory || !activeAgent || !activeConversation) {
    return (
      <div className="agents-panel">
        <SidebarHeader
          title={showHistory ? "Conversas" : "Agentes"}
          onBack={
            showHistory && activeAgent && activeConversation
              ? () => setShowHistory(false)
              : undefined
          }
          actions={[
            {
              icon: "add",
              label: "Novo agente",
              onClick: props.onCreate,
            },
          ]}
        />
        <AgentHistory
          store={store}
          selection={selection}
          onCreate={props.onCreate}
          onSelectAgent={props.onSelectAgent}
          onEditAgent={props.onEditAgent}
          onDeleteAgent={props.onDeleteAgent}
          onNewConversation={props.onNewConversation}
          onOpenConversation={props.onOpenConversation}
          onRenameConversation={props.onRenameConversation}
          onDeleteConversation={props.onDeleteConversation}
        />
      </div>
    );
  }

  return (
    <div className="agents-panel">
      <SidebarHeader
        title="Chat"
        actions={[
          {
            icon: "add",
            label: "Nova conversa",
            onClick: () => props.onNewConversation(activeAgent.id),
          },
          {
            icon: "timeline",
            label: "Histórico e agentes",
            onClick: () => setShowHistory(true),
          },
        ]}
      />
      <AgentChat
        agent={activeAgent}
        conversation={activeConversation}
        busy={props.busy}
        status={props.status}
        error={props.error}
        mode={props.mode}
        onModeChange={props.onModeChange}
        onOpenPicker={() => setShowHistory(true)}
        onSend={props.onSendMessage}
        onStop={props.onStop}
        onRevert={props.onRevert}
      />
    </div>
  );
}

function SidebarHeader({
  title,
  onBack,
  actions = [],
}: {
  title: string;
  onBack?: () => void;
  actions?: { icon: IconAction; label: string; onClick: () => void }[];
}) {
  return (
    <div className="explorer-header agent-side-header">
      {onBack && (
        <button
          className="git-icon-btn"
          title="Voltar ao chat"
          aria-label="Voltar ao chat"
          onClick={onBack}
        >
          <Codicon name="arrowLeft" size={15} />
        </button>
      )}
      <span className="explorer-title">{title}</span>
      <div className="agent-side-header-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            className="git-icon-btn"
            title={action.label}
            aria-label={action.label}
            onClick={action.onClick}
          >
            <Codicon name={action.icon} size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Lista de agentes + conversas do agente selecionado (gerência e navegação). */
function AgentHistory({
  store,
  selection,
  onCreate,
  onSelectAgent,
  onEditAgent,
  onDeleteAgent,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
}: {
  store: AgentStore;
  selection: AgentSelection;
  onCreate: () => void;
  onSelectAgent: (agentId: string) => void;
  onEditAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => void;
  onNewConversation: (agentId: string) => void;
  onOpenConversation: (conversation: AgentConversation) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}) {
  const selectedAgentId = selection?.agentId ?? null;
  const selectedConversationId =
    selection?.kind === "chat" ? selection.conversationId : null;

  if (store.agents.length === 0) {
    return (
      <div className="agent-side-empty">
        <Codicon name="agents" size={32} />
        <h2>Converse com agentes no editor</h2>
        <p>
          Crie um agente do Claude ou do Codex vinculado a este workspace e
          converse sem sair do código.
        </p>
        <button className="agent-button primary" onClick={onCreate}>
          Criar agente
        </button>
      </div>
    );
  }

  return (
    <div className="agents-scroll">
      <section className="agents-section" aria-labelledby="agents-list-title">
        <div className="agents-section-header">
          <span id="agents-list-title">Agentes</span>
          <span className="git-count">{store.agents.length}</span>
        </div>
        {store.agents.map((agent) => (
          <div
            className={`agent-row${
              selectedAgentId === agent.id ? " selected" : ""
            }`}
            key={agent.id}
          >
            <button
              className="agent-main-action"
              onClick={() => onSelectAgent(agent.id)}
              title={`Abrir chat com ${agent.name}`}
            >
              <span
                className="agent-color-dot"
                style={{ backgroundColor: agent.color }}
                aria-hidden="true"
              />
              <span className="agent-row-name">{agent.name}</span>
              <span className="agent-row-provider">
                {acpProvider(agent.provider).label}
              </span>
            </button>
            <div className="agent-row-actions">
              <button
                className="agent-icon-button"
                title="Nova conversa"
                aria-label={`Nova conversa com ${agent.name}`}
                onClick={() => onNewConversation(agent.id)}
              >
                <Codicon name="add" size={14} />
              </button>
              <button
                className="agent-icon-button"
                title="Editar configuração"
                aria-label={`Editar ${agent.name}`}
                onClick={() => onEditAgent(agent.id)}
              >
                <Codicon name="rename" size={14} />
              </button>
              <button
                className="agent-icon-button danger"
                title="Excluir agente"
                aria-label={`Excluir ${agent.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Excluir "${agent.name}" e todo o histórico local?`,
                    )
                  ) {
                    onDeleteAgent(agent.id);
                  }
                }}
              >
                <Codicon name="delete" size={14} />
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="agents-section" aria-labelledby="agent-history-title">
        <div className="agents-section-header">
          <span id="agent-history-title">Conversas</span>
        </div>
        {!selectedAgentId ? (
          <div className="panel-empty">
            Selecione um agente para ver as conversas.
          </div>
        ) : (
          <ConversationList
            conversations={store.conversations.filter(
              (conversation) => conversation.agentId === selectedAgentId,
            )}
            selectedId={selectedConversationId}
            onOpen={onOpenConversation}
            onRename={onRenameConversation}
            onDelete={onDeleteConversation}
          />
        )}
      </section>
    </div>
  );
}

function ConversationList({
  conversations,
  selectedId,
  onOpen,
  onRename,
  onDelete,
}: {
  conversations: AgentConversation[];
  selectedId: string | null;
  onOpen: (conversation: AgentConversation) => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  if (conversations.length === 0) {
    return <div className="panel-empty">Nenhuma conversa salva.</div>;
  }

  return (
    <div className="agent-history-list">
      {[...conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((conversation) => (
          <div
            key={conversation.id}
            className={`agent-history-row${
              selectedId === conversation.id ? " selected" : ""
            }`}
          >
            <button
              className="agent-history-main"
              onClick={() => onOpen(conversation)}
              title={`Abrir "${conversation.title}"`}
            >
              <Codicon name="timeline" size={14} />
              <span>{conversation.title}</span>
            </button>
            <div className="agent-row-actions">
              <button
                className="agent-icon-button"
                title="Renomear conversa"
                aria-label={`Renomear conversa "${conversation.title}"`}
                onClick={() => {
                  const title = window.prompt(
                    "Novo nome da conversa",
                    conversation.title,
                  );
                  if (title?.trim() && title.trim() !== conversation.title) {
                    onRename(conversation.id, title.trim());
                  }
                }}
              >
                <Codicon name="rename" size={13} />
              </button>
              <button
                className="agent-icon-button danger"
                title="Excluir conversa"
                aria-label={`Excluir conversa "${conversation.title}"`}
                onClick={() => {
                  if (
                    window.confirm(`Excluir a conversa "${conversation.title}"?`)
                  ) {
                    onDelete(conversation.id);
                  }
                }}
              >
                <Codicon name="delete" size={13} />
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}

function AgentChat({
  agent,
  conversation,
  busy,
  status,
  error,
  mode,
  onModeChange,
  onOpenPicker,
  onSend,
  onStop,
  onRevert,
}: {
  agent: AgentDefinition;
  conversation: AgentConversation;
  busy: boolean;
  status: string | null;
  error: string | null;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onOpenPicker: () => void;
  onSend: (message: string, mode: AgentMode) => Promise<void>;
  onStop: () => void;
  onRevert: (conversationId: string, userMessageId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // DOM nodes of the mode radios, so arrow-key navigation can move focus along
  // with selection (roving tabIndex), keyed by mode id.
  const modeRefs = useRef<Partial<Record<AgentMode, HTMLButtonElement | null>>>(
    {},
  );
  const provider = useMemo(() => acpProvider(agent.provider), [agent.provider]);
  const messages = conversation.messages;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  /** Auto-ajusta a altura do campo ao conteúdo (limitada a ~8 linhas). */
  function growTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    requestAnimationFrame(growTextarea);
    await onSend(message, mode);
  }

  /**
   * Arrow-key navigation for the mode radiogroup (WAI-ARIA radio pattern):
   * Up/Left select the previous mode, Down/Right the next, both with wrap.
   * Selecting via arrow also moves focus to the newly checked radio.
   */
  function onModeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (busy) return;
    const idx = AGENT_MODES.indexOf(mode);
    if (idx < 0) return;
    let next = idx;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowLeft":
        next = (idx - 1 + AGENT_MODES.length) % AGENT_MODES.length;
        break;
      case "ArrowDown":
      case "ArrowRight":
        next = (idx + 1) % AGENT_MODES.length;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = AGENT_MODES[next];
    onModeChange(target);
    modeRefs.current[target]?.focus();
  }

  return (
    <div className="agent-side-chat">
      <button
        className="agent-side-agent"
        onClick={onOpenPicker}
        title="Trocar de agente ou conversa"
      >
        <span
          className="agent-color-dot"
          style={{ backgroundColor: agent.color }}
          aria-hidden="true"
        />
        <span className="agent-side-agent-name">{agent.name}</span>
        <span className="agent-side-agent-provider">{provider.label}</span>
        <Codicon name="chevronDown" size={13} />
      </button>

      <div className="agent-messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="agent-side-welcome">
            <Codicon name="agents" size={26} />
            <h2>Chat pronto</h2>
            <p>
              Envie uma mensagem para {agent.name}. O contexto fica restrito a
              este workspace.
            </p>
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
                  onClick={() => onRevert(conversation.id, message.id)}
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
        <div className="agent-composer-box">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              growTextarea();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Mensagem para ${agent.name}`}
            aria-label={`Mensagem para ${agent.name}`}
            rows={1}
          />
          <div className="agent-composer-toolbar">
            <div
              className="agent-mode-bar"
              role="radiogroup"
              aria-label="Modo do agente"
              onKeyDown={onModeKeyDown}
            >
              {AGENT_MODES.map((id) => (
                <button
                  key={id}
                  ref={(el) => {
                    modeRefs.current[id] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={mode === id}
                  // Roving tabIndex: only the checked radio is tabbable; arrows
                  // move focus within the group (WAI-ARIA radiogroup pattern).
                  tabIndex={mode === id ? 0 : -1}
                  className={`agent-mode-option ${mode === id ? "active" : ""}`}
                  onClick={() => onModeChange(id)}
                  disabled={busy}
                  title={MODE_META[id].hint}
                >
                  <Codicon name={MODE_META[id].icon} size={13} />
                  {MODE_META[id].label}
                </button>
              ))}
            </div>
            {busy ? (
              <button
                className="agent-send-button stop"
                type="button"
                onClick={onStop}
                aria-label="Parar execução do agente"
                title="Parar execução do agente"
              >
                <Codicon name="stop" size={16} />
              </button>
            ) : (
              <button
                className="agent-send-button"
                type="submit"
                disabled={!draft.trim()}
                aria-label="Enviar mensagem"
                title="Enviar mensagem (Enter)"
              >
                <Codicon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

/** Formulário compacto de criação/edição de agente, dentro da sidebar. */
function AgentConfigForm({
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
    onSave({
      ...draft,
      name: draft.name.trim(),
      initialPrompt: draft.initialPrompt.trim(),
    });
  }

  return (
    <form className="agent-side-config" onSubmit={submit}>
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
        <span>Prompt de contexto (opcional)</span>
        <textarea
          value={draft.initialPrompt}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              initialPrompt: event.target.value,
            }))
          }
          placeholder="Papel, objetivos e regras permanentes deste agente."
          rows={5}
        />
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
