import { forwardRef, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Codicon } from "../../../icons/codicons/Codicon";
import type { IconAction } from "../../../icons/codicons/codicon-map";
import { cx } from "../cx";
import { ActionBar, type PaneAction } from "./ActionBar";
import { useElementSize } from "./useElementSize";

export interface SectionHeaderProps {
  /**
   * 1 = cabeçalho de pane (caixa alta, `--font-caption-sm` semibold, chevron);
   * 2 = grupo dentro de um pane (sem caixa alta, `--font-caption` semibold).
   */
  level?: 1 | 2;
  title: string;
  /** Contagem ou rótulo curto (ex.: 3, "LOCAL") em badge. */
  badge?: string | number;
  /** Nome acessível do badge (ex.: "3 itens"). */
  badgeLabel?: string;
  /** Conteúdo extra à direita do título (status, chip…), antes das ações. */
  meta?: ReactNode;
  /** Ícone decorativo antes do título (opcional). */
  icon?: IconAction;
  /** Definido = recolhível (chevron + `aria-expanded`). */
  expanded?: boolean;
  onToggle?: () => void;
  /** `id` do corpo controlado (aria-controls). */
  controlsId?: string;
  actions?: readonly PaneAction[];
  /**
   * `hover` (padrão no nível 1): ações só no hover/foco; `always`: sempre.
   * Recolhido, um cabeçalho de nível 1 não mostra ações.
   */
  actionsVisibility?: "hover" | "always";
  /** Largura (px) reservada ao título antes de as ações transbordarem. */
  minTitleWidth?: number;
  onToggleKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  className?: string;
  id?: string;
}

/**
 * Cabeçalho de seção único do app (substitui `git-group-header`,
 * `run-root-header`, `backlinks-section-head`…). Título com ellipsis e
 * tooltip; badge; ações com overflow automático para "…".
 */
export const SectionHeader = forwardRef<HTMLButtonElement, SectionHeaderProps>(function SectionHeader(
  {
    level = 1,
    title,
    badge,
    badgeLabel,
    meta,
    icon,
    expanded,
    onToggle,
    controlsId,
    actions = [],
    actionsVisibility,
    minTitleWidth = 64,
    onToggleKeyDown,
    className,
    id,
  },
  toggleRef
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(rootRef);
  const collapsible = expanded !== undefined;
  const visibility = actionsVisibility ?? (level === 1 ? "hover" : "always");
  const showActions = actions.length > 0 && (!collapsible || expanded || level === 2);
  const hasBadge = badge !== undefined && badge !== null && badge !== "";
  // Reserva: padding + chevron + título mínimo + badge (+ meta estimada).
  const reserve = 12 + (collapsible ? 20 : 0) + (icon ? 20 : 0) + minTitleWidth + (hasBadge ? 40 : 0) + (meta ? 56 : 0);
  const actionsWidth = width > 0 ? Math.max(0, width - reserve) : 0;

  const label = (
    <>
      {collapsible && <Codicon name="chevronRight" size={14} className="ui-section-header-chevron" />}
      {icon && <Codicon name={icon} size={14} className="ui-section-header-icon" />}
      <span className="ui-section-header-title" title={title}>
        {title}
      </span>
    </>
  );

  return (
    <div
      ref={rootRef}
      id={id}
      className={cx(
        "ui-section-header",
        `ui-section-header-l${level}`,
        collapsible && (expanded ? "is-expanded" : "is-collapsed"),
        visibility === "hover" && "actions-on-hover",
        className
      )}
      onClick={(e) => {
        // Clique na área vazia do cabeçalho também alterna (VS Code).
        if (collapsible && e.target === e.currentTarget) onToggle?.();
      }}
    >
      {collapsible ? (
        <button
          ref={toggleRef}
          type="button"
          className="ui-section-header-toggle"
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={onToggle}
          onKeyDown={onToggleKeyDown}
        >
          {label}
        </button>
      ) : (
        <span className="ui-section-header-toggle is-static" role="heading" aria-level={level + 2}>
          {label}
        </span>
      )}
      {hasBadge && (
        <span className="ui-section-header-badge" aria-label={badgeLabel}>
          {badge}
        </span>
      )}
      {meta && <span className="ui-section-header-meta">{meta}</span>}
      {showActions && (
        <ActionBar
          actions={actions}
          width={actionsWidth}
          ariaLabel={`Ações de ${title}`}
          moreLabel={`Mais ações de ${title}`}
          className="ui-section-header-actions"
        />
      )}
    </div>
  );
});
