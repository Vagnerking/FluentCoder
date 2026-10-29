/**
 * Nós DOM persistentes das views. O conteúdo React de cada view é renderizado
 * UMA vez (portal) num `<div>` que pertence ao registro, não à região: mover a
 * view entre regiões só reanexa esse nó (`appendChild`), sem desmontar React —
 * terminais, chat e estado de UI sobrevivem.
 *
 * Iframes NÃO podem ser reanexados (o navegador recarrega o documento), então
 * os webviews de extensão vivem numa camada fixa (`ExtensionWebviewLayer`) e só
 * são posicionados sobre o "slot" da view — ver `layerRect`.
 */

const nodes = new Map<string, HTMLDivElement>();

export function viewNode(id: string): HTMLDivElement {
  let el = nodes.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "workbench-view-node";
    el.dataset.viewId = id;
    el.hidden = true;
    nodes.set(id, el);
  }
  return el;
}

export function existingViewNode(id: string): HTMLDivElement | undefined {
  return nodes.get(id);
}

/**
 * Converte um retângulo de cliente (getBoundingClientRect) para as coordenadas
 * CSS de uma camada `position:absolute; inset:0`. O zoom da UI
 * (`html { zoom }`) faz o WebKit/Chromium medirem em px de cliente enquanto os
 * estilos usam px CSS do elemento; a razão medida na própria camada absorve a
 * diferença em qualquer motor.
 */
export function layerRect(rect: DOMRect | { left: number; top: number; width: number; height: number }, layer: HTMLElement) {
  const lr = layer.getBoundingClientRect();
  const ratio = layer.offsetWidth > 0 && lr.width > 0 ? lr.width / layer.offsetWidth : 1;
  return {
    left: (rect.left - lr.left) / ratio,
    top: (rect.top - lr.top) / ratio,
    width: rect.width / ratio,
    height: rect.height / ratio,
  };
}
