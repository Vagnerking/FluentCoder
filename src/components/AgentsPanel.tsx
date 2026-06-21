import { Codicon } from "../icons/codicons/Codicon";
import type {
  AgentConversation,
  AgentSelection,
  AgentStore,
} from "../agents/types";

interface AgentsPanelProps {
  rootPath: string | null;
  store: AgentStore;
  selection: AgentSelection;
  onCreate: () => void;
  onSelectAgent: (agentId: string) => void;
  onEdit: (agentId: string) => void;
  onRename: (agentId: string, name: string) => void;
  onDelete: (agentId: string) => void;
  onNewConversation: (agentId: string) => void;
  onOpenConversation: (conversation: AgentConversation) => void;
}

export function AgentsPanel({
  rootPath,
  store,
  selection,
  onCreate,
  onSelectAgent,
  onEdit,
  onRename,
  onDelete,
  onNewConversation,
  onOpenConversation,
}: AgentsPanelProps) {
  const selectedAgentId = selection?.agentId ?? null;
  const selectedConversationId =
    selection?.kind === "chat" ? selection.conversationId : null;

  if (!rootPath) {
    return (
      <div className="agents-panel">
        <PanelHeader onCreate={onCreate} disabled />
        <div className="panel-empty">
          Abra uma pasta para criar agentes vinculados ao workspace.
        </div>
      </div>
    );
  }

  return (
    <div className="agents-panel">
      <PanelHeader onCreate={onCreate} />

      <div className="agents-scroll">
        <section className="agents-section" aria-labelledby="agents-list-title">
          <div className="agents-section-header">
            <span id="agents-list-title">Agentes</span>
            <span className="git-count">{store.agents.length}</span>
          </div>

          {store.agents.length === 0 ? (
            <div className="panel-empty">
              Nenhum agente. Use o botão + para configurar o primeiro.
            </div>
          ) : (
            store.agents.map((agent) => (
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
                    aria-label={`Cor do agente: ${agent.color}`}
                  />
                  <span className="agent-row-name">{agent.name}</span>
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
                    onClick={() => onEdit(agent.id)}
                  >
                    <Codicon name="rename" size={14} />
                  </button>
                  <button
                    className="agent-icon-button"
                    title="Renomear"
                    aria-label={`Renomear ${agent.name}`}
                    onClick={() => {
                      const name = window.prompt("Novo nome do agente", agent.name);
                      if (name?.trim() && name.trim() !== agent.name) {
                        onRename(agent.id, name.trim());
                      }
                    }}
                  >
                    <Codicon name="renameSymbol" size={14} />
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
                        onDelete(agent.id);
                      }
                    }}
                  >
                    <Codicon name="delete" size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="agents-section" aria-labelledby="agent-history-title">
          <div className="agents-section-header">
            <span id="agent-history-title">Histórico</span>
          </div>
          {!selectedAgentId ? (
            <div className="panel-empty">Selecione um agente para ver o histórico.</div>
          ) : (
            <ConversationList
              conversations={store.conversations.filter(
                (conversation) => conversation.agentId === selectedAgentId,
              )}
              selectedId={selectedConversationId}
              onOpen={onOpenConversation}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function PanelHeader({
  onCreate,
  disabled = false,
}: {
  onCreate: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="explorer-header">
      <span className="explorer-title">AGENTES</span>
      <button
        className="git-icon-btn"
        title="Novo agente"
        aria-label="Novo agente"
        disabled={disabled}
        onClick={onCreate}
      >
        <Codicon name="add" size={16} />
      </button>
    </div>
  );
}

function ConversationList({
  conversations,
  selectedId,
  onOpen,
}: {
  conversations: AgentConversation[];
  selectedId: string | null;
  onOpen: (conversation: AgentConversation) => void;
}) {
  if (conversations.length === 0) {
    return <div className="panel-empty">Nenhuma conversa salva.</div>;
  }

  return (
    <div className="agent-history-list">
      {[...conversations]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((conversation) => (
          <button
            key={conversation.id}
            className={`agent-history-row${
              selectedId === conversation.id ? " selected" : ""
            }`}
            onClick={() => onOpen(conversation)}
          >
            <Codicon name="timeline" size={14} />
            <span>{conversation.title}</span>
          </button>
        ))}
    </div>
  );
}
