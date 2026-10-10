import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { Tooltip } from "../Tooltip";
import { cx } from "./cx";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** The codicon shown (16px). */
  icon: IconAction;
  /**
   * Required accessible name — becomes the `aria-label` AND the tooltip text,
   * so an icon-only button is never anonymous to screen readers.
   */
  label: string;
  /** `sm` = 24px square, `md` = 28px square (default). */
  size?: "sm" | "md";
  /** Toggle buttons: sets `aria-pressed` and the selected fill. */
  pressed?: boolean;
  /** Spins the glyph (busy feedback, e.g. a refresh in flight). */
  spin?: boolean;
  /** Tooltip side. Defaults to "top". */
  tooltipPlacement?: "top" | "bottom" | "left" | "right";
}

/**
 * Square, icon-only command button (`.ui-icon-button`). The `label` is both
 * the `aria-label` and the hover/focus {@link Tooltip}, replacing the native
 * `title` (invisible to keyboard users). Pass `pressed` for toggles.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      size = "md",
      pressed,
      tooltipPlacement = "top",
      spin,
      className,
      type = "button",
      ...rest
    },
    ref,
  ) {
    return (
      <Tooltip label={label} placement={tooltipPlacement}>
        <button
          ref={ref}
          type={type}
          className={cx("ui-icon-button", `ui-icon-button-${size}`, className)}
          aria-label={label}
          aria-pressed={pressed}
          {...rest}
        >
          <Codicon name={icon} spin={spin} className="ui-icon-button-icon" />
        </button>
      </Tooltip>
    );
  },
);
