import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { cx } from "./cx";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** `sm` = 24px, `md` = 32px (default). */
  size?: "sm" | "md";
  /** Leading codicon (decorative — label the field with aria-label/<label>). */
  icon?: IconAction;
  /** Inline content after the text (toggle buttons, a clear button, a hint). */
  contentAfter?: ReactNode;
  /** Error state: red underline + `aria-invalid`. Pair with a message. */
  invalid?: boolean;
  /** Class on the field wrapper (layout at the call site). `className` goes
   *  on the <input> itself. */
  wrapperClassName?: string;
  /** Visual-only: borderless field (e.g. inside a dialog header). */
  appearance?: "outline" | "filled-darker";
}

/**
 * Fluent 2 text field: control fill, hairline border with a stronger bottom
 * edge and — on focus — a 2px accent underline that grows from the centre
 * (the field's focus indicator, on `:focus-within`). Optional leading icon and
 * trailing slot. The wrapper is purely visual; every native prop and the ref
 * go to the real <input>.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = "md",
    icon,
    contentAfter,
    invalid,
    wrapperClassName,
    appearance = "outline",
    className,
    disabled,
    type = "text",
    ...rest
  },
  ref,
) {
  return (
    <span
      className={cx(
        "ui-field",
        `ui-field-${size}`,
        appearance === "filled-darker" && "ui-field-darker",
        disabled && "is-disabled",
        invalid && "is-invalid",
        wrapperClassName,
      )}
    >
      {icon && <Codicon name={icon} className="ui-field-icon" />}
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cx("ui-field-input", className)}
        {...rest}
      />
      {contentAfter != null && <span className="ui-field-after">{contentAfter}</span>}
    </span>
  );
});

export interface SearchBoxProps extends Omit<InputProps, "icon" | "type"> {
  /** Called by the clear (×) button. Default: empties the field through a
   *  native input event, so a controlled `onChange` sees `""`. */
  onClear?: () => void;
  /** Accessible name of the clear button. */
  clearLabel?: string;
}

/** Sets a controlled input's value the way typing would (React sees it). */
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * {@link Input} with a search glyph and a clear button that appears while the
 * field has text (keeps focus in the field after clearing). Extra trailing
 * content (toggles) goes after the clear button.
 */
export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox(
  { onClear, clearLabel = "Limpar", contentAfter, value, disabled, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  const hasText = value != null && String(value).length > 0;
  const clear = (
    <>
      {hasText && !disabled && (
        <button
          type="button"
          className="ui-field-clear"
          aria-label={clearLabel}
          tabIndex={-1}
          // Keep focus (and the caret) in the field.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const input = inputRef.current;
            if (onClear) onClear();
            else if (input) setNativeValue(input, "");
            input?.focus();
          }}
        >
          <Codicon name="close" />
        </button>
      )}
      {contentAfter}
    </>
  );
  return (
    <Input
      ref={inputRef}
      icon="search"
      type="text"
      value={value}
      disabled={disabled}
      contentAfter={clear}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  wrapperClassName?: string;
}

/** Multi-line {@link Input}: same fill, border and focus underline. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, wrapperClassName, className, disabled, ...rest },
  ref,
) {
  return (
    <span
      className={cx(
        "ui-field",
        "ui-field-multiline",
        disabled && "is-disabled",
        invalid && "is-invalid",
        wrapperClassName,
      )}
    >
      <textarea
        ref={ref}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cx("ui-field-input", className)}
        {...rest}
      />
    </span>
  );
});
