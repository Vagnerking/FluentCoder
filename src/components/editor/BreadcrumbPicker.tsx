import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../../icons/codicons/Codicon";
import type { IconAction } from "../../icons/codicons/codicon-map";
import { FileIcon } from "../../icon-theme/material/FileIcon";
import { placeMenu, type Rect } from "../ui/menuLogic";

export interface BreadcrumbPickerItem {
  id: string;
  label: string;
  /** Codicon (símbolos, "subir pasta"). */
  icon?: IconAction;
  /** Ícone Material de arquivo/pasta (caminho). */
  iconPath?: string;
  isDir?: boolean;
  /** O item atual do caminho (destacado e selecionado ao abrir). */
  current?: boolean;
  /** Texto auxiliar à direita (ex.: tipo do símbolo). */
  description?: string;
  /** Recuo (níveis de símbolos aninhados). */
  depth?: number;
}

interface BreadcrumbPickerProps {
  anchor: Rect;
  /** Rótulo do listbox (ex.: "Itens em src"). */
  ariaLabel: string;
  items: readonly BreadcrumbPickerItem[] | null;
  /** Mensagem de erro (ex.: pasta SSH desconectada). */
  error?: string | null;
  emptyText?: string;
  onPick: (item: BreadcrumbPickerItem) => void;
  onClose: () => void;
  /** Elementos que não contam como "fora" (o segmento que abriu). */
  isInside?: (target: Node) => boolean;
}

/**
 * Seletor dos breadcrumbs: flyout ancorado ao segmento (superfície `ui-menu`)
 * com filtro e lista (listbox). ↑/↓/Home/End movem, Enter escolhe, Esc fecha,
 * digitar filtra. Usado para irmãos de pastas/arquivos e de símbolos.
 */
export function BreadcrumbPicker({
  anchor,
  ariaLabel,
  items,
  error,
  emptyText = "Nada aqui.",
  onPick,
  onClose,
  isInside,
}: BreadcrumbPickerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!items) return [];
    return q ? items.filter((i) => i.label.toLocaleLowerCase().includes(q)) : [...items];
  }, [items, query]);
  const [active, setActive] = useState(0);

  // Ao (re)carregar a lista, seleciona o item atual do caminho.
  useEffect(() => {
    const i = filtered.findIndex((x) => x.current);
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query]);

  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const p = placeMenu(
      anchor,
      "bottom-start",
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    );
    setPos(p);
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, items?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || surfaceRef.current?.contains(t) || isInside?.(t)) return;
      onCloseRef.current();
    };
    const onBlur = () => onCloseRef.current();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [isInside]);

  // Devolve o foco ao segmento que abriu o seletor.
  useLayoutEffect(() => {
    const restore = restoreRef.current;
    return () => {
      const a = document.activeElement;
      if ((!a || a === document.body || surfaceRef.current?.contains(a)) && restore instanceof HTMLElement && restore.isConnected) {
        restore.focus({ preventScroll: true });
      }
    };
  }, []);

  const pick = (i: number) => {
    const item = filtered[i];
    if (item) onPick(item);
  };

  return createPortal(
    <div
      ref={surfaceRef}
      className="ui-menu breadcrumb-picker"
      data-ui-menu=""
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.left, top: anchor.bottom, visibility: "hidden" }}
      onKeyDown={(e) => {
        const n = filtered.length;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown" && n) {
          e.preventDefault();
          setActive((a) => (a + 1) % n);
        } else if (e.key === "ArrowUp" && n) {
          e.preventDefault();
          setActive((a) => (a - 1 + n) % n);
        } else if (e.key === "Home" && n && !query) {
          e.preventDefault();
          setActive(0);
        } else if (e.key === "End" && n && !query) {
          e.preventDefault();
          setActive(n - 1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          pick(active);
        } else if (e.key === "Tab") {
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        className="breadcrumb-picker-filter"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
        aria-label={`Filtrar: ${ariaLabel}`}
        placeholder="Filtrar"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="ui-menu-items breadcrumb-picker-list">
        {items === null && !error && (
          <div className="breadcrumb-picker-status" role="status">
            Carregando…
          </div>
        )}
        {error && (
          <div className="breadcrumb-picker-status is-error" role="status">
            {error}
          </div>
        )}
        {items !== null && !error && filtered.length === 0 && (
          <div className="breadcrumb-picker-status">{query ? "Nenhum resultado." : emptyText}</div>
        )}
        {filtered.map((item, i) => (
          <div
            key={item.id}
            id={`${listId}-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === active}
            aria-current={item.current ? "true" : undefined}
            className={`ui-menu-item breadcrumb-picker-item${i === active ? " is-active" : ""}${item.current ? " is-current" : ""}`}
            style={item.depth ? { paddingLeft: `calc(var(--space-sm) + ${item.depth * 12}px)` } : undefined}
            onPointerMove={() => setActive(i)}
            onClick={() => pick(i)}
          >
            <span className="ui-menu-icon">
              {item.iconPath ? (
                <FileIcon path={item.iconPath} isDir={item.isDir} className="breadcrumb-picker-file-icon" />
              ) : item.icon ? (
                <Codicon name={item.icon} />
              ) : null}
            </span>
            <span className="ui-menu-label">{item.label}</span>
            {item.description && <span className="ui-menu-shortcut">{item.description}</span>}
            {item.isDir && <Codicon name="chevronRight" className="ui-menu-chevron" />}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}
