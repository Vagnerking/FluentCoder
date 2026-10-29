import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { FluentChatState } from "../../chat/useFluentChat";
import { Codicon } from "../../icons/codicons/Codicon";
import { IconButton } from "../ui";
import { useModalDismiss } from "../useModalDismiss";
import { useModalFocus } from "../useModalFocus";
import { AgentsManager } from "./AgentsManager";

/**
 * "Configurar agentes" do Fluent Chat: o `AgentsManager` (agentes
 * personalizados, provedores, presets) num diálogo modal — antes era uma aba
 * "Agentes" ao lado do chat. Aberto pela engrenagem do cabeçalho do chat, pelo
 * "Gerenciar agentes…" do seletor do composer e pela Paleta.
 */
export function AgentsSettingsDialog({
  chat,
  onClose,
  onStartChat,
}: {
  chat: FluentChatState;
  onClose: () => void;
  /** "Conversar" com um agente: fecha o diálogo e abre o chat com ele. */
  onStartChat: (targetId: string) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(surfaceRef, { onEscape: onClose });
  const dismiss = useModalDismiss(onClose);

  return createPortal(
    <div className="confirm-overlay agents-settings-overlay" {...dismiss}>
      <div className="agents-settings" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={surfaceRef}>
        <header className="agents-settings-header">
          <Codicon name="settings" size={18} />
          <h2 id={titleId} className="agents-settings-title">
            Configurar agentes
          </h2>
          <IconButton icon="close" size="sm" label="Fechar" tooltipPlacement="bottom" onClick={onClose} />
        </header>
        <div className="agents-settings-body">
          <AgentsManager chat={chat} onStartChat={onStartChat} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
