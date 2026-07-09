import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  dotnetTestList,
  dotnetTestRun,
  listProjectFiles,
  runConfigsDetect,
  runConfigsLoad,
  runConfigsSave,
  type DotnetProcess,
  type DotnetTestResult,
} from "../api";
import type { RunConfig } from "../types";
import { debugSession } from "../dap/debugSession";

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

  useEffect(() => {
    setSelected((cur) => cur || csprojs[0] || "");
  }, [csprojs]);

  const busy = state.status === "starting";
  const active = state.status === "running" || state.status === "stopped";

  // Nothing to debug in this workspace — keep the panel clean.
  if (csprojs.length === 0 && !active) return null;

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
          <div className="run-draft-actions">
            <button
              className="git-commit-btn"
              disabled={!selected || busy}
              title="Compila e inicia sob o depurador"
              onClick={() => {
                const cwd = selected.replace(/[\\/][^\\/]+$/, "");
                void debugSession.launchProject(selected, cwd);
              }}
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
                  className="debug-frame-row"
                  title={f.path}
                  onClick={() => {
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

          {state.scopes.map((s) => (
            <div key={s.name} className="debug-block">
              <div className="debug-block-title">{s.name}</div>
              {s.variables.map((v) => (
                <div key={v.name} className="debug-var-row" title={v.type}>
                  <span className="debug-var-name">{v.name}</span>
                  <span className="debug-var-value">{v.value}</span>
                </div>
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
