import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";

interface TooltipProps {
  /**
   * Visible tooltip text. This is decorative for sighted users — the trigger
   * MUST keep its own `aria-label`, so the accessible name never depends on the
   * tooltip showing. We still associate it via `aria-describedby` for SR users.
   */
  label: string;
  /** The interactive trigger (an icon-only button) the tooltip describes. */
  children: ReactElement;
  /** Where the bubble sits relative to the trigger. Defaults to "top". */
  placement?: "top" | "bottom";
}

/** Hover delay (ms). Focus shows the tooltip immediately, like VS Code. */
const HOVER_DELAY = 400;

/**
 * Accessible tooltip for icon-only command buttons. It replaces the native
 * `title` attribute (which only appears on mouse hover and is invisible to
 * keyboard users) with a bubble that shows on hover AND on keyboard focus, and
 * hides on mouseleave / blur / Esc.
 *
 * The bubble is positioned with `position: fixed`, measured from the trigger's
 * bounding rect, so it escapes any `overflow: hidden` ancestor (sidebars,
 * activity bar). The trigger keeps its `aria-label`; we add `aria-describedby`
 * pointing at the bubble so screen readers can read the same hint.
 */
export function Tooltip({ label, children, placement = "top" }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Anchors the bubble to the trigger's current rect (in viewport coords).
  const position = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setCoords({
      left: rect.left + rect.width / 2,
      top: placement === "top" ? rect.top : rect.bottom,
    });
  }, [placement]);

  const show = useCallback(
    (immediate: boolean) => {
      clearTimer();
      if (immediate) {
        position();
        setOpen(true);
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        position();
        setOpen(true);
      }, HOVER_DELAY);
    },
    [clearTimer, position],
  );

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  // Clean up the pending hover timer if the trigger unmounts mid-delay.
  useEffect(() => clearTimer, [clearTimer]);

  // Esc dismisses the tooltip without moving focus away from the trigger.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) hide();
      // Preserve any handler the child already had.
      (children.props as { onKeyDown?: (e: KeyboardEvent) => void }).onKeyDown?.(e);
    },
    [open, hide, children.props],
  );

  // Merge our handlers/refs onto the trigger without clobbering its own.
  const childProps = children.props as {
    onMouseEnter?: (e: unknown) => void;
    onMouseLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
    "aria-describedby"?: string;
  };

  const trigger = cloneElement(children, {
    ref: triggerRef,
    "aria-describedby": [childProps["aria-describedby"], id]
      .filter(Boolean)
      .join(" "),
    onMouseEnter: (e: unknown) => {
      show(false);
      childProps.onMouseEnter?.(e);
    },
    onMouseLeave: (e: unknown) => {
      hide();
      childProps.onMouseLeave?.(e);
    },
    // `:focus-visible` keeps the bubble out of the way on plain mouse clicks
    // (which also focus the button) while still showing it for keyboard users.
    onFocus: (e: unknown) => {
      if ((triggerRef.current as HTMLElement | null)?.matches(":focus-visible")) {
        show(true);
      }
      childProps.onFocus?.(e);
    },
    onBlur: (e: unknown) => {
      hide();
      childProps.onBlur?.(e);
    },
    onKeyDown,
  } as Partial<typeof children.props>);

  return (
    <>
      {trigger}
      {open && coords && (
        <span
          role="tooltip"
          id={id}
          className={`tooltip tooltip-${placement}`}
          style={{ left: coords.left, top: coords.top }}
        >
          {label}
        </span>
      )}
    </>
  );
}
