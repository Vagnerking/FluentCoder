import { useEffect, useRef, useState, type DragEvent } from "react";
import { setDragPreview } from "../../workbench/workbenchDrag";

/** dataTransfer MIME carrying a dragged tab's {groupId, path} across groups. */
export const TAB_DRAG_MIME = "application/x-fluent-tab";

export interface TabDragPayload {
  groupId: string;
  path: string;
}

/** Reads {groupId, path} from a tab-drag dataTransfer (null if not ours). */
export function readTabDragPayload(dt: DataTransfer): TabDragPayload | null {
  const raw = dt.getData(TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TabDragPayload;
  } catch {
    return null;
  }
}

export interface EditorTabDragOptions {
  groupId?: string;
  /** Reordenar habilitado (a aba é `draggable`). */
  onReorder?: (fromPath: string, toPath: string, before: boolean) => void;
  /** Um arraste de aba está ativo em QUALQUER grupo desta janela. */
  externalDragActive?: boolean;
  onTabStripDrop?: (payload: TabDragPayload, targetPath: string | null, before: boolean) => void;
  onDetach?: (path: string, screenX: number, screenY: number) => void;
  onDragStateChange?: (drag: TabDragPayload | null) => void;
  onDragMove?: (screenX: number, screenY: number) => void;
  /** Auto-rolagem da faixa (useTabOverflow). */
  updateAutoScroll: (clientX: number) => void;
  pauseAutoScroll: () => void;
  stopAutoScroll: () => void;
}

/**
 * Arrastar abas: reordenar no grupo, mover para outro grupo (faixa ou
 * drop-zones do corpo), destacar para outra janela (posição de tela no
 * dragend) e dica de janela de destino. O preview do arraste é dedicado
 * (ícone + nome) e o estado de arraste global do workbench (sem seleção no
 * WebKitGTK) vem da guarda de arraste nativo.
 */
export function useEditorTabDrag(opts: EditorTabDragOptions) {
  const {
    groupId,
    onReorder,
    externalDragActive,
    onTabStripDrop,
    onDetach,
    onDragStateChange,
    onDragMove,
    updateAutoScroll,
    pauseAutoScroll,
    stopAutoScroll,
  } = opts;
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  // Lado da aba sob o cursor onde vai a barra de inserção (antes/depois).
  const [dragOverSide, setDragOverSide] = useState<"left" | "right">("left");
  // Barra de inserção após a última aba (soltar na área vazia da faixa).
  const [dropAtEnd, setDropAtEnd] = useState(false);
  // Última posição de tela vista no arraste — `dragend` pode trazer
  // coordenadas velhas/zeradas ao soltar sobre outra janela.
  const lastDragScreen = useRef({ x: 0, y: 0 });
  // Limita a dica entre janelas (hit-test no backend a cada frame é caro).
  const lastHintTime = useRef(0);

  // Quando um arraste externo (de outro grupo) termina, some com as dicas.
  useEffect(() => {
    if (!externalDragActive) {
      setDropAtEnd(false);
      if (!dragPath) setDragOverPath(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalDragActive]);

  const reset = () => {
    setDragPath(null);
    setDragOverPath(null);
    setDropAtEnd(false);
    stopAutoScroll();
  };

  /** Handlers da faixa (área vazia após as abas). */
  const stripHandlers = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (dragPath) updateAutoScroll(e.clientX);
      const external = !dragPath && externalDragActive;
      if (external && e.target === e.currentTarget) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOverPath(null);
        setDropAtEnd(true);
      }
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!dragPath && externalDragActive && e.target === e.currentTarget) {
        e.preventDefault();
        const payload = readTabDragPayload(e.dataTransfer);
        if (payload) onTabStripDrop?.(payload, null, false);
        setDragOverPath(null);
        setDropAtEnd(false);
      }
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      pauseAutoScroll();
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setDropAtEnd(false);
        if (!dragPath) setDragOverPath(null);
      }
    },
  };

  /** Handlers de uma aba. */
  const tabHandlers = (path: string, label: string) => ({
    draggable: !!onReorder,
    onDrag: (e: DragEvent<HTMLDivElement>) => {
      // screenX/Y vêm 0 no último evento em algumas plataformas.
      if (e.screenX || e.screenY) {
        lastDragScreen.current = { x: e.screenX, y: e.screenY };
        const now = performance.now();
        if (onDragMove && now - lastHintTime.current > 70) {
          lastHintTime.current = now;
          onDragMove(e.screenX, e.screenY);
        }
      }
    },
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      setDragPath(path);
      onDragStateChange?.({ groupId: groupId ?? "", path });
      lastDragScreen.current = { x: e.screenX, y: e.screenY };
      e.dataTransfer.effectAllowed = "move";
      // O payload marca O QUE e DE ONDE: outros grupos leem o tipo no
      // dragover (getData só funciona no drop).
      e.dataTransfer.setData(TAB_DRAG_MIME, JSON.stringify({ groupId: groupId ?? "", path }));
      // Preview dedicado (ícone + nome) no ponto em que a aba foi pega.
      setDragPreview(e, label, e.currentTarget.querySelector(".tab-icon"));
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      // Aceita reordenar (arraste daqui) OU aba de OUTRO grupo.
      const accepting = dragPath ? dragPath !== path : !!externalDragActive;
      if (!accepting) return;
      e.preventDefault();
      if (!dragPath) e.dataTransfer.dropEffect = "move";
      // Metade esquerda → antes desta aba; direita → depois.
      const r = e.currentTarget.getBoundingClientRect();
      setDragOverSide(e.clientX < r.left + r.width / 2 ? "left" : "right");
      setDragOverPath(path);
      setDropAtEnd(false);
    },
    onDragLeave: () => {
      setDragOverPath((p) => (p === path ? null : p));
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const before = dragOverSide === "left";
      if (dragPath && dragPath !== path) {
        onReorder?.(dragPath, path, before);
      } else if (!dragPath && externalDragActive) {
        const payload = readTabDragPayload(e.dataTransfer);
        if (payload) onTabStripDrop?.(payload, path, before);
      }
      reset();
    },
    onDragEnd: (e: DragEvent<HTMLDivElement>) => {
      // Sempre entrega as coordenadas de TELA e o app decide por POSIÇÃO
      // (não por dropEffect: soltar sobre outro app "aceita" o arraste).
      if (onDetach) {
        const x = e.screenX || lastDragScreen.current.x;
        const y = e.screenY || lastDragScreen.current.y;
        onDetach(path, x, y);
      }
      reset();
      onDragStateChange?.(null);
    },
  });

  /** Classes de estado de arraste de uma aba. */
  const dragClassFor = (path: string): string => {
    const accepting = dragPath ? dragPath !== path : !!externalDragActive;
    const isOver = path === dragOverPath && accepting;
    return (path === dragPath ? " dragging" : "") + (isOver ? ` drag-over-${dragOverSide}` : "");
  };

  return { dragPath, dropAtEnd, stripHandlers, tabHandlers, dragClassFor };
}
