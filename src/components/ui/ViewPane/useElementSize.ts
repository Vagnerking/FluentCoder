import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Tamanho (px CSS) de um elemento, atualizado por ResizeObserver. Começa em
 * `{0, 0}` até a primeira medição; quem usa trata 0 como "ainda não medido".
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const width = Math.round(r.width);
      const height = Math.round(r.height);
      setSize((cur) => (cur.width === width && cur.height === height ? cur : { width, height }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
