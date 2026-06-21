import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { TerminalView } from "./TerminalView";
import { ProblemsPanel } from "./ProblemsPanel";
import { Codicon } from "../icons/codicons/Codicon";
import type { Problem } from "../types";

interface TerminalPanelProps {
  open: boolean;
  height: number;
  /** Panel width when docked to a side (right/left). */
  width?: number;
  /** Where the panel is docked relative to the editor. */
  pos?: "bottom" | "right" | "left";
  cwd: string | null;
  onClose: () => void;
  /** Begins dragging the panel to reposition it (from empty header area). */
  onDragStart?: (e: PointerEvent<HTMLElement>) => void;
  problems: Problem[];
  onOpenProblem: (problem: Problem) => void;
  /** Command line a "Run" requested, or null for a plain interactive shell. */
  runCommand?: string | null;
  /** Identifies the current run; changing it spawns a fresh terminal. */
  runNonce?: number;
  /** Working directory requested by "Abrir no Terminal", or null. */
  openCwd?: string | null;
  /** Bumps on each "Abrir no Terminal" to spawn a fresh terminal at `openCwd`. */
  openNonce?: number;
  /** Tab to focus (e.g. the status bar opening Problems), applied on nonce bump. */
  focusTab?: PanelTab;
  /** Bumps to (re)apply `focusTab`, even if it's the same tab as before. */
  focusNonce?: number;
}

export type PanelTab = "terminal" | "problems" | "output";

const DEFAULT_TAB_ORDER: PanelTab[] = ["problems", "output", "terminal"];

/** Reads the persisted tab order, validating it still holds exactly the known tabs. */
function readTabOrder(): PanelTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("ui.panelTabOrder") ?? "");
    if (
      Array.isArray(parsed) &&
      parsed.length === DEFAULT_TAB_ORDER.length &&
      DEFAULT_TAB_ORDER.every((t) => parsed.includes(t))
    ) {
      return parsed as PanelTab[];
    }
  } catch {
    /* missing or malformed — fall back */
  }
  return DEFAULT_TAB_ORDER;
}

/** Last path segment, used to name a terminal after its folder. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** A live terminal instance shown in the panel. Each maps to one backend PTY. */
interface TermInstance {
  id: string;
  title: string;
  cwd: string;
  command: string | null;
}

export function TerminalPanel({
  open,
  height,
  width = 360,
  pos = "bottom",
  cwd,
  onClose,
  onDragStart,
  problems,
  onOpenProblem,
  runCommand,
  runNonce = 0,
  openCwd = null,
  openNonce = 0,
  focusTab,
  focusNonce = 0,
}: TerminalPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("terminal");
  // Drag-reorderable tab order (VSCode-style), persisted across sessions. The drop
  // target tracks which side (before/after) so a tab can reach either end.
  const [tabOrder, setTabOrder] = useState<PanelTab[]>(readTabOrder);
  const dragTabRef = useRef<PanelTab | null>(null);
  const [dropTab, setDropTab] = useState<{ tab: PanelTab; after: boolean } | null>(null);

  // Drag-reorderable terminal list. Terminals are live sessions (not persisted
  // across app restarts), so this order is session-scoped by nature.
  const dragTermRef = useRef<string | null>(null);
  const [dropTerm, setDropTerm] = useState<{ id: string; after: boolean } | null>(null);

  // Multiple terminals: a list of live sessions + which one is shown. All stay
  // mounted (hidden via CSS) so switching tabs never kills a running shell.
  const [terminals, setTerminals] = useState<TermInstance[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const termCounter = useRef(0);
  // Whether we've already auto-created the first terminal this mount, so closing
  // every terminal by hand doesn't immediately respawn one.
  const seededRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem("ui.panelTabOrder", JSON.stringify(tabOrder));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [tabOrder]);

  /** Spawns a new terminal and focuses it (switches to the terminal tab). */
  const createTerminal = useCallback(
    (opts?: { cwd?: string | null; command?: string | null; title?: string }) => {
      const dir = opts?.cwd ?? cwd;
      if (!dir) return;
      termCounter.current += 1;
      const id = `term-${crypto.randomUUID()}`;
      const title = opts?.title ?? `Terminal ${termCounter.current}`;
      setTerminals((prev) => [
        ...prev,
        { id, title, cwd: dir, command: opts?.command ?? null },
      ]);
      setActiveTermId(id);
      setActiveTab("terminal");
    },
    [cwd]
  );

  /** Closes a terminal, moving focus to the last remaining one (or none). */
  const closeTerminal = useCallback((id: string) => {
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTermId((cur) =>
        cur === id ? (next.length ? next[next.length - 1].id : null) : cur
      );
      return next;
    });
  }, []);

  // "Run ▶" → a fresh terminal that runs the command.
  useEffect(() => {
    if (runNonce > 0 && runCommand) {
      createTerminal({ command: runCommand, title: "Run" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNonce]);

  // "Abrir no Terminal" → a fresh terminal at the requested folder.
  useEffect(() => {
    if (openNonce > 0 && openCwd) {
      createTerminal({ cwd: openCwd, title: baseName(openCwd) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNonce]);

  // Seed one terminal the first time the panel opens on the terminal tab with a
  // folder open. Not re-run after the user closes them all (seededRef guards it),
  // and not while the panel is hidden — so we don't spawn a shell nobody asked for.
  useEffect(() => {
    if (open && !seededRef.current && activeTab === "terminal" && cwd) {
      seededRef.current = true;
      createTerminal();
    }
  }, [open, activeTab, cwd, createTerminal]);

  // Focus a specific tab on request (e.g. the status bar opening Problems).
  useEffect(() => {
    if (focusNonce > 0 && focusTab) setActiveTab(focusTab);
  }, [focusNonce, focusTab]);

  /** Label for a panel tab (Problemas shows the diagnostic count). */
  function tabLabel(tab: PanelTab): string {
    if (tab === "problems") {
      return `Problemas${problems.length ? ` (${problems.length})` : ""}`;
    }
    return tab === "output" ? "Saída" : "Terminal";
  }

  /** Drops the dragged tab before/after `target`, reordering the bar. */
  function reorderTabs(target: PanelTab, after: boolean) {
    const from = dragTabRef.current;
    dragTabRef.current = null;
    setDropTab(null);
    if (!from || from === target) return;
    setTabOrder((prev) => {
      const next = prev.filter((t) => t !== from);
      const idx = next.indexOf(target) + (after ? 1 : 0);
      next.splice(idx, 0, from);
      return next;
    });
  }

  /** Drops the dragged terminal before/after `targetId`, reordering the list. */
  function reorderTerminals(targetId: string, after: boolean) {
    const from = dragTermRef.current;
    dragTermRef.current = null;
    setDropTerm(null);
    if (!from || from === targetId) return;
    setTerminals((prev) => {
      const moved = prev.find((t) => t.id === from);
      if (!moved) return prev;
      const next = prev.filter((t) => t.id !== from);
      const idx = next.findIndex((t) => t.id === targetId) + (after ? 1 : 0);
      next.splice(idx, 0, moved);
      return next;
    });
  }

  // Show the terminal list (right rail) whenever there's a terminal, so the user
  // can always see and switch between sessions (VSCode-style).
  const showTermList = terminals.length >= 1;

  return (
    // Stays mounted while hidden (display:none) so terminals keep running when
    // the panel is minimized — the shells only die on close or app exit.
    <div
      className={`terminal-panel panel-${pos}`}
      style={
        open
          ? pos === "right" || pos === "left"
            ? { width }
            : { height }
          : { display: "none" }
      }
    >
      <div
        className="terminal-header"
        onPointerDown={(e) => {
          // Drag-to-reposition starts only from empty header area — not the tabs
          // (which reorder) or the action buttons.
          if (
            onDragStart &&
            !(e.target as HTMLElement).closest(".terminal-tab, .terminal-actions")
          ) {
            onDragStart(e);
          }
        }}
      >
        <div className="terminal-tabs">
          {tabOrder.map((tab) => (
            <button
              key={tab}
              type="button"
              draggable
              className={`terminal-tab${activeTab === tab ? " active" : ""}${
                dropTab?.tab === tab
                  ? dropTab.after
                    ? " drop-after"
                    : " drop-before"
                  : ""
              }`}
              onClick={() => setActiveTab(tab)}
              aria-pressed={activeTab === tab}
              onDragStart={() => {
                dragTabRef.current = tab;
              }}
              onDragEnd={() => {
                dragTabRef.current = null;
                setDropTab(null);
              }}
              onDragOver={(e) => {
                if (!dragTabRef.current || dragTabRef.current === tab) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const after = e.clientX > rect.left + rect.width / 2;
                if (dropTab?.tab !== tab || dropTab.after !== after) {
                  setDropTab({ tab, after });
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                reorderTabs(tab, e.clientX > rect.left + rect.width / 2);
              }}
            >
              {tabLabel(tab)}
            </button>
          ))}
        </div>
        <div className="terminal-actions">
          {activeTab === "terminal" && (
            <>
              <button
                type="button"
                className="terminal-action"
                onClick={() => createTerminal()}
                disabled={!cwd}
                title="Novo terminal"
                aria-label="Novo terminal"
              >
                <Codicon name="add" size={16} />
              </button>
              {activeTermId && (
                <button
                  type="button"
                  className="terminal-action"
                  onClick={() => closeTerminal(activeTermId)}
                  title="Encerrar terminal"
                  aria-label="Encerrar terminal"
                >
                  <Codicon name="trash" size={16} />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="terminal-close"
            onClick={onClose}
            title="Fechar painel"
            aria-label="Fechar painel"
          >
            <Codicon name="close" size={16} />
          </button>
        </div>
      </div>
      <div className="terminal-body">
        <div
          className="terminal-pane"
          style={{ display: activeTab === "terminal" ? undefined : "none" }}
        >
          {terminals.length === 0 ? (
            <div className="panel-empty">
              {cwd
                ? "Nenhum terminal. Use + para criar um."
                : "Abra uma pasta para usar o terminal."}
            </div>
          ) : (
            <div className="terminal-split">
              <div className="terminal-views">
                {terminals.map((t) => (
                  <div
                    key={t.id}
                    className={`terminal-view-host${
                      t.id === activeTermId ? "" : " inactive"
                    }`}
                  >
                    <TerminalView id={t.id} cwd={t.cwd} command={t.command} />
                  </div>
                ))}
              </div>
              {showTermList && (
                <div className="terminal-list" role="tablist" aria-label="Terminais">
                  {terminals.map((t) => (
                    <div
                      key={t.id}
                      role="tab"
                      aria-selected={t.id === activeTermId}
                      draggable
                      className={`terminal-list-item${
                        t.id === activeTermId ? " active" : ""
                      }${
                        dropTerm?.id === t.id
                          ? dropTerm.after
                            ? " drop-after"
                            : " drop-before"
                          : ""
                      }`}
                      onClick={() => setActiveTermId(t.id)}
                      title={t.title}
                      onDragStart={(e) => {
                        dragTermRef.current = t.id;
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        dragTermRef.current = null;
                        setDropTerm(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragTermRef.current || dragTermRef.current === t.id)
                          return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        if (dropTerm?.id !== t.id || dropTerm.after !== after) {
                          setDropTerm({ id: t.id, after });
                        }
                      }}
                      onDragLeave={() => {
                        if (dropTerm?.id === t.id) setDropTerm(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        reorderTerminals(
                          t.id,
                          e.clientY > rect.top + rect.height / 2
                        );
                      }}
                    >
                      <Codicon
                        name="terminal"
                        size={14}
                        className="terminal-list-icon"
                      />
                      <span className="terminal-list-title">{t.title}</span>
                      <button
                        type="button"
                        className="terminal-list-close"
                        title="Encerrar terminal"
                        aria-label="Encerrar terminal"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminal(t.id);
                        }}
                      >
                        <Codicon name="close" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {activeTab === "problems" && (
          <ProblemsPanel problems={problems} onOpenProblem={onOpenProblem} />
        )}
        {activeTab === "output" && (
          <div className="panel-empty">Sem saída.</div>
        )}
      </div>
    </div>
  );
}
