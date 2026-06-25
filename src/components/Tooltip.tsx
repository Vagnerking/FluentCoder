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

/** A `disabled` element doesn't emit hover/focus, so the wrapper carries them. */
function isDisabled(el: ReactElement): boolean {
  return Boolean((el.props as { disabled?: boolean }).disabled);
}

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
  // The wrapper is the anchor: it always emits hover/focus, even when the child
  // (e.g. a `<button disabled>`) does not — fixing F2-AUD-005 for disabled
  // controls like the Search/Git toggles. Measurement is taken from it too.
  const anchorRef = useRef<HTMLSpanElement>(null);
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
  // The wrapper uses `display: contents` (no box of its own), so we measure its
  // element child — the actual control — which has geometry even when disabled.
  const position = useCallback(() => {
    const wrapper = anchorRef.current;
    const el = (wrapper?.firstElementChild as HTMLElement | null) ?? wrapper;
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

  // Esc dismisses the tooltip without moving focus away from the trigger. The
  // child keeps its own onKeyDown natively (it's a real DOM descendant), and
  // this listens on the wrapper, so we never need to forward to it.
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) hide();
    },
    [open, hide],
  );

  // Associate the bubble with the trigger for SR users — but only when the
  // child is enabled (a disabled control is largely ignored by AT, and we must
  // not clobber its own describedby otherwise).
  const childProps = children.props as { "aria-describedby"?: string };
  const child = isDisabled(children)
    ? children
    : cloneElement(children, {
        "aria-describedby": [childProps["aria-describedby"], id]
          .filter(Boolean)
          .join(" "),
      } as Partial<typeof children.props>);

  return (
    <>
      {/* The wrapper is the event/measurement anchor so the tooltip works even
          when the child is disabled. display: contents keeps layout unchanged. */}
      <span
        ref={anchorRef}
        className="tooltip-anchor"
        onMouseEnter={() => show(false)}
        onMouseLeave={hide}
        // Focus bubbles, so focusing the inner control fires this. Gate on
        // :focus-visible so a plain mouse click (which also focuses) doesn't
        // pop the bubble — only keyboard focus does.
        onFocus={() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.matches(":focus-visible")) {
            show(true);
          }
        }}
        onBlur={hide}
        onKeyDown={onKeyDown}
      >
        {child}
      </span>
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
