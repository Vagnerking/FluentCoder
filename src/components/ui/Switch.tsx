import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (to the right of the track). Without it, pass `aria-label`. */
  label?: ReactNode;
}

/**
 * Fluent 2 toggle switch for immediate on/off settings (`role="switch"`,
 * `aria-checked`). A real `<button>`, so Space/Enter toggle it natively and it
 * joins the tab order; the label is rendered inside the button so the whole row
 * is the hit target and the visible text is its accessible name.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, className, disabled, onClick, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx("ui-switch", checked && "is-checked", className)}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onChange(!checked);
      }}
      {...rest}
    >
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
      {label != null && <span className="ui-switch-label">{label}</span>}
    </button>
  );
});
