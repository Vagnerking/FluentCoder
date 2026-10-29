import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AgentEditorContext, ChatFileDiff } from "../../agents/types";
import type { MentionKind } from "../../chat/mentions";
import { resolveTarget } from "../../chat/targets";
import { diffTexts } from "../../chat/transcript";
import type { FluentChatState } from "../../chat/useFluentChat";
import { ExtensionDiffDialog, type ExtDocumentView } from "../../extensions/ExtensionDiffDialog";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import type { ProjectFile } from "../../types";
import { IconButton } from "../ui";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { ChatHistory } from "./ChatHistory";
import { ChatTranscript } from "./ChatTranscript";
import "./fluentChat.css";

export interface FluentChatViewHandle {
  focusComposer: () => void;
  newConversation: () => void;
  showHistory: () => void;
  /** Anexa contexto ao composer (ação "Adicionar ao contexto do chat"). */
  attach: (kind: MentionKind) => void;
}

const SUGGESTIONS: { label: string; text: string; attach?: MentionKind; icon: IconAction }[] = [
  { label: "Explicar o arquivo aberto", text: "Explique o que este arquivo faz e como ele se encaixa no projeto.", attach: "activeFile", icon: "file" },
  { label: "Corrigir os problemas", text: "Analise os erros e avisos e proponha correções.", attach: "problems", icon: "warning" },
  { label: "Visão geral do projeto", text: "Como este projeto está organizado? Quais são as partes principais?", attach: "workspace", icon: "workspaceContext" },
  { label: "Testes para a seleção", text: "Escreva testes para o trecho selecionado.", attach: "selection", icon: "selection" },
];

/**
 * View "Fluent Chat": cabeçalho com nova conversa/histórico/configurar agentes,
 * o transcript (ou o welcome com sugestões, pronto para digitar — sem precisar
 * criar agente) e o composer. A configuração de agentes é um diálogo
 * (`AgentsSettingsDialog`), não outra aba.
 */
export const FluentChatView = forwardRef<
  FluentChatViewHandle,
  {
    chat: FluentChatState;
    readEditorContext: () => AgentEditorContext | null;
    listFiles: () => Promise<ProjectFile[]>;
    onOpenFile: (path: string, line?: number) => void;
    /** Abre "Configurar agentes" (engrenagem do cabeçalho e "Gerenciar agentes…" do composer). */
    onManageAgents: () => void;
  }
>(function FluentChatView({ chat, readEditorContext, listFiles, onOpenFile, onManageAgents }, ref) {
  const [showHistory, setShowHistory] = useState(false);
  const [diffView, setDiffView] = useState<ExtDocumentView | null>(null);
  const composerRef = useRef<ChatComposerHandle>(null);
  const conversation = chat.activeConversation;
  const target = chat.target;

  useImperativeHandle(ref, () => ({
    focusComposer: () => {
      setShowHistory(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    newConversation: () => {
      setShowHistory(false);
      chat.startNewConversation();
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    showHistory: () => setShowHistory(true),
    attach: (kind) => {
      setShowHistory(false);
      requestAnimationFrame(() => {
        composerRef.current?.attach(kind);
        composerRef.current?.focus();
      });
    },
  }));

  const openDiff = useCallback((diff: ChatFileDiff) => {
    const { oldText, newText } = diffTexts(diff);
    const name = diff.path.split(/[\\/]/).pop() ?? diff.path;
    setDiffView({
      kind: "diff",
      title: `${name} — alteração proposta pelo agente`,
      left: { uri: `fluent-diff:antes/${diff.path}`, path: diff.path, content: oldText },
      right: { uri: `fluent-diff:depois/${diff.path}`, path: diff.path, content: newText },
    });
  }, []);

  const { retryLast, editLast, revert } = chat;
  const conversationId = conversation?.id ?? null;
  const actions = useMemo(
    () => ({
      workspacePath: chat.rootPath,
      agentLabel: target.label,
      agentIcon: target.icon,
      busy: chat.busy,
      onOpenFile,
      onOpenDiff: openDiff,
      onRetry: retryLast,
      onEdit: () => {
        const text = editLast();
        if (text !== null) composerRef.current?.setDraft(text);
      },
      onRevert: (messageId: string) => {
        if (conversationId) void revert(conversationId, messageId);
      },
    }),
    [chat.rootPath, chat.busy, target.label, target.icon, onOpenFile, openDiff, retryLast, editLast, revert, conversationId],
  );

  if (!chat.rootPath) {
    return (
      <div className="fc-view">
        <div className="fc-welcome">
          <Codicon name="fluentChat" size={32} />
          <h2>Fluent Chat</h2>
          <p>Abra uma pasta para conversar com agentes de IA sobre o seu código.</p>
        </div>
      </div>
    );
  }

  const hasMessages = !!conversation?.messages.length;
  return (
    <div className="fc-view">
      <header className="fc-header">
        <h2 className="fc-header-title" title={conversation?.title}>
          {showHistory ? "Histórico" : conversation?.title ?? "Nova conversa"}
        </h2>
        <div className="fc-header-actions">
          <IconButton
            size="sm"
            icon="add"
            label="Nova conversa"
            tooltipPlacement="bottom"
            onClick={() => {
              setShowHistory(false);
              chat.startNewConversation();
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
          />
          <IconButton
            size="sm"
            icon="timeline"
            label="Histórico de conversas"
            tooltipPlacement="bottom"
            pressed={showHistory}
            onClick={() => setShowHistory((value) => !value)}
          />
          <IconButton
            size="sm"
            icon="settings"
            label="Configurar agentes"
            tooltipPlacement="bottom"
            onClick={onManageAgents}
          />
        </div>
      </header>

      {showHistory ? (
        <ChatHistory
          conversations={chat.conversations}
          activeId={conversationId}
          resolve={(agentId) => resolveTarget(agentId, chat.providers, chat.agents)}
          onOpen={(id) => {
            chat.openConversation(id);
            setShowHistory(false);
          }}
          onRename={chat.renameConversation}
          onDelete={chat.deleteConversation}
        />
      ) : (
        <>
          {hasMessages && conversation ? (
            <ChatTranscript
              conversationId={conversation.id}
              messages={conversation.messages}
              thought={chat.thought}
              status={chat.status}
              error={chat.error}
              approvals={chat.approvals}
              actions={actions}
              onRespondApproval={chat.respondApproval}
              onDismissError={chat.dismissError}
            />
          ) : (
            <div className="fc-welcome-scroll">
              <div className="fc-welcome">
                <Codicon name="fluentChat" size={32} />
                <h2>Fluent Chat</h2>
                <p>
                  Converse com <strong>{target.label}</strong> sobre este workspace. Use <kbd>#</kbd> para
                  anexar contexto e <kbd>@workspace</kbd> para buscar no projeto.
                </p>
                {!target.installed && chat.providersLoaded ? (
                  <div className="fc-install-card" role="note">
                    <Codicon name="info" size={14} />
                    <div>
                      <strong>{target.label} não está instalado.</strong>
                      <span>
                        Instale com <code>{target.installHint}</code> e reabra o chat, ou escolha outro agente
                        abaixo.
                      </span>
                    </div>
                  </div>
                ) : (
                  <ul className="fc-suggestions" aria-label="Sugestões">
                    {SUGGESTIONS.map((suggestion) => (
                      <li key={suggestion.label}>
                        <button
                          type="button"
                          className="fc-suggestion"
                          onClick={() => {
                            composerRef.current?.setDraft(suggestion.text);
                            if (suggestion.attach) composerRef.current?.attach(suggestion.attach);
                          }}
                        >
                          <Codicon name={suggestion.icon} size={14} />
                          {suggestion.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {chat.error && (
                <div className="fc-error" role="alert">
                  <Codicon name="error" size={14} />
                  <span>{chat.error}</span>
                  <button type="button" className="fc-msg-action" aria-label="Dispensar erro" onClick={chat.dismissError}>
                    <Codicon name="close" size={12} />
                  </button>
                </div>
              )}
              {chat.status && chat.busy && (
                <div className="fc-status" role="status">
                  <Codicon name="loading" size={13} />
                  {chat.status}
                </div>
              )}
            </div>
          )}
          <ChatComposer
            ref={composerRef}
            chat={chat}
            readEditorContext={readEditorContext}
            listFiles={listFiles}
            onManageAgents={onManageAgents}
          />
        </>
      )}
      {diffView && <ExtensionDiffDialog view={diffView} onClose={() => setDiffView(null)} />}
    </div>
  );
});
