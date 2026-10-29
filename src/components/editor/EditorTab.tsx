import type { DragEvent, KeyboardEvent, MouseEvent, Ref } from "react";
import type { FileDecoration, OpenFile } from "../../types";
import { FileIcon } from "../../icon-theme/material/FileIcon";
import { Codicon } from "../../icons/codicons/Codicon";
import { Tooltip } from "../Tooltip";

export interface EditorTabProps {
  file: OpenFile;
  active: boolean;
  /** Recebe o Tab (foco itinerante: só uma aba com tabIndex 0). */
  tabStop: boolean;
  /** Sufixo de pasta para homônimos (`…/git`). */
  description?: string;
  decoration?: FileDecoration;
  /** Classes de arraste (`dragging`, `drag-over-left|right`). */
  dragClass: string;
  tabRef?: Ref<HTMLDivElement>;
  drag: {
    draggable: boolean;
    onDrag: (e: DragEvent<HTMLDivElement>) => void;
    onDragStart: (e: DragEvent<HTMLDivElement>) => void;
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  };
  onSelect: () => void;
  onClose: () => void;
  /** Duplo clique: tira do modo preview (mantém aberta). */
  onKeepOpen?: () => void;
  /** Desafixar pelo botão de pino. */
  onUnpin?: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void;
}

/**
 * Uma aba do editor: ícone do arquivo, nome (itálico em preview), sufixo de
 * pasta para homônimos, e o botão de fechar — que mostra o ponto de "não
 * salvo" e troca para o X no hover. Abas fixadas mostram o pino (desafixar).
 */
export function EditorTab({
  file: f,
  active,
  tabStop,
  description,
  decoration,
  dragClass,
  tabRef,
  drag,
  onSelect,
  onClose,
  onKeepOpen,
  onUnpin,
  onKeyDown,
  onFocus,
  onContextMenu,
}: EditorTabProps) {
  const pinned = !!f.pinned;
  const closeLabel = pinned
    ? `Desafixar ${f.name}`
    : f.dirty
      ? `Fechar ${f.name} (não salvo)`
      : `Fechar ${f.name}`;
  return (
    <div
      ref={tabRef}
      role="tab"
      tabIndex={tabStop ? 0 : -1}
      data-path={f.path}
      aria-selected={active}
      aria-label={`${f.name}${description ? `, ${description}` : ""}${f.dirty ? ", não salvo" : ""}${pinned ? ", fixada" : ""}${f.preview ? ", visualização" : ""}`}
      className={
        `tab${active ? " active" : ""}` +
        (f.readOnly ? " readonly" : "") +
        (f.preview ? " preview" : "") +
        (pinned ? " pinned" : "") +
        dragClass
      }
      {...drag}
      onClick={onSelect}
      onDoubleClick={onKeepOpen}
      onAuxClick={(e) => {
        // Botão do meio fecha (como no VS Code).
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
      title={f.sourceLabel ?? f.path}
    >
      <FileIcon path={f.sourcePath ?? f.path} className="tab-icon" />
      {f.readOnly && <Codicon name="lock" size={12} />}
      <span className={`tab-name${decoration ? ` deco-${decoration.kind}` : ""}`}>{f.name}</span>
      {description && <span className="tab-description">{description}</span>}
      <Tooltip label={pinned ? "Desafixar" : f.dirty ? "Fechar (alterações não salvas)" : "Fechar"} placement="bottom">
        <button
          type="button"
          className={`tab-close${f.dirty ? " dirty" : ""}${pinned ? " tab-pin" : ""}`}
          aria-label={closeLabel}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            if (pinned) onUnpin?.();
            else onClose();
          }}
        >
          {/* Suja: mostra o ponto; o hover troca pelo X (ou pino) via CSS. */}
          {f.dirty && <span className="tab-dirty-dot" aria-hidden="true" />}
          <Codicon name={pinned ? "pinned" : "close"} size={14} className="tab-close-glyph" />
        </button>
      </Tooltip>
    </div>
  );
}
