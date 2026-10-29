import { useRef, useState } from "react";
import type { IconAction } from "../../../icons/codicons/codicon-map";
import { IconButton } from "../IconButton";
import { Menu, type MenuItemSpec } from "../Menu";
import { cx } from "../cx";
import type { Rect } from "../menuLogic";
import { fitActions } from "./viewPaneLayout";

/** Uma ação de cabeçalho (pane, grupo, linha de raiz…). */
export interface PaneAction {
  id: string;
  icon: IconAction;
  /** Rótulo acessível + tooltip + texto no menu "…". */
  label: string;
  run?: () => void;
  disabled?: boolean;
  /** Toggle ligado (fica visível mesmo fora do hover). */
  pressed?: boolean;
  spin?: boolean;
  /** Vai sempre para o menu "…" (nunca inline). */
  overflowOnly?: boolean;
}

/** Largura de um slot de botão `sm` (24 px) + o gap (2 px). */
export const ACTION_SLOT = 26;

export interface ActionBarProps {
  actions: readonly PaneAction[];
  /** Largura disponível (px) para a barra; 0 = ainda não medida (tudo inline). */
  width: number;
  ariaLabel: string;
  /** Rótulo do botão "…". */
  moreLabel?: string;
  className?: string;
  tooltipPlacement?: "top" | "bottom" | "left" | "right";
}

/**
 * Barra de ações com overflow automático: mostra inline as que cabem em
 * `width` e manda o excedente (e as `overflowOnly`) para um menu "…". Quando
 * nada cabe, sobra ao menos o "…" — a ação nunca fica inalcançável.
 */
export function ActionBar({
  actions,
  width,
  ariaLabel,
  moreLabel = "Mais ações",
  className,
  tooltipPlacement = "bottom",
}: ActionBarProps) {
  const [menu, setMenu] = useState<Rect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const candidates = actions.filter((a) => !a.overflowOnly);
  const forced = actions.some((a) => a.overflowOnly);
  const fit = width > 0 ? fitActions(candidates.length, width, ACTION_SLOT, forced) : { inline: candidates.length, menu: forced };
  const inline = candidates.slice(0, fit.inline);
  const overflow = [...candidates.slice(fit.inline), ...actions.filter((a) => a.overflowOnly)];
  if (inline.length === 0 && overflow.length === 0) return null;

  const items: MenuItemSpec[] = overflow.map((a) => ({
    id: a.id,
    label: a.label,
    icon: a.icon,
    disabled: a.disabled,
    checked: a.pressed,
    onSelect: a.run,
  }));

  return (
    <div className={cx("ui-action-bar", className)} role="toolbar" aria-label={ariaLabel} ref={rootRef}>
      {inline.map((a) => (
        <IconButton
          key={a.id}
          icon={a.icon}
          label={a.label}
          size="sm"
          pressed={a.pressed}
          spin={a.spin}
          disabled={a.disabled}
          tooltipPlacement={tooltipPlacement}
          className="ui-action-bar-item"
          onClick={(e) => {
            e.stopPropagation();
            a.run?.();
          }}
        />
      ))}
      {overflow.length > 0 && (
        <IconButton
          icon="more"
          label={moreLabel}
          size="sm"
          tooltipPlacement={tooltipPlacement}
          className="ui-action-bar-item ui-action-bar-more"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu((cur) => (cur ? null : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
          }}
        />
      )}
      {menu && (
        <Menu
          ariaLabel={moreLabel}
          anchor={{ rect: menu, placement: "bottom-start" }}
          items={items}
          minWidth={200}
          isInside={(t) => !!rootRef.current?.contains(t)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
