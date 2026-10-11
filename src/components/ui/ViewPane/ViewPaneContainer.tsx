import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { IconAction } from "../../../icons/codicons/codicon-map";
import { cx } from "../cx";
import type { PaneAction } from "./ActionBar";
import { SectionHeader } from "./SectionHeader";
import { useElementSize } from "./useElementSize";
import {
  VIEW_PANE_DEFAULT_MIN_BODY,
  VIEW_PANE_HEADER_SIZE,
  headerKeyTarget,
  nextExpandedIndex,
  parseViewPaneState,
  resizeViewPanePair,
  sashKeyDelta,
  sizesToWeights,
  solveViewPaneLayout,
  type ViewPaneState,
} from "./viewPaneLayout";

/** Um pane do container (cabeçalho + corpo). */
export interface ViewPaneDescriptor {
  /** Identidade estável (chave da persistência). */
  id: string;
  title: string;
  icon?: IconAction;
  /** Contagem / rótulo curto no cabeçalho. */
  badge?: string | number;
  badgeLabel?: string;
  /** Ações do cabeçalho (hover/foco, só expandido; excedente vai para "…"). */
  actions?: readonly PaneAction[];
  /** Altura mínima do corpo (px). Padrão 48. */
  minBodySize?: number;
  /** Proporção inicial entre os expandidos. Padrão 1. */
  defaultWeight?: number;
  /** Expandido na primeira vez (antes de o usuário mexer). Padrão true. */
  defaultExpanded?: boolean;
  /** Classe extra no corpo (o corpo já rola e é container de inline-size). */
  bodyClassName?: string;
  children: ReactNode;
}

export interface ViewPaneContainerProps {
  /** Chave da persistência: `localStorage["ui.viewPanes.<id>"]`. */
  id: string;
  panes: readonly ViewPaneDescriptor[];
  ariaLabel?: string;
  className?: string;
}

const storageKey = (id: string) => `ui.viewPanes.${id}`;

function loadState(id: string): ViewPaneState {
  try {
    return parseViewPaneState(localStorage.getItem(storageKey(id)));
  } catch {
    return parseViewPaneState(null);
  }
}

function saveState(id: string, state: ViewPaneState) {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(state));
  } catch {
    /* armazenamento indisponível: o layout só não persiste */
  }
}

/**
 * Pilha vertical de view panes (modelo `ViewPaneContainer` do VS Code):
 * cabeçalhos de nível 1 recolhíveis; os expandidos dividem a altura
 * (proporções persistidas por container); sashes entre dois expandidos
 * redimensionam o par; um expandido sozinho ocupa tudo; recolhidos depois do
 * último expandido ficam empilhados no rodapé. Teclado: Enter/Espaço
 * alternam, ↑/↓/Home/End andam entre cabeçalhos; na sash, ↑/↓ (Shift = 64 px)
 * e Enter/duplo clique restauram o padrão. Regras puras em `viewPaneLayout.ts`.
 */
export function ViewPaneContainer({ id, panes, ariaLabel, className }: ViewPaneContainerProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(rootRef);
  const [state, setState] = useState<ViewPaneState>(() => loadState(id));
  const toggleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Tamanhos ao vivo durante um arraste (px), antes de virarem proporções.
  const [dragSizes, setDragSizes] = useState<number[] | null>(null);

  useEffect(() => setState(loadState(id)), [id]);

  const update = useCallback(
    (fn: (s: ViewPaneState) => ViewPaneState) => {
      setState((cur) => {
        const next = fn(cur);
        saveState(id, next);
        return next;
      });
    },
    [id]
  );

  const items = useMemo(() => {
    // Pesos salvos são proporções (somam ~1); um pane sem peso salvo entra com
    // a média dos salvos, para não dominar nem sumir ao lado deles.
    const stored = panes.map((p) => state.weights[p.id]).filter((w): w is number => w !== undefined);
    const base = stored.length ? stored.reduce((a, b) => a + b, 0) / stored.length : 1;
    return panes.map((p) => ({
      id: p.id,
      expanded: state.expanded[p.id] ?? p.defaultExpanded ?? true,
      minBody: p.minBodySize ?? VIEW_PANE_DEFAULT_MIN_BODY,
      weight: state.weights[p.id] ?? base * (p.defaultWeight ?? 1),
    }));
  }, [panes, state]);

  const solved = useMemo(
    () => (height > 0 ? solveViewPaneLayout(items, height, VIEW_PANE_HEADER_SIZE) : null),
    [items, height]
  );
  const sizes = dragSizes ?? solved;
  const lastExpanded = items.reduce((acc, it, i) => (it.expanded ? i : acc), -1);

  const toggle = (index: number) => {
    const p = items[index];
    update((s) => ({ ...s, expanded: { ...s.expanded, [p.id]: !p.expanded } }));
  };

  const commitSizes = (next: number[]) => {
    const weights = sizesToWeights(items, next);
    update((s) => ({ ...s, weights: { ...s.weights, ...weights } }));
  };

  /** Restaura o par ao padrão: divide o espaço dos dois pelos pesos padrão. */
  const resetPair = (upper: number, lower: number) => {
    const cur = sizes ?? solved;
    if (!cur) return;
    const du = panes[upper].defaultWeight ?? 1;
    const dl = panes[lower].defaultWeight ?? 1;
    const total = cur[upper] + cur[lower];
    const next = [...cur];
    next[upper] = Math.max(items[upper].minBody, Math.round((total * du) / (du + dl)));
    next[lower] = total - next[upper];
    commitSizes(next);
  };

  const onHeaderKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = headerKeyTarget(e.key, index, panes.length);
    if (target === null) return;
    e.preventDefault();
    toggleRefs.current[target]?.focus();
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, upper: number, lower: number) => {
    if (e.button !== 0 || !solved) return;
    e.preventDefault();
    const start = [...(sizes ?? solved)];
    const mins = items.map((it) => it.minBody);
    const y0 = e.clientY;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    let latest = start;
    const move = (ev: PointerEvent) => {
      latest = resizeViewPanePair(start, upper, lower, ev.clientY - y0, mins);
      setDragSizes(latest);
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      setDragSizes(null);
      if (latest !== start) commitSizes(latest);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onSashKeyDown = (e: KeyboardEvent<HTMLDivElement>, upper: number, lower: number) => {
    if (!sizes) return;
    if (e.key === "Enter") {
      e.preventDefault();
      resetPair(upper, lower);
      return;
    }
    const delta = sashKeyDelta(e.key, e.shiftKey);
    if (delta === null) return;
    e.preventDefault();
    commitSizes(resizeViewPanePair(sizes, upper, lower, delta, items.map((it) => it.minBody)));
  };

  return (
    <div
      ref={rootRef}
      className={cx("ui-view-pane-container", dragSizes && "is-resizing", className)}
      role="group"
      aria-label={ariaLabel}
    >
      {panes.map((p, i) => {
        const it = items[i];
        const bodyId = `${uid}-body-${i}`;
        const body = sizes?.[i] ?? 0;
        const lower = it.expanded ? nextExpandedIndex(items, i) : -1;
        // Antes da 1ª medição: flex por peso (sem salto quando o RO chega).
        const bodyStyle = sizes
          ? { height: body, flex: "0 0 auto" }
          : { flex: `${it.weight} 1 0px`, minHeight: it.minBody };
        return (
          <section
            key={p.id}
            className={cx(
              "ui-view-pane",
              it.expanded ? "is-expanded" : "is-collapsed",
              i === lastExpanded && "is-last-expanded"
            )}
            data-pane-id={p.id}
            style={!sizes && it.expanded ? { flex: `${it.weight} 1 0px`, minHeight: 0 } : undefined}
          >
            <SectionHeader
              ref={(el) => {
                toggleRefs.current[i] = el;
              }}
              level={1}
              title={p.title}
              icon={p.icon}
              badge={p.badge}
              badgeLabel={p.badgeLabel}
              expanded={it.expanded}
              onToggle={() => toggle(i)}
              controlsId={bodyId}
              actions={p.actions}
              onToggleKeyDown={(e) => onHeaderKeyDown(e, i)}
              className="ui-view-pane-header"
            />
            {it.expanded && (
              <div
                id={bodyId}
                className={cx("ui-view-pane-body", p.bodyClassName)}
                role="region"
                aria-label={p.title}
                style={bodyStyle}
              >
                {p.children}
              </div>
            )}
            {lower >= 0 && sizes && (
              <div
                className="ui-view-pane-sash"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Redimensionar ${p.title} e ${panes[lower].title}`}
                aria-valuemin={it.minBody}
                aria-valuemax={Math.max(it.minBody, body + (sizes[lower] ?? 0) - items[lower].minBody)}
                aria-valuenow={body}
                tabIndex={0}
                onPointerDown={(e) => startDrag(e, i, lower)}
                onDoubleClick={() => resetPair(i, lower)}
                onKeyDown={(e) => onSashKeyDown(e, i, lower)}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}
