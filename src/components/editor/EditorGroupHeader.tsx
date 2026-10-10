import type { ComponentProps, ReactNode } from "react";
import { TabBar } from "../TabBar";
import { Breadcrumbs } from "../Breadcrumbs";

interface EditorGroupHeaderProps {
  /** Props da faixa de abas (sem `actions`, passado à parte). */
  tabs: Omit<ComponentProps<typeof TabBar>, "actions">;
  /** Ações do título do editor (EditorActions), à direita das abas. */
  actions?: ReactNode;
  /** Breadcrumbs do arquivo ativo; null oculta (grafo, webview…). */
  breadcrumbs: ComponentProps<typeof Breadcrumbs> | null;
}

/**
 * Cabeçalho de um grupo de editor na ORDEM REAL do DOM (= ordem visual e de
 * foco): abas + ações → breadcrumbs → (conteúdo, renderizado pelo grupo).
 * Antes o breadcrumb vinha antes das abas no DOM e o CSS invertia com
 * `order: -1`, então o Tab percorria na ordem errada.
 */
export function EditorGroupHeader({ tabs, actions, breadcrumbs }: EditorGroupHeaderProps) {
  return (
    <>
      <TabBar {...tabs} actions={actions} />
      {breadcrumbs && <Breadcrumbs {...breadcrumbs} />}
    </>
  );
}
