import { useCallback, useEffect, useState } from "react";
import {
  runConfigsDetect,
  runConfigsLoad,
  runConfigsSave,
} from "../api";
import type { RunConfig } from "../types";
import { Tooltip } from "./Tooltip";

interface RunPanelProps {
  /** Open folder; configs live in `<root>/.project/run.json`. Null = none. */
  rootPath: string | null;
  /** Asks the app to run `command` in the integrated terminal. */
  onRun: (command: string) => void;
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
export function RunPanel({ rootPath, onRun }: RunPanelProps) {
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
        <Tooltip label="Nova configuração">
          <button
            className="git-icon-btn"
            aria-label="Nova configuração"
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
