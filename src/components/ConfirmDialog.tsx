import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * MINIMAL placeholder modal — created in this worktree only to unblock the
 * explorer "Excluir" flow (ISSUE-59). The full Fluent 2 version with focus trap
 * and variants comes from ISSUE-66 (another agent) and will replace this on
 * merge. Kept intentionally small and self-contained.
 */
export interface ConfirmButton<T> {
  label: string;
  value: T;
  variant?: "primary" | "secondary" | "danger";
  /** Receives initial focus and responds to Enter. */
  default?: boolean;
}

interface ConfirmDialogProps<T> {
  title: string;
  message: string;
  buttons: ConfirmButton<T>[];
  /** Called with the chosen value, or the cancel value on Esc/overlay click. */
  onChoice: (value: T) => void;
  /** Value resolved when the user cancels (Esc / overlay). */
  cancelValue: T;
}

export function ConfirmDialog<T>({
  title,
  message,
  buttons,
  onChoice,
  cancelValue,
}: ConfirmDialogProps<T>) {
  const defaultRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    defaultRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onChoice(cancelValue);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onChoice, cancelValue]);

  return createPortal(
    <div className="confirm-overlay" onMouseDown={() => onChoice(cancelValue)}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div id="confirm-title" className="confirm-title">
          {title}
        </div>
        <div id="confirm-message" className="confirm-message">
          {message}
        </div>
        <div className="confirm-actions">
          {buttons.map((b) => (
            <button
              key={b.label}
              ref={b.default ? defaultRef : undefined}
              className={`confirm-button ${b.variant ?? "secondary"}`}
              onClick={() => onChoice(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
