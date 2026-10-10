import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, ChatApproval, ChatFileDiff } from "../../agents/types";
import { MODE_META } from "../../chat/modes";
import { formatUsage, interleaveTranscript } from "../../chat/transcript";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { ChatMarkdown } from "./ChatMarkdown";
import { ApprovalCard, ToolCallCard } from "./ToolCards";

/** Mensagens renderizadas de uma vez; o restante entra sob demanda. */
const PAGE = 40;

interface MessageActions {
  workspacePath: string | null;
  agentLabel: string;
  agentIcon: string;
  busy: boolean;
  onOpenFile: (path: string, line?: number) => void;
  onOpenDiff: (diff: ChatFileDiff) => void;
  onRetry: () => void;
  onEdit: () => void;
  onRevert: (messageId: string) => void;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="fc-msg-action"
      aria-label={copied ? "Copiado" : label}
      title={copied ? "Copiado" : label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <Codicon name={copied ? "success" : "copy"} size={13} />
    </button>
  );
}

const UserMessage = memo(function UserMessage({
  message,
  isLast,
  actions,
}: {
  message: AgentMessage;
  isLast: boolean;
  actions: MessageActions;
}) {
  return (
    <article className="fc-msg user" aria-label="Sua mensagem">
      <div className="fc-msg-bubble">
        {message.attachments?.length ? (
          <ul className="fc-chips compact" aria-label="Contexto enviado">
            {message.attachments.map((attachment, index) => (
              <li key={`${attachment.label}-${index}`} className="fc-chip">
                <span className="fc-chip-label">{attachment.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="fc-msg-text">{message.content}</p>
      </div>
      <div className="fc-msg-footer">
        {message.mode && (
          <span className={`fc-mode-tag mode-${message.mode}`}>
            <Codicon name={MODE_META[message.mode].icon} size={11} />
            {MODE_META[message.mode].label}
          </span>
        )}
        {message.revert && (
          <button
            type="button"
            className="fc-msg-action labeled"
            disabled={actions.busy || message.revert.reverted}
            onClick={() => actions.onRevert(message.id)}
            title={
              message.revert.reverted
                ? "Já revertido para antes deste pedido"
                : "Reverter o código para antes deste pedido"
            }
          >
            <Codicon name="discard" size={12} />
            {message.revert.reverted ? "Revertido" : "Reverter"}
          </button>
        )}
        <span className="fc-msg-actions">
          <CopyButton text={message.content} label="Copiar mensagem" />
          {isLast && !actions.busy && (
            <button
              type="button"
              className="fc-msg-action"
              aria-label="Editar e reenviar"
              title="Editar e reenviar"
              onClick={actions.onEdit}
            >
              <Codicon name="editMessage" size={13} />
            </button>
          )}
        </span>
      </div>
    </article>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message,
  isLast,
  actions,
}: {
  message: AgentMessage;
  isLast: boolean;
  actions: MessageActions;
}) {
  const segments = useMemo(
    () => interleaveTranscript(message.content, message.toolCalls),
    [message.content, message.toolCalls],
  );
  const usage = formatUsage(message.usage);
  const streaming = message.status === "streaming";
  return (
    <article
      className={`fc-msg assistant${message.status === "error" ? " error" : ""}`}
      aria-label={`Resposta de ${actions.agentLabel}`}
      aria-busy={streaming || undefined}
    >
      <div className="fc-msg-author">
        <Codicon name={actions.agentIcon as IconAction} size={13} />
        <span>{actions.agentLabel}</span>
      </div>
      {segments.length === 0 && (
        <p className="fc-msg-placeholder">{streaming ? "Pensando…" : ""}</p>
      )}
      {segments.map((segment) =>
        segment.type === "text" ? (
          <ChatMarkdown
            key={segment.key}
            content={segment.text}
            onOpenFile={actions.onOpenFile}
            workspacePath={actions.workspacePath}
          />
        ) : (
          <div key={segment.key} className="fc-tool-group">
            {segment.calls.map((call) => (
              <ToolCallCard
                key={call.id}
                call={call}
                workspacePath={actions.workspacePath}
                onOpenFile={actions.onOpenFile}
                onOpenDiff={actions.onOpenDiff}
              />
            ))}
          </div>
        ),
      )}
      {!streaming && (
        <div className="fc-msg-footer">
          {usage && (
            <span className="fc-usage" title="Consumo informado pelo provedor">
              <Codicon name="usage" size={11} />
              {usage}
            </span>
          )}
          <span className="fc-msg-actions">
            {message.content && <CopyButton text={message.content} label="Copiar resposta" />}
            {isLast && !actions.busy && (
              <button
                type="button"
                className="fc-msg-action"
                aria-label="Tentar de novo"
                title="Tentar de novo"
                onClick={actions.onRetry}
              >
                <Codicon name="retry" size={13} />
              </button>
            )}
          </span>
        </div>
      )}
    </article>
  );
});

/**
 * Transcript da conversa: mensagens (memoizadas — o streaming só re-renderiza
 * a resposta em andamento), cartões de ferramenta intercalados, aprovações
 * pendentes, raciocínio ao vivo e status. Renderiza só as últimas mensagens
 * (com "mostrar anteriores") e cola no fim enquanto o usuário não rolar.
 */
export function ChatTranscript({
  conversationId,
  messages,
  thought,
  status,
  error,
  approvals,
  actions,
  onRespondApproval,
  onDismissError,
}: {
  conversationId: string;
  messages: AgentMessage[];
  thought: string | null;
  status: string | null;
  error: string | null;
  approvals: ChatApproval[];
  actions: MessageActions;
  onRespondApproval: (requestId: string, optionId: string) => void;
  onDismissError: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setVisibleCount(PAGE);
    stickRef.current = true;
  }, [conversationId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
  }, [messages, thought, status, approvals.length, error]);

  const hidden = Math.max(0, messages.length - visibleCount);
  const visible = hidden ? messages.slice(hidden) : messages;
  const lastUserId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const lastAssistantId = [...messages].reverse().find((message) => message.role === "assistant")?.id;

  return (
    <div
      ref={scrollRef}
      className="fc-transcript"
      onScroll={(event) => {
        const element = event.currentTarget;
        stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
    >
      {hidden > 0 && (
        <button type="button" className="fc-load-more" onClick={() => setVisibleCount((count) => count + PAGE)}>
          Mostrar {Math.min(hidden, PAGE)} mensagens anteriores
        </button>
      )}
      <div className="fc-transcript-list" role="log" aria-live="polite" aria-relevant="additions">
        {visible.map((message) =>
          message.role === "user" ? (
            <UserMessage key={message.id} message={message} isLast={message.id === lastUserId} actions={actions} />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              isLast={message.id === lastAssistantId}
              actions={actions}
            />
          ),
        )}
      </div>
      {thought && actions.busy && (
        <div className="agent-chat-thought fc-thought">
          <div className="agent-chat-thought-label">
            <Codicon name="thinking" size={12} /> Raciocínio
          </div>
          <div className="agent-chat-thought-clip">
            <div className="agent-chat-thought-text">{thought}</div>
          </div>
        </div>
      )}
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.requestId}
          approval={approval}
          workspacePath={actions.workspacePath}
          onRespond={onRespondApproval}
          onOpenDiff={actions.onOpenDiff}
        />
      ))}
      {status && actions.busy && (
        <div className="fc-status" role="status">
          <Codicon name="loading" size={13} />
          {status}
        </div>
      )}
      {error && (
        <div className="fc-error" role="alert">
          <Codicon name="error" size={14} />
          <span>{error}</span>
          <button type="button" className="fc-msg-action" aria-label="Dispensar erro" onClick={onDismissError}>
            <Codicon name="close" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
