import type { IconAction } from "../../icons/codicons/codicon-map";
import type { MenuItemSpec } from "../ui/Menu";
import type { OpenFile } from "../../types";

/** Contexto avaliado por `when` (estilo `editor/title` do VS Code). */
export interface EditorActionContext {
  /** Arquivo ativo do grupo (null = grupo vazio). */
  file: OpenFile | null;
  groupId: string;
  isActiveGroup: boolean;
}

/**
 * Uma ação do título do editor (barra à direita das abas). Outras frentes
 * contribuem itens aqui — p.ex. botões Claude/Codex que revelam a view salva.
 */
export interface EditorActionItem {
  id: string;
  icon: IconAction;
  /** Rótulo acessível + tooltip (botões só-ícone nunca ficam anônimos). */
  label: string;
  /** Ação direta. Ignorada quando `menu` existe. */
  run?: (ctx: EditorActionContext) => void;
  /** Abre um menu (ex.: Git) em vez de executar direto. */
  menu?: (ctx: EditorActionContext) => readonly MenuItemSpec[];
  /** Visível só quando true (padrão: sempre). */
  when?: (ctx: EditorActionContext) => boolean;
  /** Toggle ligado (aria-pressed + preenchimento selecionado). */
  pressed?: (ctx: EditorActionContext) => boolean;
  /** `primary` = ícone na barra; `overflow` = só no menu "Mais ações". */
  group?: "primary" | "overflow";
  /** Ordem crescente dentro do grupo (padrão 100). */
  order?: number;
}

type Listener = () => void;
const contributed = new Map<string, EditorActionItem>();
const listeners = new Set<Listener>();
let snapshot: readonly EditorActionItem[] = [];

function publish() {
  snapshot = [...contributed.values()];
  for (const l of listeners) l();
}

/**
 * Registra uma ação global (aparece em todo grupo de editor onde `when`
 * permitir). Retorna a função de remoção. Registrar o mesmo `id` substitui.
 */
export function registerEditorAction(item: EditorActionItem): () => void {
  contributed.set(item.id, item);
  publish();
  return () => {
    if (contributed.get(item.id) === item) {
      contributed.delete(item.id);
      publish();
    }
  };
}

export function subscribeEditorActions(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function contributedEditorActions(): readonly EditorActionItem[] {
  return snapshot;
}

/**
 * Junta ações locais + contribuídas, filtra por `when` e divide em barra e
 * overflow. Acima de `maxPrimary` ícones, os excedentes (os de maior `order`)
 * vão para o menu "Mais ações". Pura (testada).
 */
export function arrangeEditorActions(
  items: readonly EditorActionItem[],
  ctx: EditorActionContext,
  maxPrimary: number
): { primary: EditorActionItem[]; overflow: EditorActionItem[] } {
  const seen = new Set<string>();
  const visible = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return item.when ? item.when(ctx) : true;
  });
  const byOrder = (a: EditorActionItem, b: EditorActionItem) => (a.order ?? 100) - (b.order ?? 100);
  const primaryAll = visible.filter((i) => (i.group ?? "primary") === "primary").sort(byOrder);
  const overflow = visible.filter((i) => i.group === "overflow").sort(byOrder);
  const limit = Math.max(0, maxPrimary);
  return {
    primary: primaryAll.slice(0, limit),
    overflow: [...primaryAll.slice(limit), ...overflow],
  };
}
