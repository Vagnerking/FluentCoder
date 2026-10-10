import { useCallback, useEffect, useRef, useState, type RefObject, type WheelEvent } from "react";

/**
 * Overflow horizontal da faixa de abas: fades/setas quando há abas escondidas,
 * revelar a aba ativa, rolagem pela roda e auto-rolagem nas bordas durante um
 * arraste (para alcançar abas fora da tela).
 */
export function useTabOverflow(barRef: RefObject<HTMLDivElement>, activePath: string | null, tabCount: number) {
  // Há abas escondidas à esquerda/direita (controla os fades e as setas).
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const autoScroll = useRef({ dir: 0, raf: 0 });

  const syncOverflow = useCallback(() => {
    const el = barRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < max - 1;
    setOverflow((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
  }, [barRef]);

  /** Seta de rolagem: desliza ~70% da largura visível. */
  const scrollTabsBy = useCallback(
    (dir: 1 | -1) => {
      const el = barRef.current;
      if (!el) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: reduce ? "auto" : "smooth" });
    },
    [barRef]
  );

  /** Sem barra de rolagem visível: a roda rola a faixa na horizontal. */
  const onWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      const el = barRef.current;
      if (!el || el.scrollWidth <= el.clientWidth) return;
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (delta !== 0) el.scrollLeft += delta;
    },
    [barRef]
  );

  /** Mantém uma aba visível (rola a própria faixa, nunca ancestrais). */
  const revealTab = useCallback(
    (path: string | null) => {
      const el = barRef.current;
      if (!el || !path) return;
      const tab = Array.from(el.querySelectorAll<HTMLElement>(".tab")).find((t) => t.dataset.path === path);
      if (!tab) return;
      // Folga = largura do fade + seta, para a aba não ficar sob eles.
      const pad = 44;
      if (tab.offsetLeft < el.scrollLeft + pad) {
        el.scrollLeft = Math.max(0, tab.offsetLeft - pad);
      } else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth - pad) {
        el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth + pad;
      }
    },
    [barRef]
  );

  useEffect(() => {
    // Próximo frame: a aba recém-aberta já tem largura final.
    const raf = requestAnimationFrame(() => revealTab(activePath));
    return () => cancelAnimationFrame(raf);
  }, [activePath, revealTab]);

  useEffect(() => {
    syncOverflow();
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabCount, syncOverflow, barRef]);

  const stopAutoScroll = useCallback(() => {
    if (autoScroll.current.raf) cancelAnimationFrame(autoScroll.current.raf);
    autoScroll.current = { dir: 0, raf: 0 };
  }, []);

  const tick = useCallback(() => {
    const el = barRef.current;
    const st = autoScroll.current;
    if (!el || st.dir === 0) {
      st.raf = 0;
      return;
    }
    el.scrollLeft += st.dir * 12;
    syncOverflow();
    st.raf = requestAnimationFrame(tick);
  }, [barRef, syncOverflow]);

  /** Durante um arraste a até 44px de uma borda, rola naquela direção. */
  const updateAutoScroll = useCallback(
    (clientX: number) => {
      const el = barRef.current;
      if (!el) return;
      const EDGE = 44;
      const r = el.getBoundingClientRect();
      const max = el.scrollWidth - el.clientWidth;
      let dir = 0;
      if (clientX < r.left + EDGE && el.scrollLeft > 0) dir = -1;
      else if (clientX > r.right - EDGE && el.scrollLeft < max) dir = 1;
      autoScroll.current.dir = dir;
      if (dir !== 0 && !autoScroll.current.raf) autoScroll.current.raf = requestAnimationFrame(tick);
    },
    [barRef, tick]
  );

  const pauseAutoScroll = useCallback(() => {
    autoScroll.current.dir = 0;
  }, []);

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  return { overflow, syncOverflow, scrollTabsBy, onWheel, revealTab, updateAutoScroll, pauseAutoScroll, stopAutoScroll };
}
