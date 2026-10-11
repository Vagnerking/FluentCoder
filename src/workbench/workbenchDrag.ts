/**
 * Estado compartilhado de "arraste ativo" do workbench (abas, painéis, activity
 * bar, alças de redimensionamento e arrastes HTML5 nativos).
 *
 * Por que existe: o WebKitGTK (motor do Tauri no Linux) ignora `user-select`
 * sem prefixo, então arrastar uma aba/painel selecionava texto e itens do
 * caminho. Enquanto houver uma sessão aberta, a raiz recebe
 * `workbench-dragging` (+ `workbench-dragging-<kind>`), que força
 * `-webkit-user-select: none` na superfície, desliga `pointer-events` de
 * iframes (webviews de extensão engoliriam os eventos) e, em arrastes por
 * ponteiro, blinda o Monaco. `selectstart` é bloqueado durante a sessão.
 *
 * O que NÃO faz: limpar a seleção existente. A seleção de texto do Monaco é do
 * modelo (não do DOM) e uma seleção DOM pré-existente do usuário permanece; só
 * se impede que o arraste crie uma nova.
 *
 * A lógica fica numa fábrica com ambiente injetável para ser testável em Node.
 */

export type WorkbenchDragKind = "tab" | "panel" | "activity" | "resize" | "native" | "view";

/** Classe na raiz enquanto qualquer sessão está ativa. */
export const DRAG_ROOT_CLASS = "workbench-dragging";
/** Classe extra para arrastes guiados por ponteiro (não HTML5): blinda o Monaco. */
export const DRAG_POINTER_CLASS = "workbench-dragging-pointer";

export interface DragEnv {
  classList: { add(...t: string[]): void; remove(...t: string[]): void };
  setRootStyle(name: string, value: string | null): void;
  addEventListener(type: string, fn: (e: Event) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture: boolean): void;
}

export interface DragSessionOptions {
  /** Cursor forçado em toda a superfície durante a sessão (ex.: `col-resize`). */
  cursor?: string;
  /** Escape cancela a sessão (padrão: true). Em HTML5 DnD o próprio browser
   *  trata Escape (dispara `dragend`), então passe false. */
  cancelOnEscape?: boolean;
  /** Perder o foco da janela cancela (padrão: true). Não use em arrastes HTML5
   *  que podem sair da janela (destacar aba para outra janela). */
  cancelOnBlur?: boolean;
  /** Arraste guiado por ponteiro (blinda o Monaco). Padrão: kind !== tab/native. */
  pointer?: boolean;
  /** Chamado quando a sessão é cancelada (Escape/blur/cancel()), nunca no end(). */
  onCancel?: () => void;
}

export interface DragSession {
  readonly kind: WorkbenchDragKind;
  /** Encerra normalmente (drop/pointerup). Idempotente. */
  end(): void;
  /** Encerra como cancelada (chama onCancel). Idempotente. */
  cancel(): void;
  readonly active: boolean;
}

interface Entry {
  kind: WorkbenchDragKind;
  pointer: boolean;
  cursor?: string;
}

export function createDragRegistry(env: DragEnv | null) {
  const sessions = new Map<number, Entry>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let applied: string[] = [];

  const preventSelect = (e: Event) => e.preventDefault();

  const sync = () => {
    if (!env) return;
    const next = new Set<string>();
    let cursor: string | undefined;
    for (const s of sessions.values()) {
      next.add(DRAG_ROOT_CLASS);
      next.add(`${DRAG_ROOT_CLASS}-${s.kind}`);
      if (s.pointer) next.add(DRAG_POINTER_CLASS);
      if (s.cursor) cursor = s.cursor;
    }
    const removed = applied.filter((c) => !next.has(c));
    if (removed.length) env.classList.remove(...removed);
    const added = [...next].filter((c) => !applied.includes(c));
    if (added.length) env.classList.add(...added);
    env.setRootStyle("--workbench-drag-cursor", cursor ?? null);
    if (applied.length === 0 && next.size > 0) {
      env.addEventListener("selectstart", preventSelect, true);
    } else if (applied.length > 0 && next.size === 0) {
      env.removeEventListener("selectstart", preventSelect, true);
    }
    applied = [...next];
    for (const l of listeners) l();
  };

  function begin(kind: WorkbenchDragKind, opts: DragSessionOptions = {}): DragSession {
    const id = ++seq;
    const pointer = opts.pointer ?? (kind !== "tab" && kind !== "native");
    sessions.set(id, { kind, pointer, cursor: opts.cursor });
    let done = false;

    const onKey = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    const onBlur = () => finish(true);
    const cancelOnEscape = opts.cancelOnEscape ?? true;
    const cancelOnBlur = opts.cancelOnBlur ?? true;
    if (env && cancelOnEscape) env.addEventListener("keydown", onKey, true);
    if (env && cancelOnBlur) env.addEventListener("blur", onBlur, false);

    function finish(cancelled: boolean) {
      if (done) return;
      done = true;
      sessions.delete(id);
      if (env && cancelOnEscape) env.removeEventListener("keydown", onKey, true);
      if (env && cancelOnBlur) env.removeEventListener("blur", onBlur, false);
      sync();
      if (cancelled) opts.onCancel?.();
    }

    sync();
    return {
      kind,
      end: () => finish(false),
      cancel: () => finish(true),
      get active() {
        return !done;
      },
    };
  }

  return {
    begin,
    /** Algum arraste em andamento (opcionalmente de um tipo). */
    isActive(kind?: WorkbenchDragKind) {
      if (!kind) return sessions.size > 0;
      for (const s of sessions.values()) if (s.kind === kind) return true;
      return false;
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /** Encerra tudo (desmontagem / segurança). */
    reset() {
      sessions.clear();
      sync();
    },
  };
}

export type DragRegistry = ReturnType<typeof createDragRegistry>;

function browserEnv(): DragEnv | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  const root = document.documentElement;
  return {
    classList: root.classList,
    setRootStyle: (name, value) =>
      value == null ? root.style.removeProperty(name) : root.style.setProperty(name, value),
    addEventListener: (type, fn, capture) =>
      (type === "blur" ? window : document).addEventListener(type, fn, capture),
    removeEventListener: (type, fn, capture) =>
      (type === "blur" ? window : document).removeEventListener(type, fn, capture),
  };
}

/** Registro único da janela. */
export const workbenchDrag: DragRegistry = createDragRegistry(browserEnv());

export interface PointerDragOptions extends Omit<DragSessionOptions, "onCancel"> {
  kind?: WorkbenchDragKind;
  onMove: (e: PointerEvent) => void;
  /** `committed=false` quando cancelado (Escape, blur, pointercancel). */
  onEnd?: (committed: boolean) => void;
  /** Captura o ponteiro no elemento de origem (alças de redimensionamento). */
  captureTarget?: Element | null;
  pointerId?: number;
}

/**
 * Arraste por ponteiro com limpeza completa: pointerup encerra; pointercancel,
 * Escape, blur e perda de captura cancelam. Retorna a sessão (para desmontagem).
 */
export function startPointerDrag(opts: PointerDragOptions, registry: DragRegistry = workbenchDrag): DragSession {
  const target = opts.captureTarget ?? null;
  if (target && opts.pointerId != null) {
    try {
      target.setPointerCapture(opts.pointerId);
    } catch {
      /* ponteiro já liberado */
    }
  }
  const onMove = (e: PointerEvent) => opts.onMove(e);
  const onUp = () => {
    detach();
    session.end();
    opts.onEnd?.(true);
  };
  const onCancelEvt = () => session.cancel();
  const detach = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancelEvt);
    target?.removeEventListener("lostpointercapture", onCancelEvt);
  };
  const session = registry.begin(opts.kind ?? "resize", {
    cursor: opts.cursor,
    cancelOnBlur: opts.cancelOnBlur,
    cancelOnEscape: opts.cancelOnEscape,
    pointer: opts.pointer,
    onCancel: () => {
      detach();
      opts.onEnd?.(false);
    },
  });
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancelEvt);
  // A captura é solta logo após o pointerup; só conta como cancelamento antes.
  target?.addEventListener("lostpointercapture", onCancelEvt);
  return session;
}

/** Alvo de arraste HTML5 que não deve virar sessão (texto em campos/Monaco). */
function isTextDragSource(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
  if (!el) return false;
  return !!el.closest("input, textarea, [contenteditable=''], [contenteditable='true'], .monaco-editor");
}

/**
 * Guarda global para arrastes HTML5 (Explorer, abas, Git…): abre uma sessão
 * `native` no dragstart e fecha no dragend/drop — ou no primeiro movimento sem
 * botão pressionado, caso a origem tenha sido desmontada antes do dragend.
 * Retorna a função de desinstalação.
 */
export function installNativeDragGuard(registry: DragRegistry = workbenchDrag): () => void {
  if (typeof document === "undefined") return () => {};
  let session: DragSession | null = null;
  const end = () => {
    session?.end();
    session = null;
  };
  const onStart = (e: DragEvent) => {
    if (isTextDragSource(e.target)) return;
    end();
    session = registry.begin("native", { cancelOnBlur: false, cancelOnEscape: false });
  };
  const onMove = (e: MouseEvent) => {
    if (session && e.buttons === 0) end();
  };
  document.addEventListener("dragstart", onStart, true);
  document.addEventListener("dragend", end, true);
  document.addEventListener("drop", end, true);
  document.addEventListener("pointermove", onMove, true);
  return () => {
    end();
    document.removeEventListener("dragstart", onStart, true);
    document.removeEventListener("dragend", end, true);
    document.removeEventListener("drop", end, true);
    document.removeEventListener("pointermove", onMove, true);
  };
}

/**
 * Preview de arraste dedicado: um "chip" fora da tela clonado só com ícone e
 * nome, usado em `setDragImage` no lugar do elemento vivo (que, no WebKitGTK,
 * levava junto seleção/realces). Removido no próximo frame.
 */
export function setDragPreview(e: DragEvent | { dataTransfer: DataTransfer | null; clientX: number; clientY: number; currentTarget: EventTarget | null }, label: string, iconSource?: Element | null): void {
  const dt = e.dataTransfer;
  if (!dt || typeof document === "undefined") return;
  const chip = document.createElement("div");
  chip.className = "workbench-drag-preview";
  if (iconSource) {
    const icon = iconSource.cloneNode(true) as Element;
    chip.appendChild(icon);
  }
  const text = document.createElement("span");
  text.textContent = label;
  chip.appendChild(text);
  document.body.appendChild(chip);
  const src = e.currentTarget instanceof Element ? e.currentTarget.getBoundingClientRect() : null;
  const offX = src ? Math.max(0, Math.min(e.clientX - src.left, chip.offsetWidth)) : 12;
  const offY = src ? Math.max(0, Math.min(e.clientY - src.top, chip.offsetHeight)) : 12;
  try {
    dt.setDragImage(chip, offX, offY);
  } catch {
    /* sem suporte */
  }
  requestAnimationFrame(() => chip.remove());
}
