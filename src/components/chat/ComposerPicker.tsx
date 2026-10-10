import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";

export interface PickerItem {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  /** Bolinha de cor (agentes personalizados). */
  color?: string;
  disabled?: boolean;
  /** Selo curto à direita ("não instalado", "prévia"). */
  badge?: string;
  /** Item perigoso (Bypass): destaque de alerta. */
  danger?: boolean;
}

export interface PickerSection {
  label?: string;
  items: PickerItem[];
}

/**
 * Popover de seleção do composer (padrão dos seletores do Copilot/Claude
 * Code): botão compacto abre um menu com ícone + título + descrição e check no
 * selecionado. WAI-ARIA de menu com navegação por setas/Home/End, Enter/Espaço
 * escolhe, Esc fecha devolvendo o foco ao botão. `align` ancora o menu numa
 * das bordas do botão para não vazar da sidebar.
 */
export function ComposerPicker({
  triggerIcon,
  triggerLabel,
  triggerTitle,
  menuLabel,
  align,
  sections,
  selectedId,
  disabled,
  onSelect,
  footer,
  triggerClassName,
}: {
  triggerIcon?: string;
  triggerLabel: string;
  triggerTitle: string;
  menuLabel: string;
  align: "start" | "end";
  sections: PickerSection[];
  selectedId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  footer?: { label: string; icon: IconAction; onClick: () => void };
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const items = sections.flatMap((section) => section.items);
  const focusables = [...items.map((item) => !item.disabled), ...(footer ? [true] : [])];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    // Foco inicial no item selecionado (ou no primeiro habilitado).
    const selectedIndex = items.findIndex((item) => item.id === selectedId && !item.disabled);
    const first = selectedIndex >= 0 ? selectedIndex : focusables.indexOf(true);
    requestAnimationFrame(() => itemRefs.current[first]?.focus());
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveFocus = (from: number, step: number) => {
    const total = focusables.length;
    for (let i = 1; i <= total; i += 1) {
      const index = (from + step * i + total) % total;
      if (focusables[index]) {
        itemRefs.current[index]?.focus();
        return;
      }
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex((element) => element === document.activeElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(current, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(current < 0 ? 0 : current, -1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(-1, 1);
        break;
      case "End":
        event.preventDefault();
        moveFocus(focusables.length, -1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  let index = -1;
  return (
    <div className="fc-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`fc-picker-trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={triggerTitle}
      >
        {triggerIcon && <Codicon name={triggerIcon as IconAction} size={13} />}
        <span className="fc-picker-trigger-label">{triggerLabel}</span>
        <Codicon name="chevronDown" size={12} />
      </button>
      {open && (
        <div
          id={menuId}
          className={`fc-picker-menu align-${align}`}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={onMenuKeyDown}
        >
          {sections.map((section, sectionIndex) => (
            <div key={section.label ?? sectionIndex} role="group" aria-label={section.label}>
              {section.label && <div className="fc-picker-section">{section.label}</div>}
              {section.items.map((item) => {
                index += 1;
                const itemIndex = index;
                const selected = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    ref={(element) => {
                      itemRefs.current[itemIndex] = element;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    aria-disabled={item.disabled || undefined}
                    tabIndex={-1}
                    className={`fc-picker-item${selected ? " active" : ""}${item.danger ? " danger" : ""}${
                      item.disabled ? " disabled" : ""
                    }`}
                    onClick={() => {
                      if (item.disabled) return;
                      onSelect(item.id);
                      close();
                    }}
                  >
                    <span className="fc-picker-item-icon" aria-hidden="true">
                      {item.color ? (
                        <span className="fc-color-dot" style={{ backgroundColor: item.color }} />
                      ) : item.icon ? (
                        <Codicon name={item.icon as IconAction} size={14} />
                      ) : null}
                    </span>
                    <span className="fc-picker-item-text">
                      <span className="fc-picker-item-label">
                        {item.label}
                        {item.badge && <span className="fc-badge">{item.badge}</span>}
                      </span>
                      {item.hint && <span className="fc-picker-item-hint">{item.hint}</span>}
                    </span>
                    <span className="fc-picker-item-check" aria-hidden="true">
                      {selected && <Codicon name="success" size={13} />}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {footer && (
            <>
              <div className="fc-picker-divider" role="separator" />
              <button
                ref={(element) => {
                  itemRefs.current[items.length] = element;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="fc-picker-item fc-picker-footer"
                onClick={() => {
                  close(false);
                  footer.onClick();
                }}
              >
                <span className="fc-picker-item-icon" aria-hidden="true">
                  <Codicon name={footer.icon} size={14} />
                </span>
                <span className="fc-picker-item-text">
                  <span className="fc-picker-item-label">{footer.label}</span>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
