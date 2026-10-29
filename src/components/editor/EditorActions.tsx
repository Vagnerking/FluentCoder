import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconButton } from "../ui/IconButton";
import { Menu, type MenuItemSpec } from "../ui/Menu";
import {
  arrangeEditorActions,
  contributedEditorActions,
  editorActionBudget,
  subscribeEditorActions,
  type EditorActionContext,
  type EditorActionItem,
} from "./editorActionRegistry";

export type { EditorActionContext, EditorActionItem } from "./editorActionRegistry";
export { registerEditorAction } from "./editorActionRegistry";

interface EditorActionsProps {
  ctx: EditorActionContext;
  /** Ações locais do grupo (dividir, Git…), somadas às contribuídas. */
  actions: readonly EditorActionItem[];
  /** Itens fixos no fim do menu "Mais ações" (fechar todas…). */
  moreItems?: readonly MenuItemSpec[];
  /** Ícones visíveis antes de transbordar para "Mais ações". */
  maxPrimary?: number;
}

type OpenMenu = { id: string; rect: DOMRect } | null;

/**
 * Barra de ações do título do editor (à direita das abas, como o `editor/title`
 * do VS Code): IconButtons com Tooltip e um menu "Mais ações" para o
 * excedente. Itens com `menu` abrem um flyout (ex.: Git).
 */
export function EditorActions({ ctx, actions, moreItems = [], maxPrimary = 4 }: EditorActionsProps) {
  const contributed = useSyncExternalStore(
    subscribeEditorActions,
    contributedEditorActions,
    contributedEditorActions
  );
  const [open, setOpen] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Largura da faixa do grupo (abas + ações): as ações cedem espaço às abas
  // num grupo estreito, transbordando para "Mais ações".
  const [stripWidth, setStripWidth] = useState(0);
  useLayoutEffect(() => {
    const strip = rootRef.current?.closest<HTMLElement>(".tab-strip");
    if (!strip) return;
    const read = () => setStripWidth(Math.round(strip.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(strip);
    return () => ro.disconnect();
  }, []);
  const budget = editorActionBudget(stripWidth, maxPrimary);
  const { primary, overflow } = useMemo(
    () => arrangeEditorActions([...actions, ...contributed], ctx, budget),
    [actions, contributed, ctx, budget]
  );

  const toMenuItem = (item: EditorActionItem): MenuItemSpec => {
    const sub = item.menu?.(ctx);
    return {
      id: item.id,
      label: item.label,
      icon: item.icon,
      checked: item.pressed ? item.pressed(ctx) : undefined,
      submenu: sub,
      onSelect: sub ? undefined : () => item.run?.(ctx),
    };
  };

  const moreMenu: MenuItemSpec[] = [
    ...overflow.map(toMenuItem),
    ...(overflow.length && moreItems.length ? [{ id: "sep-more", separator: true }] : []),
    ...moreItems,
  ];

  const openFor = (id: string, el: HTMLElement) =>
    setOpen((cur) => (cur?.id === id ? null : { id, rect: el.getBoundingClientRect() }));

  const openItem = open ? primary.find((i) => i.id === open.id) : undefined;
  const openItems: readonly MenuItemSpec[] =
    open?.id === "__more" ? moreMenu : openItem?.menu ? openItem.menu(ctx) : [];

  if (primary.length === 0 && moreMenu.length === 0) return null;

  return (
    <div className="editor-actions" role="toolbar" aria-label="Ações do editor" ref={rootRef}>
      {primary.map((item) => (
        <IconButton
          key={item.id}
          icon={item.icon}
          image={item.iconImage}
          label={item.label}
          size="sm"
          tooltipPlacement="bottom"
          className={`editor-action-btn${item.menu ? " has-menu" : ""} editor-action-${item.id}`}
          pressed={item.pressed ? item.pressed(ctx) : undefined}
          aria-haspopup={item.menu ? "menu" : undefined}
          aria-expanded={item.menu ? open?.id === item.id : undefined}
          onClick={(e) => (item.menu ? openFor(item.id, e.currentTarget) : item.run?.(ctx))}
        />
      ))}
      {moreMenu.length > 0 && (
        <IconButton
          icon="more"
          label="Mais ações"
          size="sm"
          tooltipPlacement="bottom"
          className="editor-action-btn editor-actions-more"
          aria-haspopup="menu"
          aria-expanded={open?.id === "__more"}
          onClick={(e) => openFor("__more", e.currentTarget)}
        />
      )}
      {open && openItems.length > 0 && (
        <Menu
          ariaLabel={open.id === "__more" ? "Mais ações do editor" : openItem?.label}
          anchor={{ rect: open.rect, placement: "bottom-start" }}
          items={openItems}
          minWidth={220}
          isInside={(t) => !!rootRef.current?.contains(t)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
