import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ConfirmButton, ConfirmDialogProps } from "../types";
import { useModalFocus } from "./useModalFocus";

/**
 * Reusable confirmation modal (Fluent 2). Purely presentational: it shows a
 * title, a message and a row of configurable buttons, reporting the chosen
 * button's `value` back through `onChoice` (or `null` when cancelled). It knows
 * nothing about "save", "delete" or any concrete action — the caller assigns
 * meaning via each button's `value`.
 *
 * Rendered through `createPortal` on `document.body`, above the whole layout,
 * with a dimmed overlay and a centered acrylic surface. Follows the dialog
 * accessibility rules: `role="dialog"`, `aria-modal`, focus trapped inside the
 * modal (Tab cycles only the buttons), Esc cancels and the default button gets
 * the initial focus + the highlight.
 */
export function ConfirmDialog<T>({
  title,
  message,
  buttons,
  onChoice,
}: ConfirmDialogProps<T>) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const defaultBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  // Shared modal contract: trap + restore for free, Esc cancels, and the
  // default button (or the first) takes initial focus (F2-AUD-007).
  useModalFocus(surfaceRef, {
    onEscape: () => onChoice(null),
    initialFocus: defaultBtnRef,
  });

  return createPortal(
    <div className="confirm-overlay" onMouseDown={() => onChoice(null)}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        ref={surfaceRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="confirm-title">
          {title}
        </h2>
        <p id={messageId} className="confirm-message">
          {message}
        </p>
        <div className="confirm-actions">
          {(() => {
            // The default button gets the ref for initial focus; if no button
            // is flagged default, the first one does.
            const defaultIndex = buttons.findIndex((b) => b.default);
            const focusIndex = defaultIndex >= 0 ? defaultIndex : 0;
            return buttons.map((btn: ConfirmButton<T>, i) => (
              <button
                key={i}
                ref={i === focusIndex ? defaultBtnRef : undefined}
                type="button"
                className={`confirm-button confirm-${btn.variant}${
                  btn.default ? " is-default" : ""
                }`}
                onClick={() => onChoice(btn.value)}
              >
                {btn.label}
              </button>
            ));
          })()}
        </div>
      </div>
    </div>,
    document.body
  );
}
