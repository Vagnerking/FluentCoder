/**
 * Registro genérico de views do workbench (estilo `views`/`viewsContainers` do
 * VS Code). Cada view tem identidade estável (`id`), título, ícone e uma região
 * padrão; ONDE ela vive de fato (região, ordem, visibilidade, ativa) é do
 * `viewLayout.ts` (persistido). O conteúdo React é fornecido à parte pelo App
 * (`renderView`), então este módulo é puro e testável em Node.
 *
 * Contratos em docs/context/views-layout.md.
 */
import type { IconAction } from "../icons/codicons/codicon-map";

export type ViewRegion = "primarySidebar" | "secondarySidebar" | "panel";

export const VIEW_REGIONS: readonly ViewRegion[] = ["primarySidebar", "secondarySidebar", "panel"];

export const REGION_LABELS: Record<ViewRegion, string> = {
  primarySidebar: "Barra lateral primária",
  secondarySidebar: "Barra lateral secundária",
  panel: "Painel",
};

/** Ícone de uma view: um codicon do app ou uma imagem (ícone da extensão). */
export type ViewIcon = { codicon: IconAction } | { src: string };

export interface ViewDescriptor {
  /** Identidade estável (persistida). Views de extensão: `ext:<publisher.nome>`. */
  id: string;
  title: string;
  icon: ViewIcon;
  defaultRegion: ViewRegion;
  /** Ordem padrão dentro da região (crescente). */
  defaultOrder: number;
  /**
   * Mantém o conteúdo montado quando a view está oculta (terminais, chat,
   * webviews de extensão — `retainContextWhenHidden`). Sem isso a view só é
   * montada enquanto visível (comportamento antigo da sidebar primária).
   */
  retainWhenHidden?: boolean;
  /** View nativa da activity bar (Explorador, Pesquisar…). */
  activityBar?: boolean;
  /** Regiões aceitas (padrão: todas). */
  allowedRegions?: readonly ViewRegion[];
  /** Extensão dona (views `ext:<id>`). */
  extensionId?: string;
}

/** Id da view de uma extensão hospedada, derivado do id da extensão. */
export function extensionViewId(extensionId: string): string {
  return `ext:${extensionId.toLowerCase()}`;
}

export function extensionIdOfView(viewId: string): string | null {
  return viewId.startsWith("ext:") ? viewId.slice(4) : null;
}

export function isRegionAllowed(desc: Pick<ViewDescriptor, "allowedRegions">, region: ViewRegion): boolean {
  return !desc.allowedRegions || desc.allowedRegions.includes(region);
}

type Listener = () => void;

export function createViewRegistry() {
  const views = new Map<string, ViewDescriptor>();
  const listeners = new Set<Listener>();
  let snapshot: readonly ViewDescriptor[] = [];

  const publish = () => {
    snapshot = [...views.values()].sort((a, b) => a.defaultOrder - b.defaultOrder || a.id.localeCompare(b.id));
    for (const l of listeners) l();
  };

  return {
    /**
     * Registra (ou substitui, mesmo `id`) uma view. Retorna a remoção — que só
     * remove se a entrada ainda for esta (substituições posteriores ficam).
     */
    register(desc: ViewDescriptor): () => void {
      const prev = views.get(desc.id);
      if (prev && sameDescriptor(prev, desc)) return () => unregister(desc.id, prev);
      views.set(desc.id, desc);
      publish();
      return () => unregister(desc.id, desc);
    },
    get(id: string): ViewDescriptor | undefined {
      return views.get(id);
    },
    /** Snapshot estável (mesma referência até a próxima mudança). */
    list(): readonly ViewDescriptor[] {
      return snapshot;
    },
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };

  function unregister(id: string, desc: ViewDescriptor) {
    if (views.get(id) !== desc) return;
    views.delete(id);
    publish();
  }
}

function sameDescriptor(a: ViewDescriptor, b: ViewDescriptor): boolean {
  const icon = (i: ViewIcon) => ("codicon" in i ? `c:${i.codicon}` : `s:${i.src}`);
  return (
    a.title === b.title &&
    icon(a.icon) === icon(b.icon) &&
    a.defaultRegion === b.defaultRegion &&
    a.defaultOrder === b.defaultOrder &&
    !!a.retainWhenHidden === !!b.retainWhenHidden &&
    !!a.activityBar === !!b.activityBar &&
    a.extensionId === b.extensionId &&
    (a.allowedRegions ?? []).join() === (b.allowedRegions ?? []).join()
  );
}

export type ViewRegistry = ReturnType<typeof createViewRegistry>;

/** Registro único da janela. */
export const viewRegistry: ViewRegistry = createViewRegistry();
