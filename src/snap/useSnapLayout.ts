import { useEffect } from "react";
import type { RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { snapSetMaxButtonRect } from "../api";

/**
 * Wires the maximize button to the Windows 11 Snap Layouts overlay (our backend
 * `snap.rs`): reports the button's rect so the native hit-test overlay sits over
 * it, re-reporting whenever it moves (resize / layout / DPI). Since the overlay
 * covers the button the webview can't `:hover` it, so it also relays the OS hover
 * (`snap-max-hover`) to `onHover`. No-op off Windows (the command is a no-op).
 */
export function useSnapLayout(
  buttonRef: RefObject<HTMLElement | null>,
  onHover: (hovering: boolean) => void
) {
  useEffect(() => {
    const win = getCurrentWindow();
    const report = () => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      void snapSetMaxButtonRect(r.left, r.top, r.width, r.height);
    };
    report();
    // One delayed pass after fonts/layout settle, plus live updates on resize.
    const settle = window.setTimeout(report, 300);
    window.addEventListener("resize", report);
    const ro = new ResizeObserver(report);
    if (buttonRef.current) ro.observe(buttonRef.current);

    let unlisten: (() => void) | undefined;
    void win
      .listen<boolean>("snap-max-hover", (e) => onHover(e.payload))
      .then((fn) => (unlisten = fn));

    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", report);
      ro.disconnect();
      unlisten?.();
      // Tear the overlay down when the title bar unmounts.
      void snapSetMaxButtonRect(0, 0, 0, 0);
    };
    // Stable ref + setter → run once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
