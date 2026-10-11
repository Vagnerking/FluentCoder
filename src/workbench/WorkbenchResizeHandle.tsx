import type { KeyboardEvent, PointerEvent } from "react";
import { useWorkbenchDrag } from "./useWorkbenchDrag";
import { resizeKeyValue } from "./layoutConstraints";

interface Props {
  /**
   * `vertical` = costura vertical (redimensiona a largura, cursor col-resize);
   * `horizontal` = costura horizontal (altura do painel, row-resize).
   */
  orientation: "vertical" | "horizontal";
  /** Tamanho atual (px CSS) da região que a alça controla. */
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /**
   * Sentido: +1 quando arrastar para a direita/baixo AUMENTA a região
   * (região à esquerda/acima da alça); -1 quando diminui.
   */
  direction: 1 | -1;
  /** Nome acessível ("Redimensionar barra lateral primária"). */
  label: string;
  className?: string;
  /** Zoom da UI: o ponteiro anda em px de cliente, os tamanhos são px CSS. */
  scale?: number;
}

/**
 * Alça de redimensionamento única do workbench (barras laterais, painel):
 * ponteiro (sessão `resize` do useWorkbenchDrag — Escape/blur/pointercancel
 * restauram) e teclado (setas ±16 px, Shift ±64, Home/End = mín/máx), com a
 * semântica de separador (`role="separator"`, `aria-valuenow/min/max`).
 * `max` vem do solver de layout: nunca invade o mínimo do editor.
 */
export function WorkbenchResizeHandle({ orientation, value, min, max, onChange, direction, label, className, scale = 1 }: Props) {
  const wb = useWorkbenchDrag();
  const hi = Math.max(min, max);
  const clampV = (v: number) => Math.round(Math.max(min, Math.min(hi, v)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = orientation === "vertical" ? e.clientX : e.clientY;
    const original = value;
    wb.pointer({
      kind: "resize",
      cursor: orientation === "vertical" ? "col-resize" : "row-resize",
      captureTarget: e.currentTarget,
      pointerId: e.pointerId,
      onMove: (me) => {
        const pos = orientation === "vertical" ? me.clientX : me.clientY;
        onChange(clampV(original + ((pos - start) / scale) * direction));
      },
      onEnd: (committed) => {
        if (!committed) onChange(original);
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = resizeKeyValue(e.key, e.shiftKey, value, min, hi, orientation, direction);
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(hi)}
      tabIndex={0}
      className={`workbench-resize-handle${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
