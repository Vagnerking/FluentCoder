import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Input } from "./ui/Input";
import {
  dotnetBuild,
  dotnetClean,
  dotnetRebuild,
  dotnetRestore,
  dotnetTestDebug,
  dotnetTestList,
  dotnetTestRun,
  listProjectFiles,
  runConfigsDetect,
  runConfigsLoad,
  runConfigsSave,
  type DotnetActionResult,
  type DotnetProcess,
  type DotnetTestResult,
} from "../api";
import type { RunConfig } from "../types";
import {
  debugSession,
  type VariableView,
  type WatchView,
} from "../dap/debugSession";
import { loadLaunchProfiles } from "../dap/loadLaunchProfiles";
import type { LaunchProfile } from "../dap/launchSettings";
import { groupTests } from "../testing/testTree";
import {
  applyCoverageDecorations,
  clearCoverageDecorations,
} from "../testing/coverageDecorations";
import { Checkbox, IconButton, SectionHeader, Select, ViewPaneContainer, type ViewPaneDescriptor } from "./ui";

/** Loads the workspace's `.csproj` paths once per root (shared by the .NET sections). */
function useCsprojs(rootPath: string, connId?: string): string[] {
  const [csprojs, setCsprojs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listProjectFiles(rootPath, connId)
      .then((files) => {
        if (cancelled) return;
        setCsprojs(
          files.filter((f) => f.name.toLowerCase().endsWith(".csproj")).map((f) => f.path)
        );
      })
      .catch(() => setCsprojs([]));
    return () => {
      cancelled = true;
    };
  }, [connId, rootPath]);
  return csprojs;
}

/** A test to run/debug, requested from a CodeLens click. A fresh object on every
 *  request so re-clicking the same test re-triggers it. */
export interface PendingTest {
  csprojPath: string;
  fullyQualifiedName: string;
  /** "run" executes; "debug" launches under the debugger. */
  mode: "run" | "debug";
}

export interface RunWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
  connId?: string;
  status?: "connected" | "connecting" | "error";
}

interface RunPanelProps {
  /** Open folder; configs live in `<root>/.project/run.json`. Null = none. */
  rootPath: string | null;
  /** Roots in a Fluent workspace. SSH roots are runnable when connected. */
  workspaceRoots?: RunWorkspaceRoot[];
  /** Asks the app to run `command` in the integrated terminal. */
  onRun: (command: string, cwd: string, connId?: string) => void;
  /** Latest test-run request from a CodeLens (App-level listener), or null. */
  pendingTest?: PendingTest | null;
}

/** Empty draft used by the "new configuration" form. */
const EMPTY_DRAFT: RunConfig = { name: "", command: "", cwd: "" };

/**
 * The "Executar e Depurar" view. Lists saved run configurations (persisted to
 * `.project/run.json`), each runnable with ▶ in the integrated terminal, plus
 * one-click suggestions auto-detected from the project (npm scripts, cargo).
 *
 * Debugging (breakpoints/step via DAP) is a planned next phase; for now this
 * covers the "Executar" half end-to-end.
 */
export function RunPanel({ rootPath, workspaceRoots = [], onRun, pendingTest }: RunPanelProps) {
  const targets = useMemo(
    () =>
      workspaceRoots.length > 0
        ? workspaceRoots.flatMap((root) => {
            if (root.provider === "ssh") {
              return root.status === "connected" && root.connId
                ? [{ ...root, connId: root.connId }]
                : [];
            }
            return [root];
          })
        : rootPath
          ? [
              {
                id: rootPath,
                name: rootPath.split(/[\\/]/).pop() || rootPath,
                path: rootPath,
                provider: "local" as const,
              },
            ]
          : [],
    [rootPath, workspaceRoots]
  );
  const unavailableSshRoots = workspaceRoots.filter(
    (root) => root.provider === "ssh" && root.status !== "connected"
  );
  // Formulário "nova configuração" aberto por root (a ação vive no cabeçalho do pane).
  const [draftFor, setDraftFor] = useState<ReadonlySet<string>>(() => new Set());
  const toggleDraft = useCallback((id: string, open?: boolean) => {
    setDraftFor((cur) => {
      const next = new Set(cur);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  if (targets.length === 0) {
    return (
      <div className="run-panel">
        <div className="explorer-header">
          <span className="explorer-title">EXECUTAR E DEPURAR</span>
        </div>
        <div className="panel-empty">
          {workspaceRoots.length > 0
            ? "Nenhuma pasta executável conectada neste workspace."
            : "Abra uma pasta para configurar a execução."}
        </div>
        {unavailableSshRoots.map((root) => (
          <div key={root.id} className="run-unavailable-root">
            {root.name} · SSH {root.status === "connecting" ? "conectando" : "indisponível"}
          </div>
        ))}
      </div>
    );
  }

  const panes: ViewPaneDescriptor[] = targets.map((target) => ({
    id: `root:${target.id}`,
    title: target.name,
    badge: target.provider === "ssh" ? "SSH" : "LOCAL",
    badgeLabel: target.provider === "ssh" ? "Pasta SSH" : "Pasta local",
    minBodySize: 72,
    actions: [
      {
        id: "new-config",
        icon: "add",
        label: draftFor.has(target.id) ? "Fechar nova configuração" : "Nova configuração",
        pressed: draftFor.has(target.id),
        run: () => toggleDraft(target.id),
      },
    ],
    children: (
      <RunRootSection
        target={target}
        draftOpen={draftFor.has(target.id)}
        onDraftClosed={() => toggleDraft(target.id, false)}
        onRun={onRun}
        pendingTest={pendingTestForRoot(pendingTest ?? null, target)}
      />
    ),
  }));
  if (unavailableSshRoots.length > 0) {
    panes.push({
      id: "ssh-unavailable",
      title: "SSH indisponível",
      badge: unavailableSshRoots.length,
      badgeLabel: `${unavailableSshRoots.length} pastas SSH indisponíveis`,
      minBodySize: 36,
      defaultWeight: 0.35,
      children: unavailableSshRoots.map((root) => (
        <div key={root.id} className="run-unavailable-root">
          {root.name} · {root.status === "connecting" ? "conectando" : "desconectado"}
        </div>
      )),
    });
  }

  return (
    <div className="run-panel">
      <div className="explorer-header run-header">
        <span className="explorer-title">EXECUTAR E DEPURAR</span>
      </div>
      <ViewPaneContainer id="run" panes={panes} ariaLabel="Pastas de execução" />
    </div>
  );
}

/**
 * A CodeLens test request belongs to the local root that contains its `.csproj`.
 * Single-root (or unmatched) requests fall back to the only local root so the
 * classic one-folder flow keeps working exactly as before.
 */
function pendingTestForRoot(
  pending: PendingTest | null,
  target: RunWorkspaceRoot
): PendingTest | null {
  if (!pending || target.connId) return null;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const root = norm(target.path);
  const csproj = norm(pending.csprojPath);
  return csproj === root || csproj.startsWith(`${root}/`) ? pending : null;
}

function RunRootSection({
  target,
  draftOpen,
  onDraftClosed,
  onRun,
  pendingTest,
}: {
  target: RunWorkspaceRoot;
  draftOpen: boolean;
  onDraftClosed: () => void;
  onRun: (command: string, cwd: string, connId?: string) => void;
  pendingTest: PendingTest | null;
}) {
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [suggestions, setSuggestions] = useState<RunConfig[]>([]);
  const [draft, setDraftState] = useState<RunConfig | null>(null);
  useEffect(() => setDraftState(draftOpen ? { ...EMPTY_DRAFT } : null), [draftOpen]);
  const setDraft = (next: RunConfig | null) => {
    setDraftState(next);
    if (!next) onDraftClosed();
  };
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [saved, detected] = await Promise.all([
        runConfigsLoad(target.path, target.connId),
        runConfigsDetect(target.path, target.connId),
      ]);
      setConfigs(saved);
      // Hide suggestions that already exist (by command) among saved configs.
      const savedCmds = new Set(saved.map((c) => c.command));
      setSuggestions(detected.filter((d) => !savedCmds.has(d.command)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [target.connId, target.path]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function persist(next: RunConfig[]) {
    try {
      await runConfigsSave(target.path, next, target.connId);
      await reload();
    } catch (err) {
      setError(String(err));
    }
  }

  function addConfig(cfg: RunConfig) {
    persist([...configs, cfg]);
  }

  function removeConfig(index: number) {
    persist(configs.filter((_, i) => i !== index));
  }

  function saveDraft() {
    if (!draft || !draft.name.trim() || !draft.command.trim()) return;
    addConfig({
      name: draft.name.trim(),
      command: draft.command.trim(),
      cwd: draft.cwd.trim(),
    });
    setDraft(null);
  }

  return (
    <div className="run-root-section">

      {error && <div className="git-error">{error}</div>}

      {draft && (
        <div className="run-draft">
          <Input
            size="sm"
            aria-label="Nome da configuração"
            placeholder="Nome (ex.: dev)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Input
            size="sm"
            aria-label="Comando"
            placeholder="Comando (ex.: npm run dev)"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <Input
            size="sm"
            aria-label="Diretório de trabalho"
            placeholder="Diretório (opcional, relativo à raiz)"
            value={draft.cwd}
            onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
          />
          <div className="run-draft-actions">
            <button
              className="git-commit-btn"
              disabled={!draft.name.trim() || !draft.command.trim()}
              onClick={saveDraft}
            >
              Salvar
            </button>
            <button className="git-link-btn" onClick={() => setDraft(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="run-root-body">
        {!target.connId && <DebugSection rootPath={target.path} />}
        {!target.connId && <TestsSection rootPath={target.path} pendingTest={pendingTest} />}
        {!target.connId && <ProjectActionsSection rootPath={target.path} />}

        <div className="run-group">
          <SectionHeader level={2} title="Configurações" badge={configs.length} />
          {configs.length === 0 ? (
            <div className="panel-empty">Nenhuma configuração salva.</div>
          ) : (
            configs.map((c, i) => (
              <div key={`${c.name}-${i}`} className="run-row" title={c.command}>
                <IconButton
                  icon="run"
                  size="sm"
                  label={`Executar: ${c.command}`}
                  className="run-play"
                  onClick={() => onRun(buildCommand(c), target.path, target.connId)}
                />
                <div className="run-info">
                  <span className="run-name">{c.name}</span>
                  <span className="run-cmd">{c.command}</span>
                </div>
                <IconButton
                  icon="close"
                  size="sm"
                  label="Remover"
                  className="run-remove"
                  onClick={() => removeConfig(i)}
                />
              </div>
            ))
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="run-group">
            <SectionHeader level={2} title="Detectadas no projeto" badge={suggestions.length} />
            {suggestions.map((s, i) => (
              <div key={`sug-${i}`} className="run-row" title={s.command}>
                <IconButton
                  icon="run"
                  size="sm"
                  label={`Executar: ${s.command}`}
                  className="run-play"
                  onClick={() => onRun(buildCommand(s), target.path, target.connId)}
                />
                <div className="run-info">
                  <span className="run-name">{s.name}</span>
                  <span className="run-cmd">{s.command}</span>
                </div>
                <IconButton
                  icon="add"
                  size="sm"
                  label="Adicionar às configurações"
                  onClick={() => addConfig(s)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Builds the shell line to run, honoring an optional relative cwd. */
function buildCommand(cfg: RunConfig): string {
  if (cfg.cwd.trim()) {
    // PowerShell: cd into the subdir, then run.
    return `cd '${cfg.cwd.trim()}'; ${cfg.command}`;
  }
  return cfg.command;
}

/**
 * .NET debugger section (roadmap csharp-ide-parity, Fase B): pick a `.csproj`
 * and launch it under netcoredbg, or attach to a running `dotnet` process.
 * While stopped, shows the call stack (click = reveal) and the top frame's
 * variables; breakpoints are toggled in the editor gutter (EditorPane).
 */
function DebugSection({ rootPath }: { rootPath: string }) {
  const state = useSyncExternalStore(debugSession.subscribe, debugSession.getState);
  const csprojs = useCsprojs(rootPath);
  const [selected, setSelected] = useState<string>("");
  const [procs, setProcs] = useState<DotnetProcess[] | null>(null);
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [profileName, setProfileName] = useState<string>("");

  useEffect(() => {
    setSelected((cur) => cur || csprojs[0] || "");
  }, [csprojs]);

  // Load launchSettings.json profiles whenever the selected project changes.
  useEffect(() => {
    if (!selected) {
      setProfiles([]);
      return;
    }
    let cancelled = false;
    void loadLaunchProfiles(selected).then((p) => {
      if (cancelled) return;
      setProfiles(p);
      setProfileName(p[0]?.name ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const busy = state.status === "starting";
  const active = state.status === "running" || state.status === "stopped";

  // Nothing to debug in this workspace — keep the panel clean.
  if (csprojs.length === 0 && !active) return null;

  const launch = () => {
    const cwd = selected.replace(/[\\/][^\\/]+$/, "");
    const profile = profiles.find((p) => p.name === profileName);
    void debugSession.launchProject(selected, cwd, profile);
  };

  return (
    <div className="run-group debug-section">
      <SectionHeader
        level={2}
        title="Depurar (.NET)"
        meta={
          <span className={`debug-status debug-status-${state.status}`}>
            {state.status === "idle" && "pronto"}
            {state.status === "starting" && "iniciando…"}
            {state.status === "running" && "executando"}
            {state.status === "stopped" && "pausado"}
            {state.status === "error" && "erro"}
          </span>
        }
      />

      {!active && (
        <div className="debug-launcher">
          <Select
            ariaLabel="Projeto a depurar"
            value={selected}
            onChange={setSelected}
            disabled={busy}
            options={csprojs.map((p) => ({
              value: p,
              label: p.split(/[\\/]/).pop() ?? p,
            }))}
          />
          {profiles.length > 0 && (
            <Select
              ariaLabel="Perfil de inicialização"
              value={profileName}
              onChange={setProfileName}
              disabled={busy}
              title="Perfil do launchSettings.json (env, args, URL)"
              options={profiles.map((p) => ({ value: p.name, label: p.name }))}
            />
          )}
          <div className="run-draft-actions">
            <button
              className="git-commit-btn"
              disabled={!selected || busy}
              title="Compila e inicia sob o depurador"
              onClick={launch}
            >
              ▶ Iniciar Depuração
            </button>
            <button
              className="git-link-btn"
              disabled={busy}
              title="Anexar a um processo dotnet em execução"
              onClick={() => {
                void debugSession.listProcesses().then(setProcs);
              }}
            >
              Anexar…
            </button>
          </div>
          {procs && (
            <div className="debug-attach-list">
              {procs.length === 0 && <div className="panel-empty">Nenhum processo dotnet.</div>}
              {procs.map((p) => (
                <button
                  key={p.pid}
                  className="debug-frame-row"
                  onClick={() => {
                    setProcs(null);
                    void debugSession.attach(p.pid);
                  }}
                >
                  {p.name} · PID {p.pid}
                </button>
              ))}
            </div>
          )}
          {state.status === "error" && state.error && (
            <div className="git-error">{state.error}</div>
          )}
        </div>
      )}

      {active && (
        <>
          <div className="debug-toolbar" role="toolbar" aria-label="Controles de depuração">
            <IconButton
              icon="continue"
              size="sm"
              label="Continuar (F5)"
              className="debug-btn debug-btn-continue"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.continue_()}
            />
            <IconButton
              icon="debugPause"
              size="sm"
              label="Pausar"
              className="debug-btn"
              disabled={state.status !== "running"}
              onClick={() => void debugSession.pause()}
            />
            <IconButton
              icon="stepOver"
              size="sm"
              label="Passo (step over)"
              className="debug-btn"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.stepOver()}
            />
            <IconButton
              icon="stepInto"
              size="sm"
              label="Entrar (step in)"
              className="debug-btn"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.stepIn()}
            />
            <IconButton
              icon="stepOut"
              size="sm"
              label="Sair (step out)"
              className="debug-btn"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.stepOut()}
            />
            <IconButton
              icon="stop"
              size="sm"
              label="Parar depuração"
              className="debug-btn debug-btn-stop"
              onClick={() => void debugSession.stop()}
            />
          </div>

          {state.frames.length > 0 && (
            <div className="debug-block">
              <div className="debug-block-title">Pilha de chamadas</div>
              {state.frames.map((f) => (
                <button
                  key={f.id}
                  className={
                    "debug-frame-row" +
                    (f.id === state.selectedFrameId ? " selected" : "")
                  }
                  title={f.path}
                  onClick={() => {
                    void debugSession.selectFrame(f.id);
                    if (f.path && f.line) {
                      window.dispatchEvent(
                        new CustomEvent("fluent:debug-stopped", {
                          detail: { path: f.path, line: f.line },
                        })
                      );
                    }
                  }}
                >
                  {f.name}
                  {f.line ? `:${f.line}` : ""}
                </button>
              ))}
            </div>
          )}

          <WatchPanel watches={state.watches} />

          {state.scopes.map((s) => (
            <div key={s.variablesReference} className="debug-block">
              <div className="debug-block-title">{s.name}</div>
              {s.variables.map((v, i) => (
                <VariableTree
                  key={`${v.name}#${v.variablesReference}#${i}`}
                  variable={v}
                  depth={0}
                  childrenByRef={state.children}
                />
              ))}
            </div>
          ))}
        </>
      )}

      {state.output.length > 0 && (
        <div className="debug-output">
          {state.output.slice(-80).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One node of the (lazily expanded) variables tree. Objects/collections carry a
 * `variablesReference` > 0; clicking the chevron fetches their children once
 * (cached in `childrenByRef`) and toggles visibility.
 */
function VariableTree({
  variable,
  depth,
  childrenByRef,
}: {
  variable: VariableView;
  depth: number;
  childrenByRef: Record<number, VariableView[]>;
}) {
  const [open, setOpen] = useState(false);
  const expandable = variable.variablesReference > 0;
  const kids = childrenByRef[variable.variablesReference];

  const toggle = () => {
    if (!expandable) return;
    if (!open && !kids) void debugSession.expand(variable.variablesReference);
    setOpen((o) => !o);
  };

  return (
    <>
      <div
        className="debug-var-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={variable.type}
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={toggle}
        onKeyDown={(e) => {
          if (expandable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="debug-var-expander">
          {expandable ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="debug-var-name">{variable.name}</span>
        <span className="debug-var-value">{variable.value}</span>
      </div>
      {open &&
        kids?.map((child, i) => (
          <VariableTree
            key={`${child.name}#${child.variablesReference}#${i}`}
            variable={child}
            depth={depth + 1}
            childrenByRef={childrenByRef}
          />
        ))}
    </>
  );
}

/** Watch expressions panel: add/remove and show the last evaluation. */
function WatchPanel({ watches }: { watches: WatchView[] }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const e = draft.trim();
    if (!e) return;
    debugSession.addWatch(e);
    setDraft("");
  };
  return (
    <div className="debug-block">
      <div className="debug-block-title">Watch</div>
      <div className="debug-watch-input">
        <Input
          size="sm"
          aria-label="Expressão de watch"
          placeholder="Expressão (ex.: cliente.Nome)…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      {watches.map((w) => (
        <div key={w.expression} className="debug-var-row" title={w.type ?? w.error}>
          <span className="debug-var-name">{w.expression}</span>
          <span className={"debug-var-value" + (w.error ? " debug-var-error" : "")}>
            {w.error ?? w.value}
          </span>
          <IconButton
            icon="close"
            size="sm"
            label="Remover"
            className="debug-watch-remove"
            onClick={() => debugSession.removeWatch(w.expression)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * .NET tests section (roadmap csharp-ide-parity, Fase C): discover tests of a
 * `.csproj` (`dotnet test --list-tests`) and run all / one, with pass/fail and
 * duration inline (outcomes come from the locale-independent TRX report).
 */
function TestsSection({
  rootPath,
  pendingTest,
}: {
  rootPath: string;
  pendingTest: PendingTest | null;
}) {
  const csprojs = useCsprojs(rootPath);
  const [selected, setSelected] = useState<string>("");
  const [tests, setTests] = useState<string[] | null>(null);
  const [results, setResults] = useState<Map<string, DotnetTestResult>>(new Map());
  const [busy, setBusy] = useState<"" | "discover" | "run">("");
  const [coverage, setCoverage] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Last pendingTest object we already acted on, so recreating `run`/`debugTest`
  // (e.g. toggling coverage) doesn't re-trigger the previous test.
  const handledTest = useRef<PendingTest | null>(null);

  useEffect(() => {
    setSelected((cur) => cur || csprojs[0] || "");
  }, [csprojs]);

  // Workspace/project switch invalidates discovery.
  useEffect(() => {
    setTests(null);
    setResults(new Map());
    setError(null);
  }, [selected]);

  const run = useCallback(
    async (filters: string[] = [], csprojOverride?: string) => {
      const csproj = csprojOverride || selected;
      if (!csproj) return;
      setBusy("run");
      setError(null);
      try {
        const out = await dotnetTestRun(csproj, filters, coverage);
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of out.results) next.set(r.name, r);
          return next;
        });
        if (out.results.length === 0) setError(out.outputTail);
        applyCoverageDecorations(out.coverage);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy("");
      }
    },
    [selected, coverage]
  );

  /** Debug one test: launch it under VSTEST_HOST_DEBUG, attach the debugger. */
  const debugTest = useCallback(
    async (fqn: string, csprojOverride?: string) => {
      const csproj = csprojOverride || selected;
      if (!csproj) return;
      setBusy("run");
      setError(null);
      try {
        const pid = await dotnetTestDebug(csproj, fqn);
        await debugSession.attach(pid);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy("");
      }
    },
    [selected]
  );

  // Run/debug a single test when its CodeLens is clicked. The request arrives as
  // a prop from the App (which listens app-wide and switches to this view first,
  // so the panel is mounted to receive it). Each click is a fresh object; the ref
  // guard ensures ONLY a new object triggers — recreating `run`/`debugTest` (e.g.
  // toggling coverage) must not re-fire the previous test.
  useEffect(() => {
    if (!pendingTest || handledTest.current === pendingTest) return;
    handledTest.current = pendingTest;
    setSelected(pendingTest.csprojPath);
    if (pendingTest.mode === "debug") {
      void debugTest(pendingTest.fullyQualifiedName, pendingTest.csprojPath);
    } else {
      void run([pendingTest.fullyQualifiedName], pendingTest.csprojPath);
    }
  }, [pendingTest, run, debugTest]);

  // All hooks are above this line — the early return must stay below them so the
  // hook order is stable across renders (Rules of Hooks).
  if (csprojs.length === 0) return null;

  const discover = async () => {
    setBusy("discover");
    setError(null);
    try {
      setTests(await dotnetTestList(selected));
    } catch (err) {
      setError(String(err));
      setTests(null);
    } finally {
      setBusy("");
    }
  };

  // Índice de resultados por FQN. TRX nomeia Theory como `Fqn(args)`, então além
  // do lookup exato mantemos um índice pelo prefixo (parte antes do `(`). Montado
  // UMA vez por render (linear) — antes o `resultFor` era O(n) por chamada, ×N
  // testes ×cada render = O(n²).
  const byPrefix = new Map<string, DotnetTestResult>();
  for (const r of results.values()) {
    const base = r.name.split("(")[0];
    if (!byPrefix.has(base)) byPrefix.set(base, r);
  }
  const resultFor = (fqn: string): DotnetTestResult | undefined =>
    results.get(fqn) ?? byPrefix.get(fqn);

  const groups = tests ? groupTests(tests) : [];
  const failedFqns = tests
    ? tests.filter((t) => resultFor(t)?.outcome === "Failed")
    : [];

  const toggleGroup = (container: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(container)) next.delete(container);
      else next.add(container);
      return next;
    });

  return (
    <div className="run-group debug-section">
      <SectionHeader level={2} title="Testes (.NET)" badge={tests ? tests.length : undefined} />
      <div className="debug-launcher">
        <Select
          ariaLabel="Projeto de testes"
          value={selected}
          onChange={setSelected}
          disabled={busy !== ""}
          options={csprojs.map((p) => ({
            value: p,
            label: p.split(/[\/]/).pop() ?? p,
          }))}
        />
        <Checkbox
          className="test-coverage-toggle"
          label="Cobertura"
          checked={coverage}
          disabled={busy !== ""}
          onChange={(e) => {
            setCoverage(e.target.checked);
            // Desligar limpa as faixas na hora (não esperam o próximo run).
            if (!e.target.checked) clearCoverageDecorations();
          }}
        />
        <div className="run-draft-actions">
          <button
            className="git-commit-btn"
            disabled={!selected || busy !== ""}
            onClick={() => void discover()}
          >
            {busy === "discover" ? "Descobrindo…" : "Descobrir testes"}
          </button>
          {tests && tests.length > 0 && (
            <button
              className="git-link-btn"
              disabled={busy !== ""}
              onClick={() => void run()}
            >
              {busy === "run" ? "Executando…" : "Executar todos"}
            </button>
          )}
          {failedFqns.length > 0 && (
            <button
              className="git-link-btn"
              disabled={busy !== ""}
              title="Reexecutar apenas os testes que falharam"
              onClick={() => void run(failedFqns)}
            >
              Reexecutar falhas ({failedFqns.length})
            </button>
          )}
        </div>
        {error && <div className="git-error">{error}</div>}
      </div>

      {tests && tests.length === 0 && (
        <div className="panel-empty">Nenhum teste neste projeto.</div>
      )}

      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.container);
        const groupFailed = g.leaves.some((l) => resultFor(l.fqn)?.outcome === "Failed");
        return (
          <div key={g.container} className="test-group">
            <div
              className="test-group-header"
              role="button"
              tabIndex={0}
              onClick={() => toggleGroup(g.container)}
              onKeyDown={(e) => e.key === "Enter" && toggleGroup(g.container)}
              title={g.container}
            >
              <span className="test-expander">{isCollapsed ? "▸" : "▾"}</span>
              <span className={"test-class" + (groupFailed ? " test-fail" : "")}>
                {g.className || g.container}
              </span>
              {g.namespace && <span className="test-namespace">{g.namespace}</span>}
              <span className="git-count">{g.leaves.length}</span>
            </div>
            {!isCollapsed &&
              g.leaves.map((leaf) => {
                const r = resultFor(leaf.fqn);
                const icon =
                  r?.outcome === "Passed" ? "✓" : r?.outcome === "Failed" ? "✗" : "·";
                const cls =
                  r?.outcome === "Passed"
                    ? "test-pass"
                    : r?.outcome === "Failed"
                      ? "test-fail"
                      : "";
                return (
                  <div
                    key={leaf.fqn}
                    className="test-row test-leaf"
                    title={r?.message ?? leaf.fqn}
                  >
                    <IconButton
                      icon="run"
                      size="sm"
                      label={`Executar ${leaf.method}`}
                      className="run-play"
                      disabled={busy !== ""}
                      onClick={() => void run([leaf.fqn])}
                    />
                    <button
                      className="run-play test-debug-btn"
                      title={`Depurar ${leaf.method}`}
                      disabled={busy !== ""}
                      onClick={() => void debugTest(leaf.fqn)}
                    >
                      🐞
                    </button>
                    <span className={`test-icon ${cls}`}>{icon}</span>
                    <span className="test-name">{leaf.method}</span>
                    {r?.durationMs != null && (
                      <span className="test-duration">{Math.round(r.durationMs)}ms</span>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

/** The four explicit project actions, in the order shown. */
const PROJECT_ACTIONS = [
  { key: "build", label: "Compilar", run: dotnetBuild },
  { key: "rebuild", label: "Recompilar", run: dotnetRebuild },
  { key: "clean", label: "Limpar", run: dotnetClean },
  { key: "restore", label: "Restaurar", run: dotnetRestore },
] as const;

/**
 * Explicit build/rebuild/clean/restore for a selected `.csproj` (or the whole
 * workspace) — the actions the C# Dev Kit exposes on the Solution Explorer
 * (milestone #11). Distinct from build-on-save diagnostics (that stays in the
 * Problems panel); here the user triggers the action and sees success + output.
 */
function ProjectActionsSection({ rootPath }: { rootPath: string }) {
  const csprojs = useCsprojs(rootPath);
  // "" = whole workspace; otherwise a specific project path.
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [result, setResult] = useState<DotnetActionResult | null>(null);

  useEffect(() => {
    setResult(null);
  }, [target]);

  if (csprojs.length === 0) return null;

  const runAction = async (
    key: string,
    fn: (t: string) => Promise<DotnetActionResult>
  ) => {
    setBusy(key);
    setResult(null);
    try {
      setResult(await fn(target));
    } catch (err) {
      setResult({ success: false, output: String(err) });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="run-group debug-section">
      <SectionHeader level={2} title="Ações do projeto (.NET)" />
      <div className="debug-launcher">
        <Select
          ariaLabel="Alvo das ações"
          value={target}
          onChange={setTarget}
          disabled={busy !== ""}
          options={[
            { value: "", label: "Solução inteira" },
            ...csprojs.map((p) => ({ value: p, label: p.split(/[\/]/).pop() ?? p })),
          ]}
        />
        <div className="run-draft-actions">
          {PROJECT_ACTIONS.map((a) => (
            <button
              key={a.key}
              className="git-link-btn"
              disabled={busy !== ""}
              onClick={() => void runAction(a.key, a.run)}
            >
              {busy === a.key ? `${a.label}…` : a.label}
            </button>
          ))}
        </div>
        {result && (
          <div className={result.success ? "test-pass" : "git-error"}>
            {result.success ? "✓ Concluído" : "✗ Falhou"}
            {result.output.trim() && (
              <pre className="run-action-output">{result.output.trim()}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
