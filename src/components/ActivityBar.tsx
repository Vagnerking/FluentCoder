import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import { Codicon } from '../icons/codicons/Codicon';
import type { IconAction } from '../icons/codicons/codicon-map';
import { Tooltip } from './Tooltip';

interface ActivityBarProps {
  activeView: string;
  onViewChange: (view: string) => void;
  /** Which side the sidebar is docked on — drives the active indicator's edge. */
  side?: 'left' | 'right';
  /** Vertical (lateral) or horizontal (compact, atop the sidebar). */
  orientation?: 'vertical' | 'horizontal';
  /** Toggles the sidebar side (also wired to right-click on the bar). */
  onToggleSide?: () => void;
  /** Begins dragging the *whole bar* to reposition it (from empty bar area). */
  onDragStart?: (e: PointerEvent<HTMLElement>) => void;
}

const VIEWS: { id: string; label: string; icon: IconAction }[] = [
  { id: 'explorer', label: 'Explorador', icon: 'explorer' },
  { id: 'search', label: 'Pesquisar', icon: 'search' },
  { id: 'git', label: 'Controle do Código-Fonte', icon: 'sourceControl' },
  { id: 'debug', label: 'Executar e Depurar', icon: 'run' },
  { id: 'solution', label: 'Solution Explorer', icon: 'solution' },
  { id: 'agents', label: 'Agentes', icon: 'agents' },
  { id: 'backlinks', label: 'Backlinks', icon: 'backlinks' },
  { id: 'graph', label: 'Grafo de Contextos', icon: 'graph' },
];

const BOTTOM_VIEWS: { id: string; label: string; icon: IconAction }[] = [
  { id: 'account', label: 'Contas', icon: 'account' },
  { id: 'settings', label: 'Gerenciar', icon: 'settings' },
];

const ORDER_KEY = 'ui.activityBarOrder';
const DEFAULT_ORDER = VIEWS.map((v) => v.id);

/** Reads the persisted icon order, validating it still holds exactly the known views. */
function readOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '');
    if (
      Array.isArray(parsed) &&
      parsed.length === DEFAULT_ORDER.length &&
      DEFAULT_ORDER.every((id) => parsed.includes(id))
    ) {
      return parsed as string[];
    }
  } catch {
    /* missing or malformed — fall back */
  }
  return DEFAULT_ORDER;
}

export function ActivityBar({
  activeView,
  onViewChange,
  side = 'left',
  orientation = 'vertical',
  onToggleSide,
  onDragStart,
}: ActivityBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [indicatorOffset, setIndicatorOffset] = useState<number | null>(null);
  const horizontal = orientation === 'horizontal';

  // Drag-reorderable order of the primary view icons (VSCode-style), persisted.
  // `dropTarget` tracks the hovered icon and which side (before/after) the dragged
  // icon will land on — so you can reach the very first or last slot.
  const [order, setOrder] = useState<string[]>(readOrder);
  const dragIdRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(
    null,
  );

  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [order]);

  const orderedViews = order
    .map((id) => VIEWS.find((v) => v.id === id))
    .filter((v): v is (typeof VIEWS)[number] => Boolean(v));

  /** Drops the dragged icon before/after `target`, reordering the bar. */
  function reorder(target: string, after: boolean) {
    const from = dragIdRef.current;
    dragIdRef.current = null;
    setDropTarget(null);
    if (!from || from === target) return;
    setOrder((prev) => {
      const next = prev.filter((id) => id !== from);
      const idx = next.indexOf(target) + (after ? 1 : 0);
      next.splice(idx, 0, from);
      return next;
    });
  }

  useLayoutEffect(() => {
    const updateIndicator = () => {
      const bar = barRef.current;
      const activeItem = bar?.querySelector<HTMLElement>(
        `.activity-item[data-view="${activeView}"]`,
      );

      if (!bar || !activeItem) {
        setIndicatorOffset(null);
        return;
      }

      // Center the 20px indicator along the active item's main axis.
      setIndicatorOffset(
        horizontal
          ? activeItem.offsetLeft + (activeItem.offsetWidth - 20) / 2
          : activeItem.offsetTop + (activeItem.offsetHeight - 20) / 2,
      );
    };

    updateIndicator();

    const resizeObserver = new ResizeObserver(updateIndicator);
    if (barRef.current) resizeObserver.observe(barRef.current);

    return () => resizeObserver.disconnect();
    // `order` re-runs this after a reorder so the indicator tracks the active icon.
  }, [activeView, horizontal, order]);

  return (
    <div
      className={`activity-bar${side === 'right' ? ' side-right' : ''}${
        horizontal ? ' activity-horizontal' : ''
      }`}
      ref={barRef}
      // Press-and-hold the *empty* bar area to reposition the whole bar. Pointer
      // downs on an icon are left alone — those drag to reorder (HTML5 DnD below).
      onPointerDown={
        onDragStart
          ? (e) => {
              if (!(e.target as HTMLElement).closest('.activity-item')) {
                onDragStart(e);
              }
            }
          : undefined
      }
      onContextMenu={
        onToggleSide
          ? (e) => {
              e.preventDefault();
              onToggleSide();
            }
          : undefined
      }
      title={onToggleSide ? 'Clique direito: mover a barra lateral de lado' : undefined}
    >
      <span
        className="activity-indicator"
        aria-hidden="true"
        style={{
          opacity: indicatorOffset === null ? 0 : 1,
          transform: horizontal
            ? `translateX(${indicatorOffset ?? 0}px)`
            : `translateY(${indicatorOffset ?? 0}px)`,
        }}
      />
      <div className="activity-items">
        {orderedViews.map((v) => (
          <Tooltip key={v.id} label={v.label} placement="bottom">
          <button
            className={`activity-item${activeView === v.id ? ' active' : ''}${
              dropTarget?.id === v.id
                ? dropTarget.after
                  ? ' drop-after'
                  : ' drop-before'
                : ''
            }`}
            data-view={v.id}
            draggable
            aria-label={v.label}
            onClick={() => onViewChange(v.id)}
            onDragStart={(e) => {
              dragIdRef.current = v.id;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              dragIdRef.current = null;
              setDropTarget(null);
            }}
            onDragOver={(e) => {
              if (!dragIdRef.current || dragIdRef.current === v.id) return;
              e.preventDefault();
              // Past the icon's mid-point (along the bar's main axis) drops after it.
              const rect = e.currentTarget.getBoundingClientRect();
              const after = horizontal
                ? e.clientX > rect.left + rect.width / 2
                : e.clientY > rect.top + rect.height / 2;
              if (dropTarget?.id !== v.id || dropTarget.after !== after) {
                setDropTarget({ id: v.id, after });
              }
            }}
            onDragLeave={() => {
              if (dropTarget?.id === v.id) setDropTarget(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const after = horizontal
                ? e.clientX > rect.left + rect.width / 2
                : e.clientY > rect.top + rect.height / 2;
              reorder(v.id, after);
            }}
          >
            <Codicon name={v.icon} size={24} />
          </button>
          </Tooltip>
        ))}
      </div>
      <div className="activity-items-bottom">
        {BOTTOM_VIEWS.map((v) => (
          <Tooltip key={v.id} label={v.label} placement="top">
          <button
            className={`activity-item${activeView === v.id ? ' active' : ''}`}
            data-view={v.id}
            aria-label={v.label}
            onClick={() => onViewChange(v.id)}
          >
            <Codicon name={v.icon} size={24} />
          </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
