import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ExtensionWebview } from "./ExtensionWebview";
import type { WebviewInfo } from "./protocol";
import type { ExtensionViewsModel } from "./useExtensionViews";
import { layerRect } from "../workbench/viewNodes";
import { workbenchDrag } from "../workbench/workbenchDrag";
import { Button } from "../components/ui/Button";

// ---- slots: onde cada webview deve aparecer --------------------------------

type SlotListener = () => void;
const slots = new Map<string, HTMLElement>();
const slotListeners = new Set<SlotListener>();
function emitSlots() {
  for (const l of slotListeners) l();
}

/**
 * Lugar da view na região (um `<div>` vazio que ocupa o corpo da view). O
 * iframe NÃO é filho daqui: fica na `ExtensionWebviewLayer` e é posicionado
 * sobre este slot. Assim mover a view de região (o slot muda de pai) nunca
 * remove o iframe do DOM — que recarregaria o webview e perderia o estado.
 */
function WebviewSlot({ handle }: { handle: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    slots.set(handle, el);
    emitSlots();
    return () => {
      if (slots.get(handle) === el) slots.delete(handle);
      emitSlots();
    };
  }, [handle]);
  return <div ref={ref} className="ext-webview-slot" data-webview-slot={handle} />;
}

interface ViewProps {
  extensionId: string;
  label: string;
  visible: boolean;
  model: ExtensionViewsModel;
}

/**
 * Conteúdo da view `ext:<id>` no registro: status (iniciando/erro) ou o slot
 * do webview. Resolve a view só na 1ª vez que fica visível (a extensão ativa
 * ao abrir a view, como no VS Code).
 */
export function ExtensionView({ extensionId, label, visible, model }: ViewProps) {
  const state = model.states[extensionId];
  const { ensureResolved } = model;
  useEffect(() => {
    if (visible && !state) ensureResolved(extensionId);
  }, [visible, state, extensionId, ensureResolved]);

  if (model.hostError && (!state || state === "loading")) {
    return (
      <div className="ext-webview-status error" role="alert">
        {model.hostError}{" "}
        <Button size="sm" onClick={model.retry}>
          Tentar novamente
        </Button>
      </div>
    );
  }
  if (!state || state === "loading") {
    return (
      <div className="ext-webview-status" role="status">
        Iniciando {label}…
      </div>
    );
  }
  if ("error" in state) {
    return (
      <div className="ext-webview-status error" role="alert">
        Não foi possível abrir {label}: {state.error}
      </div>
    );
  }
  return <WebviewSlot handle={state.handle} />;
}

// ---- camada fixa dos iframes -----------------------------------------------

interface Placement {
  style: CSSProperties;
  visible: boolean;
}

const HIDDEN: Placement = { style: { visibility: "hidden", left: 0, top: 0, width: 0, height: 0 }, visible: false };

function measure(slot: HTMLElement | undefined, layer: HTMLElement): Placement {
  if (!slot || !slot.isConnected || slot.offsetParent === null) return HIDDEN;
  const r = slot.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return HIDDEN;
  const p = layerRect(r, layer);
  // Região reaberta como sobreposição (falta de espaço): o iframe sobe junto.
  const z = slot.closest<HTMLElement>("[data-region-overlay]") ? 31 : 6;
  return {
    style: { left: p.left, top: p.top, width: p.width, height: p.height, zIndex: z },
    visible: true,
  };
}

function samePlacement(a: Placement | undefined, b: Placement): boolean {
  if (!a || a.visible !== b.visible) return false;
  const s = a.style;
  const t = b.style;
  return s.left === t.left && s.top === t.top && s.width === t.width && s.height === t.height && s.zIndex === t.zIndex;
}

/**
 * Todos os webviews de view das extensões, montados UMA vez por handle e
 * posicionados sobre o slot da view onde quer que ela esteja (sidebar
 * primária/secundária, painel, sobreposição). Oculto (`visibility: hidden`)
 * quando o slot não está visível — o iframe continua vivo
 * (retainContextWhenHidden) e o host recebe `webviewVisible`.
 */
export function ExtensionWebviewLayer({ model }: { model: ExtensionViewsModel }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [placements, setPlacements] = useState<Record<string, Placement>>({});
  const infos = Object.values(model.states).filter((s): s is WebviewInfo => s !== "loading" && "handle" in s);
  const handlesKey = infos.map((i) => i.handle).join("|");

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setPlacements((cur) => {
        let changed = false;
        const next: Record<string, Placement> = {};
        for (const handle of handlesKey ? handlesKey.split("|") : []) {
          const p = measure(slots.get(handle), layer);
          next[handle] = samePlacement(cur[handle], p) ? cur[handle] : p;
          if (next[handle] !== cur[handle]) changed = true;
        }
        if (Object.keys(cur).length !== Object.keys(next).length) changed = true;
        return changed ? next : cur;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Mudanças de posição vêm de: tamanho de qualquer região/janela, troca de
    // aba/região (slots), arrastes/redimensionamentos e zoom da UI.
    const ro = new ResizeObserver(schedule);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(document.documentElement);
      for (const el of document.querySelectorAll("[data-workbench-region], .app-main, .app > .body")) ro.observe(el);
      for (const el of slots.values()) ro.observe(el);
    };
    observeAll();
    const onSlots = () => {
      observeAll();
      schedule();
    };
    slotListeners.add(onSlots);
    const offDrag = workbenchDrag.subscribe(schedule);
    window.addEventListener("resize", schedule);
    // Rede de segurança barata para mudanças que não alteram tamanho (ex.:
    // um vizinho trocou de lado): um retângulo por webview a cada 300 ms.
    const timer = window.setInterval(schedule, 300);
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      slotListeners.delete(onSlots);
      offDrag();
      window.removeEventListener("resize", schedule);
      window.clearInterval(timer);
    };
  }, [handlesKey]);

  return (
    <div className="ext-webview-layer" ref={layerRef}>
      {infos.map((info) => {
        const p = placements[info.handle] ?? HIDDEN;
        return (
          <div
            key={info.handle}
            className={`ext-webview-overlay${p.visible ? "" : " is-hidden"}`}
            data-webview-handle={info.handle}
            style={p.style}
            aria-hidden={p.visible ? undefined : true}
          >
            <ExtensionWebview info={info} visible={p.visible} />
          </div>
        );
      })}
    </div>
  );
}
