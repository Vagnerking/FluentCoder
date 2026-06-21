import { useRef } from "react";
import type { MouseEvent } from "react";

/**
 * Backdrop dismissal that ignores drags (issue #8 UX). A modal closes only when
 * a press AND release both land on the backdrop itself — a genuine click-away.
 *
 * This fixes two problems with the previous `onMouseDown={onClose}` backdrops:
 * - **Dragging dismissed the modal**: starting a drag (the activity-bar reorder,
 *   a text selection, a window move) fired the backdrop's mousedown and closed
 *   it. Now the release must also be on the backdrop, so a drag never closes it.
 * - **A press that began inside the card** (then released on the backdrop) closed
 *   it. The `armed` flag only trips when the press started on the backdrop.
 *
 * Spread the returned handlers onto the backdrop element; do NOT also stop
 * mousedown propagation on the inner card (the target check already excludes it).
 */
export function useModalDismiss(onClose: () => void) {
  // Where the press started, only if it began on the backdrop itself.
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onMouseDown: (e: MouseEvent) => {
      start.current =
        e.target === e.currentTarget ? { x: e.clientX, y: e.clientY } : null;
    },
    onMouseUp: (e: MouseEvent) => {
      const from = start.current;
      start.current = null;
      if (!from || e.target !== e.currentTarget) return;
      // A drag (release moved from the press point) is not a click-away.
      const moved =
        Math.abs(e.clientX - from.x) > 4 || Math.abs(e.clientY - from.y) > 4;
      if (!moved) onClose();
    },
  };
}
