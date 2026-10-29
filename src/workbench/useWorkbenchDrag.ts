import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  startPointerDrag,
  workbenchDrag,
  type DragSession,
  type DragSessionOptions,
  type PointerDragOptions,
  type WorkbenchDragKind,
} from "./workbenchDrag";

export {
  installNativeDragGuard,
  setDragPreview,
  workbenchDrag,
  type WorkbenchDragKind,
} from "./workbenchDrag";

/** True enquanto houver um arraste (opcionalmente de um tipo) no workbench. */
export function useWorkbenchDragActive(kind?: WorkbenchDragKind): boolean {
  return useSyncExternalStore(
    workbenchDrag.subscribe,
    () => workbenchDrag.isActive(kind),
    () => false
  );
}

/**
 * Ponto único de arraste para abas, painéis e alças de redimensionamento.
 * Sessões abertas por este hook são encerradas na desmontagem do componente,
 * então a classe de raiz nunca fica presa.
 */
export function useWorkbenchDrag() {
  const open = useRef(new Set<DragSession>());

  useEffect(() => {
    const sessions = open.current;
    return () => {
      for (const s of sessions) s.cancel();
      sessions.clear();
    };
  }, []);

  const track = useCallback((s: DragSession) => {
    open.current.add(s);
    return s;
  }, []);

  /** Sessão manual (ex.: HTML5 DnD de aba: begin no dragstart, end no dragend). */
  const begin = useCallback(
    (kind: WorkbenchDragKind, opts?: DragSessionOptions): DragSession => {
      let wrapper: DragSession | null = null;
      const s = workbenchDrag.begin(kind, {
        ...opts,
        onCancel: () => {
          if (wrapper) open.current.delete(wrapper);
          opts?.onCancel?.();
        },
      });
      wrapper = {
        kind: s.kind,
        get active() {
          return s.active;
        },
        cancel: s.cancel,
        end: () => {
          if (wrapper) open.current.delete(wrapper);
          s.end();
        },
      };
      return track(wrapper);
    },
    [track]
  );

  /** Arraste por ponteiro (pointermove/up/cancel + Escape/blur). */
  const pointer = useCallback(
    (opts: PointerDragOptions): DragSession => {
      const s = startPointerDrag({
        ...opts,
        onEnd: (committed) => {
          open.current.delete(s);
          opts.onEnd?.(committed);
        },
      });
      return track(s);
    },
    [track]
  );

  return { begin, pointer };
}
