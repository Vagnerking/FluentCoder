/**
 * Cross-window drag feedback: maps a SCREEN point (CSS px, sent from the drag's
 * source window) to a tab-strip insertion target in THIS window. HTML5 DnD never
 * crosses windows, so the source emits the cursor position and each window
 * resolves it locally against its own laid-out tab strips.
 */

export interface DropTarget {
  /** Insertion-bar position in this window's client coords. */
  bar: { left: number; top: number; height: number };
  /** The group whose strip is under the cursor. */
  groupId: string | null;
  /** Insert before/after this tab (null targetPath = append at the end). */
  targetPath: string | null;
  before: boolean;
}

/**
 * Resolves the tab strip + insertion point under a screen point, or null when
 * the point isn't over any strip (the caller then shows a whole-window hint and
 * appends to the active group on drop).
 */
export function dropTargetAt(screenX: number, screenY: number): DropTarget | null {
  // The window's own screen origin → convert to client coords. Frameless
  // windows have no chrome, so screenX/Y is the content top-left.
  const cx = screenX - window.screenX;
  const cy = screenY - window.screenY;
  const strips = document.querySelectorAll<HTMLElement>(
    ".tab-bar[data-group-id]"
  );
  for (const strip of strips) {
    const r = strip.getBoundingClientRect();
    if (cy < r.top || cy > r.bottom || cx < r.left || cx > r.right) continue;
    const groupId = strip.getAttribute("data-group-id") || null;
    const tabs = strip.querySelectorAll<HTMLElement>(".tab");
    let targetPath: string | null = null;
    let before = false;
    let barLeft = r.right - 1;
    for (const tab of tabs) {
      const tr = tab.getBoundingClientRect();
      if (cx < tr.left + tr.width / 2) {
        targetPath = tab.getAttribute("data-path");
        before = true;
        barLeft = tr.left - 2;
        break;
      }
    }
    return {
      bar: { left: barLeft, top: r.top + 3, height: r.height - 6 },
      groupId,
      targetPath,
      before,
    };
  }
  return null;
}
