import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "subtle" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` = accent (one per context), `secondary` = neutral (default),
   *  `subtle` = transparent until hover, `danger` = destructive action. */
  variant?: ButtonVariant;
  /** `sm` = 24px, `md` = 32px (default). */
  size?: ButtonSize;
  /** Leading codicon. Decorative: the visible text is the accessible name. */
  icon?: IconAction;
  /**
   * Busy state: swaps the icon for a spinner, sets `aria-busy` and blocks
   * clicks (without `disabled`, so focus isn't lost mid-action).
   */
  loading?: boolean;
  children?: ReactNode;
}

/**
 * Fluent 2 button (F2-AUD-014). Thin wrapper over the `.ui-button` CSS system:
 * picks the variant/size classes, renders an optional leading icon and the
 * loading state; every other native prop (`type`, `disabled`, `onClick`,
 * `aria-*`, …) passes straight through. Defaults to `type="button"` so a button
 * inside a form never submits by accident — pass `type="submit"` explicitly.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    loading = false,
    className,
    type = "button",
    onClick,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "ui-button",
        `ui-button-${variant}`,
        `ui-button-${size}`,
        className,
      )}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? (
        <Codicon name="loading" className="ui-button-icon" />
      ) : (
        icon && <Codicon name={icon} className="ui-button-icon" />
      )}
      {children}
    </button>
  );
});
