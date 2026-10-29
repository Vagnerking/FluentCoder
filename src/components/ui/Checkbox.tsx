import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import { cx } from "./cx";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** Visible label; clicking it toggles the box. */
  label?: ReactNode;
  /** Mixed state (some-but-not-all). Rendered as a dash, `aria-checked="mixed"`. */
  indeterminate?: boolean;
  /** Extra class on the root `<label>` (layout tweaks at the call site). */
  className?: string;
}

/**
 * Fluent 2 checkbox: a 16px, 4px-radius box with an accent fill and a codicon
 * checkmark. The native `<input type="checkbox">` stays in the DOM (visually
 * hidden) so keyboard (Space), form semantics, `onChange` and screen readers
 * work exactly as before; the visible box is purely decorative. The whole
 * `<label>` is the hit target. Without a visible `label`, pass `aria-label`.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate = false, className, disabled, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  // `indeterminate` is a DOM property only (no HTML attribute).
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={cx("ui-checkbox", disabled && "is-disabled", className)}>
      <input
        ref={inputRef}
        type="checkbox"
        className="ui-checkbox-input"
        disabled={disabled}
        {...rest}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        <Codicon
          name={indeterminate ? "indeterminate" : "checkmark"}
          className="ui-checkbox-mark"
        />
      </span>
      {label != null && <span className="ui-checkbox-label">{label}</span>}
    </label>
  );
});
