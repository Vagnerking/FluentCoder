import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ConfirmButton, ConfirmDialogProps } from "../types";

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
  const titleId = useId();
  const messageId = useId();
  // The element focused before the modal opened, restored on unmount.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Focus the default button (or the first one) so Enter/Tab start there.
    const surface = surfaceRef.current;
    const focusables = surface
      ? Array.from(surface.querySelectorAll<HTMLButtonElement>("button"))
      : [];
    const defaultIndex = buttons.findIndex((b) => b.default);
    (focusables[defaultIndex >= 0 ? defaultIndex : 0] ?? surface)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onChoice(null);
        return;
      }
      // Focus trap: keep Tab/Shift+Tab cycling within the modal's buttons.
      if (e.key === "Tab" && focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
    // Buttons are stable for the lifetime of an open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          {buttons.map((btn: ConfirmButton<T>, i) => (
            <button
              key={i}
              type="button"
              className={`confirm-button confirm-${btn.variant}${
                btn.default ? " is-default" : ""
              }`}
              onClick={() => onChoice(btn.value)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
