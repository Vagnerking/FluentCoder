/**
 * Global breakpoint store (issue #100, multi-sessão). Breakpoints são do
 * WORKSPACE, não de uma sessão: todas as sessões de debug vivas observam este
 * store e empurram `setBreakpoints` para o adaptador quando algo muda, e o
 * editor renderiza/edita daqui (gutter, condição, logpoint).
 *
 * Módulo folha puro (sem react/monaco/api) — testável com `node --test`.
 * Chaves: caminho ABSOLUTO do arquivo; linhas 1-based.
 */

/** Optional conditions on a breakpoint (all absent = a plain breakpoint). */
export interface BreakpointSpec {
  /** Break only when this expression is true. */
  condition?: string;
  /** Break after N hits (e.g. "5", ">3"). */
  hitCondition?: string;
  /** Logpoint: log this message instead of breaking (`{expr}` interpolated). */
  logMessage?: string;
}

/** A breakpoint as surfaced to the editor: line + its spec. */
export interface BreakpointView extends BreakpointSpec {
  line: number;
}

/** Notified with the path whose breakpoints changed. */
type BreakpointListener = (path: string) => void;

export class BreakpointStore {
  private files = new Map<string, Map<number, BreakpointSpec>>();
  private listeners = new Set<BreakpointListener>();

  subscribe = (listener: BreakpointListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Toggles a plain breakpoint on/off at `line` (removing drops any spec). */
  toggleBreakpoint(path: string, line: number): void {
    const map = this.files.get(path) ?? new Map<number, BreakpointSpec>();
    if (map.has(line)) map.delete(line);
    else map.set(line, {});
    this.commit(path, map);
  }

  /** Sets (or updates) a breakpoint's condition/hitCondition/logMessage. An
   *  explicit set always keeps the breakpoint on, even with an empty spec. */
  setBreakpointSpec(path: string, line: number, spec: BreakpointSpec): void {
    const map = this.files.get(path) ?? new Map<number, BreakpointSpec>();
    const clean: BreakpointSpec = {};
    if (spec.condition?.trim()) clean.condition = spec.condition.trim();
    if (spec.hitCondition?.trim()) clean.hitCondition = spec.hitCondition.trim();
    if (spec.logMessage?.trim()) clean.logMessage = spec.logMessage.trim();
    map.set(line, clean);
    this.commit(path, map);
  }

  /** The file's breakpoints, sorted by line (empty array when none). */
  breakpointsFor(path: string): BreakpointView[] {
    const map = this.files.get(path);
    if (!map) return [];
    return [...map.entries()]
      .map(([line, spec]) => ({ line, ...spec }))
      .sort((a, b) => a.line - b.line);
  }

  /** Every file that has at least one breakpoint. */
  paths(): string[] {
    return [...this.files.keys()];
  }

  /** Snapshot as a plain record (feeds each session's `DebugState.breakpoints`). */
  toRecord(): Record<string, BreakpointView[]> {
    return Object.fromEntries(this.paths().map((p) => [p, this.breakpointsFor(p)]));
  }

  private commit(path: string, map: Map<number, BreakpointSpec>): void {
    if (map.size === 0) this.files.delete(path);
    else this.files.set(path, map);
    for (const l of [...this.listeners]) l(path);
  }
}

/** App-wide singleton: one set of breakpoints shared by every debug session. */
export const breakpointStore = new BreakpointStore();
