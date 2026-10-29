import { useMemo, useState } from "react";
import type { AgentConversation } from "../../agents/types";
import { filterConversations, groupConversationsByDate } from "../../chat/history";
import type { ChatTarget } from "../../chat/targets";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { IconButton } from "../ui";

/**
 * Histórico de conversas do workspace: busca (título + mensagens), grupos por
 * data, renomear inline e excluir com confirmação.
 */
export function ChatHistory({
  conversations,
  activeId,
  resolve,
  onOpen,
  onRename,
  onDelete,
}: {
  conversations: AgentConversation[];
  activeId: string | null;
  resolve: (agentId: string) => ChatTarget | null;
  onOpen: (conversationId: string) => void;
  onRename: (conversationId: string, title: string) => void;
  onDelete: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const groups = useMemo(
    () => groupConversationsByDate(filterConversations(conversations, query)),
    [conversations, query],
  );

  const commitRename = () => {
    if (renaming && renaming.title.trim()) onRename(renaming.id, renaming.title.trim());
    setRenaming(null);
  };

  return (
    <div className="fc-history">
      <div className="fc-search">
        <Codicon name="search" size={13} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar conversas"
          aria-label="Buscar conversas"
          autoFocus
        />
      </div>
      {groups.length === 0 ? (
        <div className="fc-empty">
          {query ? "Nenhuma conversa encontrada." : "Nenhuma conversa ainda. Envie uma mensagem para começar."}
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.label} className="fc-history-group" aria-label={group.label}>
            <h3 className="fc-section-label">{group.label}</h3>
            <ul className="fc-history-list">
              {group.conversations.map((conversation) => {
                const target = resolve(conversation.agentId);
                const editing = renaming?.id === conversation.id;
                return (
                  <li
                    key={conversation.id}
                    className={`fc-history-row${conversation.id === activeId ? " selected" : ""}`}
                  >
                    {editing ? (
                      <input
                        className="fc-rename-input"
                        value={renaming.title}
                        autoFocus
                        aria-label="Novo nome da conversa"
                        onChange={(event) => setRenaming({ id: conversation.id, title: event.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitRename();
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            setRenaming(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="fc-history-main"
                        onClick={() => onOpen(conversation.id)}
                        aria-current={conversation.id === activeId || undefined}
                      >
                        {target?.color ? (
                          <span className="fc-color-dot" style={{ backgroundColor: target.color }} aria-hidden="true" />
                        ) : (
                          <Codicon name={(target?.icon ?? "fluentChat") as IconAction} size={13} />
                        )}
                        <span className="fc-history-title">{conversation.title}</span>
                        <span className="fc-history-meta">{target?.label ?? "Agente removido"}</span>
                      </button>
                    )}
                    {!editing && (
                      <span className="fc-row-actions">
                        <IconButton
                          size="sm"
                          icon="rename"
                          label={`Renomear "${conversation.title}"`}
                          onClick={() => setRenaming({ id: conversation.id, title: conversation.title })}
                        />
                        <IconButton
                          size="sm"
                          icon="delete"
                          label={`Excluir "${conversation.title}"`}
                          onClick={() => {
                            if (window.confirm(`Excluir a conversa "${conversation.title}"?`)) {
                              onDelete(conversation.id);
                            }
                          }}
                        />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
