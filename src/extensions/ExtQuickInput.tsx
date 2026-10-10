/**
 * QuickPick / InputBox das extensões (`window.createQuickPick`/`createInputBox`
 * e os `showQuickPick`/`showInputBox`): mesmo visual da Paleta/QuickPick do app
 * (classes `quick-open*`/`quick-pick*`, contrato de modal compartilhado) com o
 * que a API pede — seleção múltipla com Checkbox, itens ativos/selecionados,
 * botões do título e dos itens, `busy`, passos e mensagem de validação ao vivo.
 * Cada interação vai ao host (`quickInputEvent`), que dispara os eventos da
 * extensão (onDidChangeValue/onDidAccept/onDidTriggerButton/onDidHide…).
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Checkbox } from "../components/ui";
import { Codicon } from "../icons/codicons/Codicon";
import { useModalDismiss } from "../components/useModalDismiss";
import { useModalFocus } from "../components/useModalFocus";
import { extHost } from "./client";
import {
  filterQuickPickItems,
  moveActive,
  quickInputSnapshot,
  quickInputTitle,
  setQuickInput,
  subscribeQuickInput,
  type QuickInputButtonInfo,
  type QuickInputState,
} from "./quickInputModel";
import "./editorWidgets.css";

function send(id: string, type: string, extra: Record<string, unknown> = {}) {
  void extHost.notify("quickInputEvent", { id, type, ...extra });
}

function RawIcon({ icon }: { icon?: string }) {
  if (!icon || !/^[\w-]+$/.test(icon)) return null;
  return <span className={`codicon codicon-${icon}`} aria-hidden="true" />;
}

function InputButtons({ buttons, onClick }: { buttons: QuickInputButtonInfo[]; onClick: (b: QuickInputButtonInfo) => void }) {
  if (!buttons.length) return null;
  return (
    <div className="ext-quick-buttons">
      {buttons.map((b) => (
        <button
          key={b.index}
          type="button"
          className="ui-icon-button ui-icon-button-sm"
          aria-label={b.tooltip ?? (b.back ? "Voltar" : "Botão")}
          title={b.tooltip ?? (b.back ? "Voltar" : undefined)}
          onClick={() => onClick(b)}
        >
          <RawIcon icon={b.icon ?? (b.back ? "arrow-left" : "circle-small")} />
        </button>
      ))}
    </div>
  );
}

function QuickInputSurface({ state }: { state: QuickInputState }) {
  const isPick = state.kind === "pick";
  const [value, setValue] = useState(state.value);
  const sentValue = useRef(state.value);
  const [active, setActive] = useState<number>(state.activeIndexes?.[0] ?? -1);
  const [selected, setSelected] = useState<Set<number>>(new Set(state.selectedIndexes ?? []));
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const msgId = useId();

  const hide = () => {
    send(state.id, "hide");
    setQuickInput(null);
  };
  useModalFocus(surfaceRef, { initialFocus: inputRef, onEscape: hide });
  const dismiss = useModalDismiss(() => {
    if (!state.ignoreFocusOut) hide();
  });

  // Mudanças vindas da extensão (value/ativos/selecionados) entram no estado local.
  useEffect(() => {
    if (state.value !== sentValue.current) {
      sentValue.current = state.value;
      setValue(state.value);
    }
  }, [state.value]);
  useEffect(() => {
    if (state.activeIndexes?.length) setActive(state.activeIndexes[0]);
  }, [state.activeIndexes]);
  useEffect(() => {
    setSelected(new Set(state.selectedIndexes ?? []));
  }, [state.selectedIndexes]);

  const visible = useMemo(
    () => (isPick ? filterQuickPickItems(state.items ?? [], value, state) : []),
    [isPick, state, value],
  );
  // O ativo precisa estar visível; senão vai para o 1º selecionável.
  useEffect(() => {
    if (!isPick) return;
    if (!visible.some((i) => i.index === active && i.kind !== -1)) {
      const first = moveActive(visible, -1, 1);
      setActive(first);
      if (first >= 0) send(state.id, "active", { indexes: [first] });
    }
  }, [isPick, visible, active, state.id]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const changeValue = (v: string) => {
    setValue(v);
    sentValue.current = v;
    send(state.id, "value", { value: v });
  };
  const activate = (index: number) => {
    if (index === active) return;
    setActive(index);
    send(state.id, "active", { indexes: [index] });
  };
  const toggle = (index: number) => {
    const next = new Set(selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setSelected(next);
    send(state.id, "selection", { indexes: [...next] });
  };
  const accept = (index?: number) => {
    if (!state.enabled) return;
    if (!isPick) send(state.id, "accept");
    else if (state.canSelectMany) send(state.id, "accept", { indexes: [...selected] });
    else {
      const pick = index ?? active;
      if (pick < 0) return;
      send(state.id, "accept", { indexes: [pick] });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isPick && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const next = moveActive(visible, active, e.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) activate(next);
    } else if (isPick && state.canSelectMany && e.key === " " && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (active >= 0) toggle(active);
    } else if (e.key === "Enter") {
      e.preventDefault();
      accept();
    }
  };

  const title = quickInputTitle(state);
  const validation = !isPick ? state.validationMessage : null;
  const sev = validation ? (validation.severity >= 3 ? "error" : validation.severity === 2 ? "warning" : "info") : null;

  return (
    <div className="quick-open-backdrop" {...dismiss}>
      <div
        className={`quick-open ${isPick ? "quick-pick" : "quick-input"} ext-quick-input`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : isPick ? "Seleção rápida" : "Entrada rápida"}
        aria-busy={state.busy || undefined}
        tabIndex={-1}
        ref={surfaceRef}
      >
        {(title || state.buttons.length > 0) && (
          <div className="ext-quick-header">
            {title && (
              <div id={titleId} className="quick-pick-title">
                {title}
              </div>
            )}
            <InputButtons buttons={state.buttons} onClick={(b) => send(state.id, "button", { button: b.index })} />
          </div>
        )}
        <div className="ext-quick-input-row">
          <input
            ref={inputRef}
            className="quick-open-input"
            type={state.password ? "password" : "text"}
            placeholder={state.placeholder}
            value={value}
            disabled={!state.enabled}
            autoComplete="off"
            aria-label={title ?? state.placeholder ?? state.prompt ?? "Entrada"}
            aria-invalid={sev === "error" || undefined}
            aria-describedby={validation || state.prompt ? msgId : undefined}
            aria-controls={isPick ? `${titleId}-list` : undefined}
            aria-activedescendant={isPick && active >= 0 ? `${titleId}-opt-${active}` : undefined}
            onChange={(e) => changeValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {isPick && state.canSelectMany && (
            <button type="button" className="ui-button ui-button-primary ui-button-sm" disabled={!state.enabled} onClick={() => accept()}>
              OK
            </button>
          )}
        </div>
        <div className={`ext-quick-progress${state.busy ? " busy" : ""}`} aria-hidden="true" />
        {!isPick &&
          (validation ? (
            <div id={msgId} className={`quick-input-msg ext-quick-msg ${sev}`} role={sev === "error" ? "alert" : "status"}>
              <Codicon name={sev === "error" ? "error" : sev === "warning" ? "warning" : "info"} /> {validation.text}
            </div>
          ) : state.prompt ? (
            <div id={msgId} className="quick-input-msg">
              {state.prompt}
            </div>
          ) : null)}
        {isPick && (
          <div className="quick-open-list" role="listbox" id={`${titleId}-list`} aria-multiselectable={state.canSelectMany || undefined} ref={listRef}>
            {visible.length === 0 ? (
              <div className="quick-open-empty">{state.busy ? "Carregando…" : "Nenhum resultado."}</div>
            ) : (
              visible.map((it) =>
                it.kind === -1 ? (
                  <div key={`sep-${it.index}`} className="ext-quick-separator" role="presentation">
                    {it.label}
                  </div>
                ) : (
                  <div
                    key={it.index}
                    id={`${titleId}-opt-${it.index}`}
                    data-index={it.index}
                    role="option"
                    aria-selected={state.canSelectMany ? selected.has(it.index) : it.index === active}
                    className={`quick-pick-item${it.index === active ? " selected" : ""}`}
                    title={it.detail}
                    onMouseMove={() => activate(it.index)}
                    onClick={() => (state.canSelectMany ? toggle(it.index) : accept(it.index))}
                  >
                    {state.canSelectMany ? (
                      <Checkbox
                        aria-label={it.label}
                        checked={selected.has(it.index)}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(it.index)}
                      />
                    ) : it.icon ? (
                      <span className="quick-pick-icon">
                        <RawIcon icon={it.icon} />
                      </span>
                    ) : null}
                    <div className="quick-pick-text">
                      <span className="quick-pick-primary">
                        <span className="quick-pick-label">{it.label}</span>
                        {it.description && <span className="quick-pick-description">{it.description}</span>}
                      </span>
                      {it.detail && <span className="quick-pick-detail">{it.detail}</span>}
                    </div>
                    {it.buttons.length > 0 && (
                      <div className="ext-quick-item-buttons" onClick={(e) => e.stopPropagation()}>
                        <InputButtons buttons={it.buttons} onClick={(b) => send(state.id, "itemButton", { item: it.index, button: b.index })} />
                      </div>
                    )}
                  </div>
                ),
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Montado uma vez pelo ExtensionHostRuntime. */
export function ExtQuickInput() {
  const state = useSyncExternalStore(subscribeQuickInput, quickInputSnapshot);
  if (!state) return null;
  // `key` por id: outro quick input = estado local novo.
  return <QuickInputSurface key={state.id} state={state} />;
}
