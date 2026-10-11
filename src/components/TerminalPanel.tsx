import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalView } from "./TerminalView";
import { Codicon } from "../icons/codicons/Codicon";
import { IconButton } from "./ui/IconButton";
import { ViewToolbar } from "../workbench/WorkbenchViews";
import type { TermSpawnOptions } from "../api";
import { ptyClosed, ptyReady, subscribeExtTerminals } from "../extensions/terminalBridge";
import { listen } from "@tauri-apps/api/event";
import { defaultTerminalTarget } from "../git/activeRepository";

interface TerminalsViewProps {
  /** A view "Terminal" está visível (ativa numa região aberta). */
  visible: boolean;
  /** Pede para revelar a view (criar/mostrar um terminal a foca, onde estiver). */
  onReveal: () => void;
  cwd: string | null;
  /** Command line a "Run" requested, or null for a plain interactive shell. */
  runCommand?: string | null;
  /** Working directory for the requested run command. */
  runCwd?: string | null;
  /** SSH connection for the requested run command, when it belongs to an SSH root. */
  runConnId?: string | null;
  /** Identifies the current run; changing it spawns a fresh terminal. */
  runNonce?: number;
  /** Working directory requested by "Abrir no Terminal", or null. */
  openCwd?: string | null;
  /** SSH connection for the requested terminal, when opening from an SSH root. */
  openConnId?: string | null;
  /** Bumps on each "Abrir no Terminal" to spawn a fresh terminal at `openCwd`. */
  openNonce?: number;
}

/** Abas do painel inferior antes do registro de views (ids estáveis das views). */
export type PanelTab = "terminal" | "problems" | "output";

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
  connId?: string;
  command: string | null;
  /** Terminal criado por uma extensão VS Code (shell/env próprios). */
  spawn?: TermSpawnOptions;
  /** Processo saiu (o terminal fica aberto mostrando a saída, como no VS Code). */
  exited?: boolean;
  /** PTY criado pelo backend (terminal/* de um agente ACP): só se conecta a ele. */
  attach?: boolean;
  /** Pseudoterminal de extensão (sem PTY; o host escreve/lê — pseudoTerminal.ts). */
  pseudo?: boolean;
}

/**
 * View "Terminal" do registro (padrão: painel). Fica SEMPRE montada (retém o
 * conteúdo quando oculta) para os shells continuarem rodando com o painel
 * fechado ou a view movida para outra região — só morrem ao fechar a sessão
 * ou o app. As ações (+ / encerrar) vão para o cabeçalho da região.
 */
export function TerminalsView({
  visible,
  onReveal,
  cwd,
  runCommand,
  runCwd = null,
  runConnId = null,
  runNonce = 0,
  openCwd = null,
  openConnId = null,
  openNonce = 0,
}: TerminalsViewProps) {
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;

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

  /** Spawns a new terminal and focuses it (switches to the terminal tab). */
  const createTerminal = useCallback(
    (opts?: {
      cwd?: string | null;
      connId?: string | null;
      command?: string | null;
      title?: string;
    }) => {
      // "+"/primeiro terminal: abre no repositório ativo (multi-repo).
      const fallback = opts?.cwd ? null : defaultTerminalTarget(cwd);
      const dir = opts?.cwd ?? fallback?.cwd ?? cwd;
      if (!dir) return;
      termCounter.current += 1;
      const id = `term-${crypto.randomUUID()}`;
      const title = opts?.title ?? `Terminal ${termCounter.current}`;
      setTerminals((prev) => [
        ...prev,
        {
          id,
          title,
          cwd: dir,
          connId: (opts?.cwd ? opts.connId : fallback?.connId) ?? undefined,
          command: opts?.command ?? null,
        },
      ]);
      setActiveTermId(id);
      revealRef.current();
    },
    [cwd]
  );

  /** Closes a terminal, moving focus to the last remaining one (or none). */
  const closeTerminal = useCallback((id: string) => {
    // Terminal de extensão: o host recebe onDidCloseTerminal (no-op nos demais).
    ptyClosed(id, null);
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTermId((cur) =>
        cur === id ? (next.length ? next[next.length - 1].id : null) : cur
      );
      return next;
    });
  }, []);

  // Terminais pedidos por extensões VS Code (window.createTerminal/show/dispose).
  useEffect(
    () =>
      subscribeExtTerminals((a) => {
        if (a.type === "create") {
          const { spec } = a;
          const dir = spec.cwd || cwd;
          if (!dir) return;
          setTerminals((prev) =>
            prev.some((t) => t.id === spec.ptyId)
              ? prev
              : [
                  ...prev,
                  {
                    id: spec.ptyId,
                    title: spec.name,
                    cwd: dir,
                    command: null,
                    ...(spec.pseudo
                      ? { pseudo: true }
                      : { spawn: { shellPath: spec.shellPath, shellArgs: spec.shellArgs, env: spec.env, strictEnv: spec.strictEnv, shellIntegration: spec.shellIntegration } }),
                  },
                ]
          );
        } else if (a.type === "show") {
          setActiveTermId(a.ptyId);
          revealRef.current();
        } else if (a.type === "dispose") {
          closeTerminal(a.ptyId);
        } else if (a.type === "rename") {
          setTerminals((prev) => prev.map((t) => (t.id === a.ptyId ? { ...t, title: a.name } : t)));
        } else if (a.type === "exited") {
          setTerminals((prev) => prev.map((t) => (t.id === a.ptyId ? { ...t, exited: true } : t)));
        }
      }),
    [cwd, closeTerminal]
  );

  // Terminais dos agentes ACP (`terminal/create`): o PTY já existe no backend
  // (src-tauri/src/agents/acp_client.rs); a aba só se conecta a ele, sem roubar
  // o foco, e continua mostrando a saída depois do `release`.
  useEffect(() => {
    const un = listen<{ id: string; name: string; cwd: string }>("acp-terminal://created", (e) => {
      const { id, name } = e.payload;
      setTerminals((prev) =>
        prev.some((t) => t.id === id)
          ? prev
          : [...prev, { id, title: `Agente: ${name}`, cwd: e.payload.cwd || cwd || "", command: null, attach: true }]
      );
      setActiveTermId((cur) => cur ?? id);
    });
    return () => void un.then((f) => f());
  }, [cwd]);

  // "Run ▶" → a fresh terminal that runs the command.
  useEffect(() => {
    if (runNonce > 0 && runCommand) {
      createTerminal({
        cwd: runCwd,
        connId: runConnId,
        command: runCommand,
        title: "Run",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNonce]);

  // "Abrir no Terminal" → a fresh terminal at the requested folder.
  useEffect(() => {
    if (openNonce > 0 && openCwd) {
      createTerminal({ cwd: openCwd, connId: openConnId, title: baseName(openCwd) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNonce]);

  // Seed one terminal the first time the panel opens on the terminal tab with a
  // folder open. Not re-run after the user closes them all (seededRef guards it),
  // and not while the panel is hidden — so we don't spawn a shell nobody asked for.
  useEffect(() => {
    if (visible && !seededRef.current && cwd) {
      seededRef.current = true;
      createTerminal();
    }
  }, [visible, cwd, createTerminal]);

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
    <div className="terminal-panel-view">
      <ViewToolbar>
        <IconButton
          icon="add"
          size="sm"
          label="Novo terminal"
          tooltipPlacement="bottom"
          onClick={() => createTerminal()}
          disabled={!cwd}
        />
        {activeTermId && (
          <IconButton
            icon="trash"
            size="sm"
            label="Encerrar terminal"
            tooltipPlacement="bottom"
            onClick={() => closeTerminal(activeTermId)}
          />
        )}
      </ViewToolbar>
      <div className="terminal-body">
        <div className="terminal-pane">
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
                    <TerminalView
                      id={t.id}
                      cwd={t.cwd}
                      connId={t.connId}
                      command={t.command}
                      spawn={t.spawn}
                      attach={t.attach}
                      pseudo={t.pseudo}
                      onReady={t.spawn || t.pseudo ? (pid) => ptyReady(t.id, pid) : undefined}
                      onExit={
                        t.spawn || t.attach || t.pseudo
                          ? (code) => {
                              ptyClosed(t.id, code);
                              setTerminals((prev) => prev.map((x) => (x.id === t.id ? { ...x, exited: true } : x)));
                            }
                          : undefined
                      }
                    />
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
                      tabIndex={0}
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
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveTermId(t.id);
                        }
                      }}
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
                      <span className="terminal-list-title">
                        {t.title}
                        {t.exited ? " (encerrado)" : ""}
                      </span>
                      <IconButton
                        icon="close"
                        size="sm"
                        label="Encerrar terminal"
                        className="terminal-list-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTerminal(t.id);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
