import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Selector for elements that can receive focus inside a modal. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

interface ModalFocusOptions {
  /**
   * Called when Esc is pressed inside the modal. Optional: some dialogs handle
   * Esc themselves (e.g. to also clear a query first); omit it there.
   */
  onEscape?: () => void;
  /**
   * Where to send focus when the modal opens. `false` skips initial focus
   * (the dialog focuses something itself). Defaults to the first focusable
   * element inside the surface, falling back to the surface itself.
   */
  initialFocus?: RefObject<HTMLElement | null> | false;
}

/**
 * Shared modal focus contract (F2-AUD-007): one place for the three things
 * every dialog must do and most were doing inconsistently (or not at all):
 *
 * 1. **Initial focus** — move focus into the modal on open so the keyboard user
 *    isn't left on the element behind the backdrop.
 * 2. **Focus trap** — Tab / Shift+Tab cycle only within the surface, never
 *    escaping to the page behind the modal.
 * 3. **Focus restore** — on close, return focus to whatever had it before the
 *    modal opened (the element that triggered it).
 *
 * Esc handling is optional and routed through `onEscape` so dialogs with their
 * own Esc semantics keep them.
 *
 * Usage: attach `surfaceRef` to the modal's surface (the `role="dialog"`
 * element) and call this hook once.
 */
export function useModalFocus(
  surfaceRef: RefObject<HTMLElement | null>,
  { onEscape, initialFocus }: ModalFocusOptions = {}
) {
  // The element focused before the modal opened, restored on unmount.
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const surface = surfaceRef.current;

    // 1. Initial focus.
    if (initialFocus !== false) {
      const explicit = initialFocus?.current;
      if (explicit) {
        explicit.focus();
      } else if (surface) {
        const first = surface.querySelector<HTMLElement>(FOCUSABLE);
        (first ?? surface).focus();
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      // 2. Focus trap. Recompute focusables each Tab so it tracks dynamic
      // content (a list that grew, a field that became enabled).
      if (e.key === "Tab" && surface) {
        const focusables = Array.from(
          surface.querySelectorAll<HTMLElement>(FOCUSABLE)
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) {
          // Nothing focusable yet — keep focus on the surface, don't escape.
          e.preventDefault();
          surface.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === surface)) {
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
      // 3. Focus restore.
      previouslyFocused.current?.focus?.();
    };
    // The surface ref is stable; options are read fresh inside the effect via
    // closure but the contract is set once per open. Re-running on every render
    // would re-grab previouslyFocused mid-interaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
