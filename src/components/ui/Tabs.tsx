import {
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { cx } from "./cx";
import { rovingTabIndex, tabsKeyTarget, type TabsOrientation } from "./tabsLogic";

export interface TabsItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Leading codicon (decorative — the label is the accessible name). */
  icon?: IconAction;
  /** Trailing count/badge (e.g. number of problems). Hidden when nullish. */
  badge?: ReactNode;
  disabled?: boolean;
}

/** Per-tab extras (drag-and-drop handlers, data-*, extra class). */
export type TabsExtraProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "role" | "aria-selected" | "tabIndex" | "onClick" | "onKeyDown" | "children"
>;

export interface TabsProps<V extends string = string> {
  items: readonly TabsItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /**
   * `underline` = Fluent TabList (transparent tabs + accent underline on the
   * selected one; panels and dialogs). `pill` = segmented control (the
   * selected tab gets a lifted fill; small option switches).
   */
  variant?: "underline" | "pill";
  /** `sm` = 24px tabs, `md` = 32px (default). */
  size?: "sm" | "md";
  orientation?: TabsOrientation;
  /** Accessible name of the tablist (or use `ariaLabelledBy`). */
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /**
   * When set, tab ids become `${idPrefix}-tab-${value}` and each tab gets
   * `aria-controls="${idPrefix}-panel-${value}"` — give the panel that id and
   * `aria-labelledby` the tab id.
   */
  idPrefix?: string;
  className?: string;
  /** Extra attributes per tab (e.g. drag-to-reorder handlers). */
  tabProps?: (item: TabsItem<V>, index: number) => TabsExtraProps;
}

/**
 * Fluent 2 tab list (WAI-ARIA tabs): `role="tablist"` with `role="tab"`
 * buttons, a roving tabindex (only the selected tab is in the Tab order) and
 * automatic activation — ←/→ (↑/↓ when vertical), Home/End move focus AND
 * selection, skipping disabled tabs, wrapping at the ends. Pure rules live in
 * `tabsLogic.ts` (unit-tested). Panels stay owned by the caller.
 */
export function Tabs<V extends string = string>({
  items,
  value,
  onChange,
  variant = "underline",
  size = "md",
  orientation = "horizontal",
  ariaLabel,
  ariaLabelledBy,
  idPrefix,
  className,
  tabProps,
}: TabsProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = items.findIndex((t) => t.value === value);
  const roving = rovingTabIndex(items, selectedIndex);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tabsKeyTarget(e.key, index, items, orientation);
    if (target === null) return;
    e.preventDefault();
    refs.current[target]?.focus();
    if (target !== selectedIndex) onChange(items[target].value);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-orientation={orientation}
      className={cx(
        "ui-tabs",
        `ui-tabs-${variant}`,
        `ui-tabs-${size}`,
        orientation === "vertical" && "ui-tabs-vertical",
        className,
      )}
    >
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        const extra = tabProps?.(item, i) ?? {};
        const { className: extraClass, ...extraRest } = extra;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={selected}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            tabIndex={i === roving ? 0 : -1}
            className={cx("ui-tab", selected && "is-selected", extraClass)}
            {...extraRest}
            onClick={() => {
              if (!item.disabled && !selected) onChange(item.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {item.icon && <Codicon name={item.icon} className="ui-tab-icon" />}
            <span className="ui-tab-label">{item.label}</span>
            {item.badge != null && item.badge !== false && (
              <span className="ui-tab-badge">{item.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
