import {
  Children,
  FormEvent,
  ReactNode,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  acpDefaultModel,
  acpModels,
  acpProvider,
  acpProviders,
  acpResolveModel,
} from "../acp/providers";
import type {
  AgentConversation,
  AgentDefinition,
  AgentDraft,
  AgentEditorContext,
  AgentMessage,
  AgentMode,
  AgentSelection,
  AgentStore,
} from "../agents/types";
import { AGENT_MODES } from "../agents/types";
import { parseFileRef, resolveWorkspacePath } from "../agents/fileRef";
import { highlightCode } from "../agents/codeHighlight";
import { tokenizeInline } from "../agents/inlineCode";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";

/** UI metadata for each permission mode, shown in the composer's mode picker. */
const MODE_META: Record<
  AgentMode,
  { label: string; hint: string; icon: IconAction }
> = {
  ask: {
    label: "Ask",
    hint: "Somente leitura — o agente responde sem alterar nada.",
    icon: "modeAsk",
  },
  plan: {
    label: "Plan",
    hint: "Explora o código e apresenta um plano antes de editar.",
    icon: "modePlan",
  },
  edit: {
    label: "Edit",
    hint: "Edita arquivos do workspace automaticamente.",
    icon: "modeEdit",
  },
  auto: {
    label: "Auto",
    hint: "O agente escolhe o nível; ações arriscadas são negadas.",
    icon: "modeAuto",
  },
  bypass: {
    label: "Bypass",
    hint: "Acesso total, sem confirmações — use com cuidado.",
    icon: "modeBypass",
  },
};

const EMPTY_DRAFT: AgentDraft = {
  name: "",
  color: "#60cdff",
  initialPrompt: "",
  provider: "codex",
  model: acpDefaultModel("codex"),
};

interface AgentSidebarProps {
  rootPath: string | null;
  store: AgentStore;
  selection: AgentSelection;
  busy: boolean;
  status: string | null;
  /** Raciocínio em streaming do turno atual (efêmero, some com a resposta). */
  thought: string | null;
  error: string | null;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  /** Persiste o modelo escolhido para o agente ativo (por conversa/agente). */
  onModelChange: (agentId: string, model: string) => void;
  /**
   * Lê o arquivo/seleção ativos do editor no momento do clique, para anexar ao
   * envio. Retorna `null` quando não há arquivo aberto.
   */
  readEditorContext: () => AgentEditorContext | null;
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
  onSendMessage: (
    message: string,
    mode: AgentMode,
    context: AgentEditorContext | null,
  ) => Promise<void>;
  onStop: () => void;
  onRevert: (conversationId: string, userMessageId: string) => Promise<void>;
  /** Abre um arquivo citado pelo agente no editor (linha opcional, 1-based). */
  onOpenFile: (path: string, line?: number) => void;
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
        thought={props.thought}
        error={props.error}
        mode={props.mode}
        onModeChange={props.onModeChange}
        onModelChange={props.onModelChange}
        readEditorContext={props.readEditorContext}
        onOpenPicker={() => setShowHistory(true)}
        onSend={props.onSendMessage}
        onStop={props.onStop}
        onRevert={props.onRevert}
        onOpenFile={props.onOpenFile}
        workspacePath={rootPath}
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
  thought,
  error,
  mode,
  onModeChange,
  onModelChange,
  readEditorContext,
  onOpenPicker,
  onSend,
  onStop,
  onRevert,
  onOpenFile,
  workspacePath,
}: {
  agent: AgentDefinition;
  conversation: AgentConversation;
  busy: boolean;
  status: string | null;
  thought: string | null;
  error: string | null;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onModelChange: (agentId: string, model: string) => void;
  readEditorContext: () => AgentEditorContext | null;
  onOpenPicker: () => void;
  onSend: (
    message: string,
    mode: AgentMode,
    context: AgentEditorContext | null,
  ) => Promise<void>;
  onStop: () => void;
  onRevert: (conversationId: string, userMessageId: string) => Promise<void>;
  onOpenFile: (path: string, line?: number) => void;
  workspacePath: string | null;
}) {
  const [draft, setDraft] = useState("");
  // Contexto do editor anexado ao próximo envio (arquivo ativo + seleção).
  // Capturado ao anexar (e re-sincronizado ao focar o composer) para espelhar o
  // Claude Code, que referencia o arquivo/trecho aberto junto do prompt.
  const [attachedContext, setAttachedContext] =
    useState<AgentEditorContext | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const provider = useMemo(() => acpProvider(agent.provider), [agent.provider]);
  // Modelo efetivo do agente — o salvo, ou o padrão do provedor se ausente/antigo.
  const activeModel = useMemo(
    () => acpResolveModel(agent.provider, agent.model),
    [agent.provider, agent.model],
  );
  const messages = conversation.messages;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, thought]);

  /** (Re)captura o arquivo/seleção ativos como contexto anexado ao envio. */
  function attachEditorContext() {
    setAttachedContext(readEditorContext());
  }

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
    const context = attachedContext;
    setDraft("");
    setAttachedContext(null);
    requestAnimationFrame(growTextarea);
    await onSend(message, mode, context);
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
            <MessageBody
              message={message}
              onOpenFile={onOpenFile}
              workspacePath={workspacePath}
            />
          </article>
        ))}
        {thought && busy && (
          <div className="agent-chat-thought">
            <div className="agent-chat-thought-label">Raciocínio</div>
            {/* column-reverse ancora o texto embaixo: o excesso some por cima,
                então a cauda (o pensamento mais recente) fica sempre visível. */}
            <div className="agent-chat-thought-clip">
              <div className="agent-chat-thought-text">{thought}</div>
            </div>
          </div>
        )}
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
          {attachedContext && (
            <ContextChip
              context={attachedContext}
              onOpen={() =>
                onOpenFile(attachedContext.path, attachedContext.startLine)
              }
              onRemove={() => setAttachedContext(null)}
            />
          )}
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
            <div className="agent-composer-toolbar-start">
              <button
                type="button"
                className="agent-attach-button"
                onClick={attachEditorContext}
                title="Anexar o arquivo/seleção ativos do editor"
                aria-label="Anexar o arquivo ou seleção ativos do editor"
              >
                <Codicon name="attachContext" size={14} />
              </button>
              <ModePicker mode={mode} disabled={busy} onChange={onModeChange} />
            </div>
            <div className="agent-composer-toolbar-end">
              <ModelPicker
                provider={agent.provider}
                value={activeModel}
                disabled={busy}
                onChange={(model) => onModelChange(agent.id, model)}
              />
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
        </div>
      </form>
    </div>
  );
}

/**
 * Chip do contexto do editor anexado ao envio (arquivo + intervalo de linhas
 * da seleção, quando houver). Clicar abre o arquivo; o "×" remove o anexo.
 */
function ContextChip({
  context,
  onOpen,
  onRemove,
}: {
  context: AgentEditorContext;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const range =
    context.startLine != null && context.endLine != null
      ? context.startLine === context.endLine
        ? `:${context.startLine}`
        : `:${context.startLine}-${context.endLine}`
      : "";
  const label = `${context.name}${range}`;
  return (
    <div className="agent-context-chip">
      <button
        type="button"
        className="agent-context-chip-main"
        onClick={onOpen}
        title={`Abrir ${context.path}${range}`}
      >
        <Codicon name="file" size={12} />
        <span className="agent-context-chip-label">{label}</span>
        {context.selectionText && (
          <span className="agent-context-chip-kind">seleção</span>
        )}
      </button>
      <button
        type="button"
        className="agent-context-chip-remove"
        onClick={onRemove}
        title="Remover anexo"
        aria-label={`Remover anexo ${label}`}
      >
        <Codicon name="close" size={11} />
      </button>
    </div>
  );
}

/** Um item selecionável de um popover do composer (modo, modelo…). */
interface ComposerPickerItem {
  id: string;
  label: string;
  hint: string;
  icon?: IconAction;
}

/**
 * Popover de seleção do composer (padrão do seletor de modos do Claude Code):
 * botão compacto abre um menu com ícone + título + descrição por item e check
 * no selecionado. WAI-ARIA de menu; fecha ao escolher, no Escape ou clique
 * fora. `align` ancora o menu na borda inicial/final do botão para não vazar
 * da sidebar.
 */
function ComposerPicker({
  triggerIcon,
  triggerLabel,
  triggerTitle,
  menuLabel,
  align,
  items,
  selectedId,
  disabled,
  onSelect,
}: {
  triggerIcon: IconAction;
  triggerLabel: string;
  triggerTitle: string;
  menuLabel: string;
  align: "start" | "end";
  items: ComposerPickerItem[];
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        type="button"
        className="agent-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerTitle}
      >
        <Codicon name={triggerIcon} size={13} />
        <span className="agent-picker-trigger-label">{triggerLabel}</span>
        <Codicon name="chevronDown" size={12} />
      </button>
      {open && (
        <div
          className={`agent-picker-menu align-${align}`}
          role="menu"
          aria-label={menuLabel}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === selectedId}
              className={`agent-picker-item ${
                item.id === selectedId ? "active" : ""
              }`}
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
              }}
            >
              {item.icon && (
                <span className="agent-picker-item-icon">
                  <Codicon name={item.icon} size={14} />
                </span>
              )}
              <span className="agent-picker-item-text">
                <span className="agent-picker-item-label">{item.label}</span>
                <span className="agent-picker-item-hint">{item.hint}</span>
              </span>
              <span className="agent-picker-item-check">
                {item.id === selectedId && <Codicon name="success" size={13} />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Seletor do modo de permissão (Ask/Plan/Edit/Auto/Bypass), no estilo do
 * seletor de modos do Claude Code.
 */
function ModePicker({
  mode,
  disabled,
  onChange,
}: {
  mode: AgentMode;
  disabled: boolean;
  onChange: (mode: AgentMode) => void;
}) {
  const meta = MODE_META[mode];
  return (
    <ComposerPicker
      triggerIcon={meta.icon}
      triggerLabel={meta.label}
      triggerTitle={`Modo: ${meta.label} — ${meta.hint}`}
      menuLabel="Modo de permissão do agente"
      align="start"
      items={AGENT_MODES.map((id) => ({ id, ...MODE_META[id] }))}
      selectedId={mode}
      disabled={disabled}
      onSelect={(id) => onChange(id as AgentMode)}
    />
  );
}

/** Seletor de modelo do provedor, no mesmo popover do seletor de modos. */
function ModelPicker({
  provider,
  value,
  disabled,
  onChange,
}: {
  provider: AgentDefinition["provider"];
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const models = useMemo(() => acpModels(provider), [provider]);
  const current = models.find((model) => model.id === value) ?? models[0];
  return (
    <ComposerPicker
      triggerIcon="model"
      triggerLabel={current.label}
      triggerTitle={`Modelo: ${current.label} — ${current.hint}`}
      menuLabel="Modelo do provedor"
      align="end"
      items={models.map((model) => ({
        id: model.id,
        label: model.label,
        hint: model.hint,
      }))}
      selectedId={current.id}
      disabled={disabled}
      onSelect={onChange}
    />
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
            model: acpResolveModel(agent.provider, agent.model),
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
          onChange={(event) => {
            const provider = event.target.value as AgentDraft["provider"];
            setDraft((current) => ({
              ...current,
              provider,
              // Cada provedor tem seu próprio catálogo; volta ao padrão dele.
              model: acpDefaultModel(provider),
            }));
          }}
        >
          {acpProviders().map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <small>{acpProvider(draft.provider).description}</small>
      </label>

      <label className="agent-field">
        <span>Modelo</span>
        <select
          value={acpResolveModel(draft.provider, draft.model)}
          onChange={(event) =>
            setDraft((current) => ({ ...current, model: event.target.value }))
          }
        >
          {acpModels(draft.provider).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <small>
          {
            (
              acpModels(draft.provider).find(
                (model) => model.id === acpResolveModel(draft.provider, draft.model),
              ) ?? acpModels(draft.provider)[0]
            ).hint
          }
        </small>
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

/** Extrai o texto puro dos filhos de um nó `code` do markdown. */
function markdownText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" ? child : ""))
    .join("");
}

/**
 * Bloco de código cercado com realce de sintaxe (Shiki, tema Dark+ — as mesmas
 * cores do editor). O realce é assíncrono: até chegar (ou quando a linguagem
 * não tem grammar), o bloco renderiza plano com a mesma moldura, sem salto de
 * layout. Durante o streaming o conteúdo cresce a cada flush; o guard de
 * sequência garante que um realce atrasado de um conteúdo antigo nunca
 * sobrescreva o mais recente.
 */
function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let alive = true;
    void highlightCode(code, lang).then((result) => {
      if (alive && seqRef.current === seq) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  if (html) {
    // HTML gerado pelo Shiki a partir do texto do bloco (escapado) — não é
    // HTML vindo do LLM, então é seguro injetar.
    return (
      <div
        className="agent-code-block"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <div className="agent-code-block">
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Renders a chat message. Assistant replies come back as Markdown (bold, lists,
 * code, tables…) so they're rendered with react-markdown + GFM. HTML is NOT
 * enabled (no rehype-raw): the content is untrusted LLM output, so we keep the
 * sanitized default to avoid XSS. User messages stay plain text, preserving the
 * exact whitespace they typed. Inline `code` que parece um caminho de arquivo
 * vira um botão que abre o arquivo no editor. Blocos cercados ganham realce de
 * sintaxe via [CodeBlock].
 */
function MessageBody({
  message,
  onOpenFile,
  workspacePath,
}: {
  message: AgentMessage;
  onOpenFile: (path: string, line?: number) => void;
  workspacePath: string | null;
}) {
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
          a: ({ node: _node, href, children, ...props }) => {
            // Um link cujo destino é um arquivo do workspace abre no editor;
            // demais links (http…) abrem no navegador do usuário.
            const ref = href ? parseFileRef(href) : null;
            if (ref) {
              return (
                <button
                  type="button"
                  className="agent-file-link"
                  title={`Abrir ${ref.path}`}
                  onClick={() =>
                    onOpenFile(
                      resolveWorkspacePath(workspacePath, ref.path),
                      ref.line,
                    )
                  }
                >
                  {children}
                </button>
              );
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          // Tabelas rolam horizontalmente dentro do próprio wrapper quando não
          // cabem na sidebar — sem isso o layout espreme as colunas e quebra
          // palavras/chips no meio.
          table: ({ node: _node, children, ...props }) => (
            <div className="agent-table-wrap">
              <table {...props}>{children}</table>
            </div>
          ),
          // Blocos cercados (```lang) são renderizados pelo override de `pre`
          // abaixo com realce de sintaxe; este `code` só trata o inline.
          pre: ({ node: _node, children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            if (isValidElement(child)) {
              // `child` é o elemento `code` filho do `pre`, ainda com as props
              // originais do markdown (className `language-*` + texto puro).
              const props = child.props as {
                className?: string;
                children?: ReactNode;
              };
              const lang =
                /language-([\w#+.-]+)/.exec(props.className ?? "")?.[1] ?? null;
              return (
                <CodeBlock
                  code={markdownText(props.children).replace(/\n$/, "")}
                  lang={lang}
                />
              );
            }
            return <pre>{children}</pre>;
          },
          code: ({ node: _node, className, children, ...props }) => {
            // Blocos de código (```lang) trazem className `language-*`; só o
            // `code` inline (sem className) é candidato a referência de arquivo.
            const raw = String(children);
            const ref = !className ? parseFileRef(raw) : null;
            if (ref) {
              return (
                <button
                  type="button"
                  className="agent-file-link code"
                  title={`Abrir ${ref.path}`}
                  onClick={() =>
                    onOpenFile(
                      resolveWorkspacePath(workspacePath, ref.path),
                      ref.line,
                    )
                  }
                >
                  {children}
                </button>
              );
            }
            if (!className) {
              // Chip inline sem linguagem: coloração heurística por token
              // (palavra-chave/tipo/chamada/número…) na paleta do editor —
              // sem ela o chip inteiro ficava de uma cor só.
              return (
                <code {...props}>
                  {tokenizeInline(raw).map((token, index) =>
                    token.kind === "plain" ? (
                      token.text
                    ) : (
                      <span key={index} className={`tok-${token.kind}`}>
                        {token.text}
                      </span>
                    ),
                  )}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}
