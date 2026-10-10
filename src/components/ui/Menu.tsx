import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { cx } from "./cx";
import {
  firstActionable,
  isActionable,
  isTypeaheadKey,
  menuKeyAction,
  placeMenu,
  typeaheadMatch,
  type MenuPlacement,
  type Rect,
} from "./menuLogic";

/** One entry of a {@link Menu}. */
export interface MenuItemSpec {
  id: string;
  label?: string;
  /** Leading codicon (decorative). */
  icon?: IconAction;
  /** Right-aligned shortcut hint, e.g. "Ctrl+S". */
  shortcut?: string;
  /** Small trailing pill (e.g. "padrão"). */
  badge?: string;
  /** Hover hint (e.g. why an item is disabled). */
  title?: string;
  /** Renders as `menuitemcheckbox` with a checkmark when true. */
  checked?: boolean;
  /** `accent` = the menu's primary action; `danger` = destructive. */
  tone?: "default" | "accent" | "danger";
  disabled?: boolean;
  /** A divider instead of an item. */
  separator?: boolean;
  /** Nested items (flyout to the side). */
  submenu?: readonly MenuItemSpec[];
  onSelect?: () => void;
}

export type MenuCloseReason = "select" | "escape" | "tab" | "outside" | "blur";

/** Where the menu opens: at a cursor point, or attached to a trigger rect. */
export type MenuAnchor =
  | { x: number; y: number }
  | { rect: Rect; placement: Exclude<MenuPlacement, "point" | "right-start"> };

export interface MenuProps {
  items: readonly MenuItemSpec[];
  anchor: MenuAnchor;
  /** Every close path ends here (item chosen, Esc, Tab, outside press, blur). */
  onClose: (reason: MenuCloseReason) => void;
  ariaLabel?: string;
  /** Non-interactive block above the items (title, status line). */
  header?: ReactNode;
  /** Non-interactive block below the items (e.g. "last fetch"). */
  footer?: ReactNode;
  className?: string;
  /** Focus the first item on open (default). Off = focus the surface. */
  autoFocus?: boolean;
  /** ←/→ at the root level (menu bar: switch to the adjacent menu). */
  onArrowOut?: (dir: 1 | -1) => void;
  /** Extra nodes whose presses don't count as "outside" (the trigger). */
  isInside?: (target: Node) => boolean;
  /** Minimum surface width (px). */
  minWidth?: number;
}

const toRect = (r: DOMRect | Rect): Rect => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
});

/**
 * Fluent 2 flyout menu (WAI-ARIA `menu`): portalled to `<body>` with
 * `position: fixed` (escapes overflow/backdrop-filter ancestors), flips at the
 * viewport edges, and supports icons, shortcuts, checkable items, separators
 * and nested submenus.
 *
 * Keyboard: ↑/↓ (wrap, skipping separators/disabled), Home/End, Enter/Space,
 * → opens a submenu, ← / Esc close it, Esc closes the menu, Tab closes and
 * lets focus move on, printable keys type-ahead. Focus moves onto the active
 * item (roving), and returns to where it was when the menu closes. Pure rules
 * live in `menuLogic.ts` (unit-tested).
 */
export function Menu({
  items,
  anchor,
  onClose,
  ariaLabel,
  header,
  footer,
  className,
  autoFocus = true,
  onArrowOut,
  isInside,
  minWidth,
}: MenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Focus to restore on close (captured at open).
  const restoreRef = useRef<Element | null>(
    typeof document !== "undefined" ? document.activeElement : null,
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Outside press / window blur / resize close the whole menu tree.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (t instanceof Element && t.closest("[data-ui-menu]")) return;
      if (isInside?.(t)) return;
      onCloseRef.current("outside");
    };
    const onBlur = () => onCloseRef.current("blur");
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [isInside]);

  // Return focus to the opener when the menu goes away — unless something else
  // (e.g. an inline rename the chosen action opened) already took it.
  useLayoutEffect(() => {
    const restore = restoreRef.current;
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || !active.isConnected;
      const inMenu = active instanceof Element && !!active.closest("[data-ui-menu]");
      if ((lost || inMenu) && restore instanceof HTMLElement && restore.isConnected) {
        restore.focus({ preventScroll: true });
      }
    };
  }, []);

  const rect: Rect =
    "rect" in anchor
      ? anchor.rect
      : { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y };
  const placement: MenuPlacement = "rect" in anchor ? anchor.placement : "point";

  return createPortal(
    <MenuSurface
      surfaceRef={rootRef}
      items={items}
      anchor={rect}
      placement={placement}
      isSubmenu={false}
      ariaLabel={ariaLabel}
      header={header}
      footer={footer}
      className={className}
      autoFocus={autoFocus}
      minWidth={minWidth}
      onArrowOut={onArrowOut}
      onCloseSubmenu={() => {}}
      onCloseAll={(reason) => onCloseRef.current(reason)}
    />,
    document.body,
  );
}

interface SurfaceProps {
  surfaceRef?: RefObject<HTMLDivElement>;
  items: readonly MenuItemSpec[];
  anchor: Rect;
  placement: MenuPlacement;
  isSubmenu: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  autoFocus: boolean;
  minWidth?: number;
  onArrowOut?: (dir: 1 | -1) => void;
  /** Close just this (sub)level and give focus back to the parent item. */
  onCloseSubmenu: () => void;
  onCloseAll: (reason: MenuCloseReason) => void;
}

/** Type-ahead buffer reset (ms). */
const TYPEAHEAD_RESET = 500;

function MenuSurface({
  surfaceRef,
  items,
  anchor,
  placement,
  isSubmenu,
  ariaLabel,
  ariaLabelledBy,
  header,
  footer,
  className,
  autoFocus,
  minWidth,
  onArrowOut,
  onCloseSubmenu,
  onCloseAll,
}: SurfaceProps) {
  const baseId = useId();
  const localRef = useRef<HTMLDivElement>(null);
  const ref = surfaceRef ?? localRef;
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number; side: "up" | "down" } | null>(
    null,
  );
  const [active, setActive] = useState(() => (autoFocus ? firstActionable(items) : -1));
  const [openSub, setOpenSub] = useState<number | null>(null);
  // Whether the open submenu should grab focus (keyboard) or not (hover).
  const [subFocus, setSubFocus] = useState(false);
  const typeahead = useRef({ buffer: "", timer: 0 });

  // Measure, then place before paint (no flash at 0,0).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const p = placeMenu(anchor, placement, size, viewport);
    setPos({ ...p, side: p.top < anchor.top ? "up" : "down" });
    // Anchor values are what matter (a fresh object each render is fine).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, placement, items.length]);

  // Roving focus: the active item holds DOM focus; none → the surface itself.
  useEffect(() => {
    if (!pos) return;
    if (openSub !== null && subFocus) return; // the submenu owns focus
    const el = active >= 0 ? itemRefs.current[active] : ref.current;
    el?.focus({ preventScroll: true });
    if (active >= 0) itemRefs.current[active]?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pos, openSub, subFocus]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  const select = useCallback(
    (item: MenuItemSpec) => {
      if (!isActionable(item) || item.submenu?.length) return;
      onCloseAll("select");
      item.onSelect?.();
    },
    [onCloseAll],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from a nested submenu are handled there (it's a DOM descendant).
    if (e.target instanceof Element && e.target.closest("[data-ui-menu]") !== ref.current) {
      return;
    }
    if (isTypeaheadKey(e.key, e)) {
      e.preventDefault();
      const ta = typeahead.current;
      window.clearTimeout(ta.timer);
      ta.buffer += e.key;
      ta.timer = window.setTimeout(() => (ta.buffer = ""), TYPEAHEAD_RESET);
      const i = typeaheadMatch(items, ta.buffer, ta.buffer.length > 1 ? active - 1 : active);
      if (i >= 0) {
        setOpenSub(null);
        setActive(i);
      }
      return;
    }
    const action = menuKeyAction(e.key, items, { activeIndex: active, isSubmenu });
    switch (action.type) {
      case "none":
        return;
      case "move":
        e.preventDefault();
        setOpenSub(null);
        setActive(action.index);
        return;
      case "activate":
        e.preventDefault();
        select(items[action.index] as MenuItemSpec);
        return;
      case "openSubmenu":
        e.preventDefault();
        setSubFocus(true);
        setOpenSub(action.index);
        return;
      case "closeSubmenu":
        e.preventDefault();
        e.stopPropagation();
        onCloseSubmenu();
        return;
      case "arrowOut":
        if (onArrowOut) {
          e.preventDefault();
          onArrowOut(action.dir);
        }
        return;
      case "close":
        if (action.reason === "escape") {
          e.preventDefault();
          // Esc on a menu must not also dismiss a surrounding modal/panel.
          e.stopPropagation();
        }
        onCloseAll(action.reason);
        return;
    }
  };

  const subItem = openSub !== null ? items[openSub] : null;
  const subRect = openSub !== null ? itemRefs.current[openSub]?.getBoundingClientRect() : null;

  return (
    <div
      ref={ref}
      data-ui-menu=""
      role="menu"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-orientation="vertical"
      tabIndex={-1}
      className={cx(
        "ui-menu",
        isSubmenu && "ui-menu-sub",
        pos && `is-${pos.side}`,
        className,
      )}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        minWidth,
        visibility: pos ? undefined : "hidden",
      }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {header != null && <div className="ui-menu-header">{header}</div>}
      <div className="ui-menu-items">
        {items.map((item, i) => {
          if (item.separator) {
            return <div key={item.id} role="separator" className="ui-menu-separator" />;
          }
          const hasSub = !!item.submenu?.length;
          const checkable = item.checked !== undefined;
          return (
            <div
              key={item.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              id={`${baseId}-${i}`}
              role={checkable ? "menuitemcheckbox" : "menuitem"}
              aria-checked={checkable ? item.checked : undefined}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? openSub === i : undefined}
              tabIndex={-1}
              title={item.title}
              className={cx(
                "ui-menu-item",
                i === active && "is-active",
                item.disabled && "is-disabled",
                item.tone === "accent" && "is-accent",
                item.tone === "danger" && "is-danger",
                hasSub && openSub === i && "is-open",
              )}
              onMouseEnter={() => {
                if (item.disabled) {
                  setActive(-1);
                  setOpenSub(null);
                  return;
                }
                setActive(i);
                setSubFocus(false);
                setOpenSub(hasSub ? i : null);
              }}
              onClick={() => {
                if (item.disabled) return;
                if (hasSub) {
                  setSubFocus(true);
                  setOpenSub(i);
                  return;
                }
                select(item);
              }}
            >
              <span className="ui-menu-icon" aria-hidden="true">
                {checkable ? (
                  item.checked ? <Codicon name="checkmark" /> : null
                ) : item.icon ? (
                  <Codicon name={item.icon} />
                ) : null}
              </span>
              <span className="ui-menu-label">{item.label}</span>
              {item.badge && <span className="ui-menu-badge">{item.badge}</span>}
              {item.shortcut && <span className="ui-menu-shortcut">{item.shortcut}</span>}
              {hasSub && (
                <span className="ui-menu-chevron" aria-hidden="true">
                  <Codicon name="chevronRight" />
                </span>
              )}
            </div>
          );
        })}
      </div>
      {footer != null && <div className="ui-menu-footer">{footer}</div>}
      {/* Submenus get their own portal: a `position: fixed` flyout nested in
          the parent surface would be clipped by its scroll container. Keys
          still bubble through the React tree; onKeyDown filters them. */}
      {subItem?.submenu && subRect && createPortal(
        <MenuSurface
          key={openSub}
          items={subItem.submenu}
          anchor={toRect(subRect)}
          placement="right-start"
          isSubmenu
          ariaLabelledBy={`${baseId}-${openSub}`}
          autoFocus={subFocus}
          onCloseSubmenu={() => {
            const parent = openSub;
            setOpenSub(null);
            setSubFocus(false);
            if (parent !== null) itemRefs.current[parent]?.focus({ preventScroll: true });
          }}
          onCloseAll={onCloseAll}
        />,
        document.body,
      )}
    </div>
  );
}
