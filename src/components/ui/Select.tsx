import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../../icons/codicons/Codicon";
import { cx } from "./cx";
import {
  computePopupPlacement,
  isTypeaheadKey,
  selectKeyAction,
  typeaheadIndex,
  type PopupPlacement,
} from "./selectLogic";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

/** An accessible name is mandatory: a visible label's id, or an `aria-label`. */
type SelectLabelProps =
  | { ariaLabel: string; ariaLabelledBy?: string }
  | { ariaLabel?: string; ariaLabelledBy: string };

export type SelectProps<V extends string = string> = SelectLabelProps & {
  value: V;
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  disabled?: boolean;
  /** `sm` = 24px, `md` = 32px (default). */
  size?: "sm" | "md";
  /** Shown when `value` matches no option (e.g. an empty list). */
  placeholder?: string;
  /** Hover hint on the trigger (kept for parity with the old native selects). */
  title?: string;
  id?: string;
  className?: string;
};

/** Type-ahead buffer resets after this pause (ms), like native selects. */
const TYPEAHEAD_RESET = 500;
/** Option row height (px) — keep in sync with `.ui-select-option`. */
const OPTION_HEIGHT = 28;

/**
 * Fluent 2 dropdown replacing the native `<select>` (whose popup can't be
 * styled and ignores the theme). WAI-ARIA "select-only combobox": the trigger
 * is a `<button role="combobox">` that keeps DOM focus while the highlighted
 * option is announced through `aria-activedescendant`.
 *
 * Keyboard: ↑/↓ (Alt+↓ too) open and move, Home/End, PageUp/PageDown,
 * Enter/Space choose, Esc closes, Tab chooses and moves on, printable keys do
 * type-ahead (closed: changes the value directly, like the native control).
 * The pure rules live in `selectLogic.ts` (unit-tested).
 *
 * The popup is portalled to `<body>` with `position: fixed`, so it escapes any
 * `overflow: hidden` / `backdrop-filter` ancestor (sidebars, modals); it flips
 * above the trigger when there's no room below, and closes on outside press,
 * window resize/blur or a scroll that moves the trigger.
 */
export function Select<V extends string = string>(props: SelectProps<V>) {
  const {
    value,
    onChange,
    options,
    disabled = false,
    size = "md",
    placeholder = "",
    title,
    id,
    className,
    ariaLabel,
    ariaLabelledBy,
  } = props;

  const baseId = useId();
  const triggerId = id ?? `${baseId}-trigger`;
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  const typeahead = useRef({ buffer: "", timer: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  // Nothing to choose (empty list / all disabled): don't open an empty flyout.
  const openAt = useCallback((index: number) => {
    if (index < 0) return;
    setActiveIndex(index);
    setOpen(true);
  }, []);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      close();
      if (opt && !opt.disabled && opt.value !== value) onChange(opt.value);
    },
    [options, value, onChange, close],
  );

  // A disabled select can't stay open (e.g. it got disabled while busy).
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);

  // Measure the trigger and place the popup before paint (no flash at 0,0).
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPlacement(
      computePopupPlacement(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        options.length * OPTION_HEIGHT + 8,
      ),
    );
  }, [options.length]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Keep the highlighted option visible as the user arrows through the list.
  // Scrolls the list itself (not `scrollIntoView`, which could also nudge an
  // `overflow: hidden` ancestor of the page).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list || activeIndex < 0) return;
    const el = list.children[activeIndex] as HTMLElement | undefined;
    if (!el) return;
    if (el.offsetTop < list.scrollTop) {
      list.scrollTop = el.offsetTop - 4;
    } else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 4;
    }
  }, [open, activeIndex, placement]);

  // Outside press / resize / outer scroll close the popup.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (triggerRef.current?.contains(target) || listRef.current?.contains(target));
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) close();
    };
    // Only a scroll that moves the trigger (an ancestor, or the document)
    // detaches the popup; unrelated scrolls (e.g. a log streaming in a sibling
    // pane) must not close it.
    const onScroll = (e: Event) => {
      const target = e.target;
      const trigger = triggerRef.current;
      if (target === document || (target instanceof Node && trigger && target.contains(trigger))) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (isTypeaheadKey(e.key, e)) {
      e.preventDefault();
      const state = typeahead.current;
      window.clearTimeout(state.timer);
      state.buffer += e.key;
      state.timer = window.setTimeout(() => {
        state.buffer = "";
      }, TYPEAHEAD_RESET);
      const from = open ? activeIndex : selectedIndex;
      const match = typeaheadIndex(options, state.buffer, from);
      if (match < 0) return;
      if (open) setActiveIndex(match);
      else if (options[match].value !== value) onChange(options[match].value);
      return;
    }

    // Space continues a type-ahead word ("pro d…") instead of choosing.
    if (e.key === " " && typeahead.current.buffer) {
      e.preventDefault();
      typeahead.current.buffer += " ";
      return;
    }

    const action = selectKeyAction(
      e.key,
      { open, activeIndex, selectedIndex },
      options,
      e,
    );
    switch (action.type) {
      case "none":
        return;
      case "open":
        e.preventDefault();
        openAt(action.activeIndex);
        return;
      case "move":
        e.preventDefault();
        setActiveIndex(action.activeIndex);
        return;
      case "commit":
        if (!action.keepDefault) e.preventDefault();
        commit(action.index);
        return;
      case "close":
        e.preventDefault();
        // Esc on an open popup must not also dismiss the surrounding modal.
        e.stopPropagation();
        close();
        return;
    }
  };

  const labelProps = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : { "aria-label": ariaLabel };

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        className={cx(
          "ui-select",
          `ui-select-${size}`,
          open && "is-open",
          !selected && "is-placeholder",
          className,
        )}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        {...labelProps}
        onClick={() => {
          if (open) close();
          else
            openAt(
              selectedIndex >= 0 && !options[selectedIndex].disabled
                ? selectedIndex
                : options.findIndex((o) => !o.disabled),
            );
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      >
        <span className="ui-select-value">{selected ? selected.label : placeholder}</span>
        <Codicon name="chevronDown" className="ui-select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            {...labelProps}
            className={cx(
              "ui-select-popup",
              placement && `is-${placement.side}`,
            )}
            style={
              placement
                ? {
                    left: placement.left,
                    top: placement.top,
                    bottom: placement.bottom,
                    minWidth: placement.minWidth,
                    maxHeight: placement.maxHeight,
                  }
                : { visibility: "hidden" }
            }
            // Keep DOM focus on the trigger (activedescendant pattern).
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((opt, i) => (
              <div
                key={opt.value}
                id={optionId(i)}
                role="option"
                aria-selected={i === selectedIndex}
                aria-disabled={opt.disabled || undefined}
                className={cx(
                  "ui-select-option",
                  i === activeIndex && "is-active",
                  i === selectedIndex && "is-selected",
                )}
                onMouseMove={() => {
                  if (!opt.disabled && i !== activeIndex) setActiveIndex(i);
                }}
                onClick={() => {
                  if (!opt.disabled) commit(i);
                }}
              >
                <span className="ui-select-option-label">{opt.label}</span>
                {i === selectedIndex && (
                  <Codicon name="checkmark" className="ui-select-option-check" />
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
