import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { acpModels } from "../../acp/providers";
import { createLocalId } from "../../agents/store";
import { AGENT_MODES, type AgentEditorContext, type AgentMode } from "../../agents/types";
import {
  addAttachment,
  attachmentIcon,
  attachmentLabel,
  type ChatAttachment,
} from "../../chat/context";
import {
  findMentionTrigger,
  mentionSuggestions,
  removeMentionToken,
  type MentionKind,
  type MentionSuggestion,
  type MentionTrigger,
} from "../../chat/mentions";
import { MODE_META } from "../../chat/modes";
import type { ChatTarget } from "../../chat/targets";
import type { FluentChatState } from "../../chat/useFluentChat";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import type { ProjectFile } from "../../types";
import { ComposerPicker, type PickerSection } from "./ComposerPicker";

export interface ChatComposerHandle {
  focus: () => void;
  setDraft: (text: string) => void;
  /** Anexa um contexto pelo tipo de menção (sugestões do welcome, paleta). */
  attach: (kind: MentionKind) => void;
}

const MAX_TEXTAREA = 240;

interface Props {
  chat: FluentChatState;
  readEditorContext: () => AgentEditorContext | null;
  listFiles: () => Promise<ProjectFile[]>;
  onManageAgents: () => void;
}

/**
 * Composer do Fluent Chat (estilo Copilot/Claude Code): campo multilinha com
 * auto-altura, Enter envia / Shift+Enter quebra linha, menções `#`/`@` com
 * popup navegável por teclado, chips de contexto e a barra inferior com os
 * seletores de agente, modo e modelo + enviar/parar.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  { chat, readEditorContext, listFiles, onManageAgents },
  ref,
) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [trigger, setTrigger] = useState<MentionTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const hintId = useId();
  const { target, mode, busy } = chat;

  const suggestions: MentionSuggestion[] = useMemo(
    () => (trigger ? mentionSuggestions(trigger, files ?? []).slice(0, 14) : []),
    [trigger, files],
  );
  const popupOpen = trigger !== null && suggestions.length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.trigger, trigger?.query]);

  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), 4000);
    return () => window.clearTimeout(timer);
  }, [hint]);

  // Índice de arquivos do Quick Open carregado sob demanda no 1º `#`.
  useEffect(() => {
    if (trigger?.trigger !== "#" || files !== null) return;
    let alive = true;
    listFiles()
      .then((list) => alive && setFiles(list))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [trigger, files, listFiles]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA)}px`;
  }, [draft]);

  const attachKind = (kind: MentionKind): boolean => {
    const editor = readEditorContext();
    const id = createLocalId("ctx");
    let next: ChatAttachment | null = null;
    switch (kind) {
      case "activeFile":
        if (!editor) {
          setHint("Nenhum arquivo aberto no editor.");
          return false;
        }
        next = { id, kind: "file", path: editor.path, name: editor.name };
        break;
      case "selection":
        if (!editor?.selectionText) {
          setHint("Selecione um trecho no editor para anexar.");
          return false;
        }
        next = { id, kind: "selection", context: editor };
        break;
      case "graph":
        if (!editor) {
          setHint("Abra um arquivo para anexar a vizinhança dele no grafo.");
          return false;
        }
        next = { id, kind: "graph", path: editor.path, name: editor.name };
        break;
      case "file":
        return false;
      default:
        next = { id, kind } as ChatAttachment;
    }
    setAttachments((list) => addAttachment(list, next!));
    return true;
  };

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setDraft: (text: string) => {
      setDraft(text);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(text.length, text.length);
      });
    },
    attach: (kind) => {
      attachKind(kind);
    },
  }));

  const updateTrigger = (text: string, caret: number) => {
    setTrigger(findMentionTrigger(text, caret));
  };

  const pick = (suggestion: MentionSuggestion) => {
    if (!trigger) return;
    const { text, caret } = removeMentionToken(draft, trigger);
    setDraft(text);
    setTrigger(null);
    if (suggestion.type === "file") {
      setAttachments((list) =>
        addAttachment(list, {
          id: createLocalId("ctx"),
          kind: "file",
          path: suggestion.file.path,
          name: suggestion.file.name,
        }),
      );
    } else {
      attachKind(suggestion.mention.kind);
    }
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const submit = () => {
    const message = draft.trim();
    if (!message || busy) return;
    const sending = attachments;
    setDraft("");
    setAttachments([]);
    setTrigger(null);
    void chat.send(message, sending);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (popupOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTrigger(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Backspace" && draft === "" && attachments.length) {
      setAttachments((list) => list.slice(0, -1));
    }
  };

  const openMentionPopup = () => {
    const element = textareaRef.current;
    if (!element) return;
    const caret = element.selectionStart ?? draft.length;
    const needsSpace = caret > 0 && !/\s/.test(draft[caret - 1]);
    const insert = `${needsSpace ? " " : ""}#`;
    const text = draft.slice(0, caret) + insert + draft.slice(caret);
    const nextCaret = caret + insert.length;
    setDraft(text);
    setTrigger(findMentionTrigger(text, nextCaret));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
    });
  };

  // ---- Seletores ----
  const targetSections: PickerSection[] = useMemo(() => {
    const providers = chat.targets.filter((candidate) => candidate.kind === "provider");
    const agents = chat.targets.filter((candidate) => candidate.kind === "agent");
    const toItem = (candidate: ChatTarget) => ({
      id: candidate.id,
      label: candidate.label,
      hint: candidate.installed ? candidate.description : `Instale com: ${candidate.installHint}`,
      icon: candidate.icon,
      color: candidate.kind === "agent" ? candidate.color : undefined,
      disabled: !candidate.installed,
      badge: candidate.installed ? undefined : "não instalado",
    });
    const sections: PickerSection[] = [{ label: "Provedores", items: providers.map(toItem) }];
    if (agents.length) sections.push({ label: "Agentes personalizados", items: agents.map(toItem) });
    return sections;
  }, [chat.targets]);

  const modeSections: PickerSection[] = [
    {
      items: AGENT_MODES.map((id) => ({
        id,
        label: MODE_META[id].label,
        hint: MODE_META[id].hint,
        icon: MODE_META[id].icon,
        danger: id === "bypass",
      })),
    },
  ];

  const models = acpModels(target.provider, chat.dynamicModels);
  const currentModel = models.find((candidate) => candidate.id === chat.model) ?? models[0];
  const modeMeta = MODE_META[mode];

  return (
    <div className="fc-composer">
      {mode === "bypass" && (
        <div className="fc-bypass-warning" role="note">
          <Codicon name="warning" size={14} />
          <span>
            <strong>Modo Bypass ativo.</strong> {modeMeta.warning}
          </span>
        </div>
      )}
      <div className={`fc-composer-box${busy ? " busy" : ""}`}>
        {attachments.length > 0 && (
          <ul className="fc-chips" aria-label="Contexto anexado">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="fc-chip">
                <Codicon name={attachmentIcon(attachment) as IconAction} size={12} />
                <span className="fc-chip-label">{attachmentLabel(attachment)}</span>
                <button
                  type="button"
                  className="fc-chip-remove"
                  aria-label={`Remover ${attachmentLabel(attachment)}`}
                  onClick={() => setAttachments((list) => list.filter((item) => item.id !== attachment.id))}
                >
                  <Codicon name="close" size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {hint && (
          <div id={hintId} className="fc-composer-hint" role="status">
            {hint}
          </div>
        )}
        <div className="fc-textarea-wrap">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={`Pergunte ao ${target.label} — # para contexto, @workspace para o projeto`}
            aria-label={`Mensagem para ${target.label}`}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={popupOpen}
            aria-controls={popupOpen ? listboxId : undefined}
            aria-activedescendant={popupOpen ? `${listboxId}-${activeIndex}` : undefined}
            aria-describedby={hint ? hintId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              updateTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) =>
              updateTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)
            }
            onBlur={() => window.setTimeout(() => setTrigger(null), 150)}
            onKeyDown={onKeyDown}
          />
          {popupOpen && (
            <ul id={listboxId} className="fc-mention-popup" role="listbox" aria-label="Contexto para anexar">
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.id}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`fc-mention-item${index === activeIndex ? " active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(suggestion);
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  {suggestion.type === "mention" ? (
                    <>
                      <Codicon name={suggestion.mention.icon as IconAction} size={14} />
                      <span className="fc-mention-name">
                        {suggestion.mention.trigger}
                        {suggestion.mention.name}
                      </span>
                      <span className="fc-mention-desc">{suggestion.mention.description}</span>
                    </>
                  ) : (
                    <>
                      <Codicon name="file" size={14} />
                      <span className="fc-mention-name">{suggestion.file.name}</span>
                      <span className="fc-mention-desc">{suggestion.file.rel}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="fc-composer-toolbar">
          <div className="fc-toolbar-start">
            <button
              type="button"
              className="fc-icon-button"
              onClick={openMentionPopup}
              aria-label="Anexar contexto (#)"
              title="Anexar contexto (#)"
            >
              <Codicon name="attachContext" size={14} />
            </button>
            <ComposerPicker
              triggerIcon={target.kind === "agent" ? target.icon : target.icon}
              triggerLabel={target.label}
              triggerTitle={`Agente: ${target.label}`}
              menuLabel="Escolher provedor ou agente"
              align="start"
              sections={targetSections}
              selectedId={target.id}
              disabled={busy}
              onSelect={chat.selectTarget}
              footer={{ label: "Gerenciar agentes…", icon: "settings", onClick: onManageAgents }}
            />
            <ComposerPicker
              triggerIcon={modeMeta.icon}
              triggerLabel={modeMeta.label}
              triggerTitle={`Modo: ${modeMeta.label} — ${modeMeta.hint}`}
              menuLabel="Modo do agente"
              align="start"
              sections={modeSections}
              selectedId={mode}
              disabled={busy}
              onSelect={(id) => chat.setMode(id as AgentMode)}
              triggerClassName={mode === "bypass" ? "danger" : undefined}
            />
          </div>
          <div className="fc-toolbar-end">
            <ComposerPicker
              triggerIcon="model"
              triggerLabel={currentModel.label}
              triggerTitle={`Modelo: ${currentModel.label}${currentModel.hint ? ` — ${currentModel.hint}` : ""}`}
              menuLabel="Modelo"
              align="end"
              sections={[
                { items: models.map((entry) => ({ id: entry.id || "__default", label: entry.label, hint: entry.hint })) },
              ]}
              selectedId={currentModel.id || "__default"}
              disabled={busy}
              onSelect={(id) => chat.setModel(id === "__default" ? "" : id)}
            />
            {busy ? (
              <button
                type="button"
                className="fc-send-button stop"
                onClick={chat.stop}
                aria-label="Parar resposta"
                title="Parar resposta"
              >
                <Codicon name="stop" size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="fc-send-button"
                onClick={submit}
                disabled={!draft.trim()}
                aria-label="Enviar mensagem"
                title="Enviar (Enter) · nova linha (Shift+Enter)"
              >
                <Codicon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
