import { useLayoutEffect, useRef, useState } from "react";
import { REGION_LABELS, type ViewDescriptor } from "./viewRegistry";
import { layerRect } from "./viewNodes";
import { useViewDragState } from "./WorkbenchViews";
import { ViewIconGlyph } from "./ViewIconGlyph";

/**
 * Indicadores de soltura durante o arraste de uma view: cada região (aberta ou
 * faixa virtual de uma fechada) ganha um contorno; a sob o ponteiro destaca e
 * nomeia o destino, com a barra de inserção entre as abas. Um "chip" com
 * ícone + título segue o ponteiro (não o elemento vivo da aba).
 */
export function ViewDropOverlay({ descriptors }: { descriptors: readonly ViewDescriptor[] }) {
  const drag = useViewDragState();
  const layerRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  // A camada precisa existir para converter as coordenadas (zoom da UI).
  useLayoutEffect(() => {
    if (drag && layerRef.current) force((n) => n + 1);
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!drag) return null;
  const layer = layerRef.current;
  const desc = descriptors.find((d) => d.id === drag.viewId);
  const conv = (r: { left: number; top: number; width: number; height: number }) =>
    layer ? layerRect(r, layer) : r;

  let insert: { left: number; top: number; height: number } | null = null;
  const t = drag.target;
  if (t && t.index != null) {
    const zone = drag.zones.find((z) => z.region === t.region && !z.virtual);
    const tabs = zone?.tabs.filter((x) => x.id !== drag.viewId) ?? [];
    if (zone && tabs.length) {
      const ref = tabs[Math.min(t.index, tabs.length - 1)].rect;
      const x = t.index >= tabs.length ? ref.left + ref.width : ref.left;
      const r = conv({ left: x - 1, top: ref.top + 3, width: 2, height: ref.height - 6 });
      insert = { left: r.left, top: r.top, height: r.height };
    }
  }

  return (
    <div className="view-drop-layer" ref={layerRef} aria-hidden="true">
      {layer &&
        drag.zones.map((z) => {
          const r = conv(z.rect);
          const isTarget = t?.region === z.region;
          return (
            <div
              key={`${z.region}-${z.virtual ? "v" : "r"}`}
              className={`view-drop-zone${isTarget ? " is-target" : ""}${z.virtual ? " is-virtual" : ""}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            >
              {isTarget && <span className="view-drop-label">Mover para {REGION_LABELS[z.region]}</span>}
            </div>
          );
        })}
      {insert && <div className="view-drop-insert" style={insert} />}
      {layer && desc && (
        <div className="view-drag-chip" style={(() => {
          const p = conv({ left: drag.x, top: drag.y, width: 0, height: 0 });
          return { left: p.left + 12, top: p.top + 10 };
        })()}>
          <ViewIconGlyph icon={desc.icon} size={14} />
          <span>{desc.title}</span>
        </div>
      )}
    </div>
  );
}
