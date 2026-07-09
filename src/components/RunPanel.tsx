import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  dotnetBuild,
  dotnetClean,
  dotnetRebuild,
  dotnetRestore,
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

/** Loads the workspace's `.csproj` paths once per root (shared by the .NET sections). */
function useCsprojs(rootPath: string): string[] {
  const [csprojs, setCsprojs] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listProjectFiles(rootPath)
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
  }, [rootPath]);
  return csprojs;
}
import { Tooltip } from "./Tooltip";

/** A test to run, requested from a "▶ Executar Teste" CodeLens click. A fresh
 *  object on every request so re-clicking the same test re-runs it. */
export interface PendingTest {
  csprojPath: string;
  fullyQualifiedName: string;
}

interface RunPanelProps {
  /** Open folder; configs live in `<root>/.project/run.json`. Null = none. */
  rootPath: string | null;
  /** Asks the app to run `command` in the integrated terminal. */
  onRun: (command: string) => void;
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
export function RunPanel({ rootPath, onRun, pendingTest }: RunPanelProps) {
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [suggestions, setSuggestions] = useState<RunConfig[]>([]);
  const [draft, setDraft] = useState<RunConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!rootPath) {
      setConfigs([]);
      setSuggestions([]);
      return;
    }
    try {
      const [saved, detected] = await Promise.all([
        runConfigsLoad(rootPath),
        runConfigsDetect(rootPath),
      ]);
      setConfigs(saved);
      // Hide suggestions that already exist (by command) among saved configs.
      const savedCmds = new Set(saved.map((c) => c.command));
      setSuggestions(detected.filter((d) => !savedCmds.has(d.command)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [rootPath]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function persist(next: RunConfig[]) {
    if (!rootPath) return;
    try {
      await runConfigsSave(rootPath, next);
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

  if (!rootPath) {
    return (
      <div className="run-panel">
        <div className="explorer-header">
          <span className="explorer-title">EXECUTAR E DEPURAR</span>
        </div>
        <div className="panel-empty">Abra uma pasta para configurar a execução.</div>
      </div>
    );
  }

  return (
    <div className="run-panel">
      <div className="explorer-header run-header">
        <span className="explorer-title">EXECUTAR E DEPURAR</span>
        <Tooltip label={draft ? "Fechar nova configuração" : "Nova configuração"}>
          <button
            className="git-icon-btn"
            aria-label={draft ? "Fechar nova configuração" : "Nova configuração"}
            aria-expanded={Boolean(draft)}
            onClick={() => setDraft(draft ? null : { ...EMPTY_DRAFT })}
          >
            +
          </button>
        </Tooltip>
      </div>

      {error && <div className="git-error">{error}</div>}

      {draft && (
        <div className="run-draft">
          <input
            className="search-input"
            placeholder="Nome (ex.: dev)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className="search-input"
            placeholder="Comando (ex.: npm run dev)"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <input
            className="search-input"
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

      <div className="run-lists">
        <DebugSection rootPath={rootPath} />
        <TestsSection rootPath={rootPath} pendingTest={pendingTest ?? null} />
        <ProjectActionsSection rootPath={rootPath} />

        <div className="git-group">
          <div className="git-group-header">
            <span>Configurações</span>
            <span className="git-count">{configs.length}</span>
          </div>
          {configs.length === 0 ? (
            <div className="panel-empty">Nenhuma configuração salva.</div>
          ) : (
            configs.map((c, i) => (
              <div key={`${c.name}-${i}`} className="run-row" title={c.command}>
                <Tooltip label={`Executar: ${c.command}`}>
                  <button
                    className="run-play"
                    aria-label={`Executar: ${c.command}`}
                    onClick={() => onRun(buildCommand(c))}
                  >
                    ▶
                  </button>
                </Tooltip>
                <div className="run-info">
                  <span className="run-name">{c.name}</span>
                  <span className="run-cmd">{c.command}</span>
                </div>
                <Tooltip label="Remover">
                  <button
                    className="run-remove"
                    aria-label="Remover"
                    onClick={() => removeConfig(i)}
                  >
                    ✕
                  </button>
                </Tooltip>
              </div>
            ))
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="git-group">
            <div className="git-group-header">
              <span>Detectadas no projeto</span>
              <span className="git-count">{suggestions.length}</span>
            </div>
            {suggestions.map((s, i) => (
              <div key={`sug-${i}`} className="run-row" title={s.command}>
                <Tooltip label={`Executar: ${s.command}`}>
                  <button
                    className="run-play"
                    aria-label={`Executar: ${s.command}`}
                    onClick={() => onRun(buildCommand(s))}
                  >
                    ▶
                  </button>
                </Tooltip>
                <div className="run-info">
                  <span className="run-name">{s.name}</span>
                  <span className="run-cmd">{s.command}</span>
                </div>
                <Tooltip label="Adicionar às configurações">
                  <button
                    className="git-link-btn"
                    aria-label="Adicionar às configurações"
                    onClick={() => addConfig(s)}
                  >
                    +
                  </button>
                </Tooltip>
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
    <div className="git-group debug-section">
      <div className="git-group-header">
        <span>Depurar (.NET)</span>
        <span className={`debug-status debug-status-${state.status}`}>
          {state.status === "idle" && "pronto"}
          {state.status === "starting" && "iniciando…"}
          {state.status === "running" && "executando"}
          {state.status === "stopped" && "pausado"}
          {state.status === "error" && "erro"}
        </span>
      </div>

      {!active && (
        <div className="debug-launcher">
          <select
            className="search-input"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
          >
            {csprojs.map((p) => (
              <option key={p} value={p}>
                {p.split(/[\\/]/).pop()}
              </option>
            ))}
          </select>
          {profiles.length > 0 && (
            <select
              className="search-input"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              disabled={busy}
              title="Perfil do launchSettings.json (env, args, URL)"
            >
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
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
          <div className="debug-toolbar">
            <button
              className="debug-btn"
              title="Continuar (F5)"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.continue_()}
            >
              ▶
            </button>
            <button
              className="debug-btn"
              title="Pausar"
              disabled={state.status !== "running"}
              onClick={() => void debugSession.pause()}
            >
              ⏸
            </button>
            <button
              className="debug-btn"
              title="Passo (step over)"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.stepOver()}
            >
              ⤼
            </button>
            <button
              className="debug-btn"
              title="Entrar (step in)"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.stepIn()}
            >
              ⤵
            </button>
            <button
              className="debug-btn"
              title="Sair (step out)"
              disabled={state.status !== "stopped"}
              onClick={() => void debugSession.stepOut()}
            >
              ⤴
            </button>
            <button
              className="debug-btn debug-btn-stop"
              title="Parar depuração"
              onClick={() => void debugSession.stop()}
            >
              ⏹
            </button>
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
        onClick={toggle}
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
        <input
          className="search-input"
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
          <button
            className="debug-watch-remove"
            title="Remover"
            onClick={() => debugSession.removeWatch(w.expression)}
          >
            ✕
          </button>
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
  const [error, setError] = useState<string | null>(null);

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
    async (filter?: string, csprojOverride?: string) => {
      const csproj = csprojOverride || selected;
      if (!csproj) return;
      setBusy("run");
      setError(null);
      try {
        const out = await dotnetTestRun(csproj, filter);
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of out.results) next.set(r.name, r);
          return next;
        });
        if (out.results.length === 0) setError(out.outputTail);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy("");
      }
    },
    [selected]
  );

  // Run a single test when its "▶ Executar Teste" CodeLens is clicked. The
  // request arrives as a prop from the App (which listens app-wide and switches
  // to this view first, so the panel is mounted to receive it). Each request is
  // a fresh object, so the effect re-runs even for the same test twice.
  useEffect(() => {
    if (!pendingTest) return;
    setSelected(pendingTest.csprojPath);
    void run(pendingTest.fullyQualifiedName, pendingTest.csprojPath);
  }, [pendingTest, run]);

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

  /** TRX names can be `Ns.Class.Method` or carry args — match by prefix too. */
  const resultFor = (fqn: string): DotnetTestResult | undefined =>
    results.get(fqn) ??
    [...results.values()].find((r) => r.name === fqn || r.name.startsWith(`${fqn}(`));

  return (
    <div className="git-group debug-section">
      <div className="git-group-header">
        <span>Testes (.NET)</span>
        {tests && <span className="git-count">{tests.length}</span>}
      </div>
      <div className="debug-launcher">
        <select
          className="search-input"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy !== ""}
        >
          {csprojs.map((p) => (
            <option key={p} value={p}>
              {p.split(/[\/]/).pop()}
            </option>
          ))}
        </select>
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
        </div>
        {error && <div className="git-error">{error}</div>}
      </div>

      {tests && tests.length === 0 && (
        <div className="panel-empty">Nenhum teste neste projeto.</div>
      )}
      {tests?.map((t) => {
        const r = resultFor(t);
        const icon =
          r?.outcome === "Passed" ? "✓" : r?.outcome === "Failed" ? "✗" : "·";
        const cls =
          r?.outcome === "Passed"
            ? "test-pass"
            : r?.outcome === "Failed"
              ? "test-fail"
              : "";
        return (
          <div key={t} className="test-row" title={r?.message ?? t}>
            <button
              className="run-play"
              title={`Executar ${t}`}
              disabled={busy !== ""}
              onClick={() => void run(t)}
            >
              ▶
            </button>
            <span className={`test-icon ${cls}`}>{icon}</span>
            <span className="test-name">{t.split(".").slice(-2).join(".")}</span>
            {r?.durationMs != null && (
              <span className="test-duration">{Math.round(r.durationMs)}ms</span>
            )}
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
    <div className="git-group debug-section">
      <div className="git-group-header">
        <span>Ações do projeto (.NET)</span>
      </div>
      <div className="debug-launcher">
        <select
          className="search-input"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy !== ""}
        >
          <option value="">Solução inteira</option>
          {csprojs.map((p) => (
            <option key={p} value={p}>
              {p.split(/[\/]/).pop()}
            </option>
          ))}
        </select>
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
