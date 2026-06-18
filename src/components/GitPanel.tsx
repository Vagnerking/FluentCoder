import { useCallback, useEffect, useState } from "react";
import {
  gitCommit,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
} from "../api";
import type { GitCommit, GitFileStatus, GitStatus } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface GitPanelProps {
  /** Open folder; the repo is resolved from here. Null when nothing is open. */
  rootPath: string | null;
  /** Open a file (e.g. when a changed file is clicked). */
  onOpenFile: (path: string, name: string) => void;
}

/** Maps a porcelain code to a single-letter badge + a CSS modifier. */
function badge(file: GitFileStatus): { letter: string; kind: string } {
  if (file.untracked) return { letter: "U", kind: "untracked" };
  // Use the worktree column for unstaged, the index column for staged.
  const idx = file.code.charAt(0);
  const wt = file.code.charAt(1);
  const c = file.staged ? idx : wt;
  switch (c) {
    case "M":
      return { letter: "M", kind: "modified" };
    case "A":
      return { letter: "A", kind: "added" };
    case "D":
      return { letter: "D", kind: "deleted" };
    case "R":
      return { letter: "R", kind: "renamed" };
    default:
      return { letter: c === "." ? "M" : c || "?", kind: "modified" };
  }
}

function fileName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function GitPanel({ rootPath, onOpenFile }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setStatus(null);
      return;
    }
    try {
      const s = await gitStatus(rootPath);
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [rootPath]);

  // Load status when the folder changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Wraps an action with busy state, error capture, and a status refresh. */
  async function act(fn: () => Promise<unknown>) {
    if (!rootPath) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadHistory() {
    if (!rootPath) return;
    try {
      setCommits(await gitLog(rootPath, 30));
    } catch (err) {
      setError(String(err));
    }
  }

  function toggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && commits.length === 0) loadHistory();
  }

  if (!rootPath) {
    return (
      <div className="git-panel">
        <div className="explorer-header">
          <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
        </div>
        <div className="panel-empty">Abra uma pasta para usar o Git.</div>
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className="git-panel">
        <div className="explorer-header">
          <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
        </div>
        <div className="panel-empty">Esta pasta não é um repositório Git.</div>
      </div>
    );
  }

  const staged = status?.files.filter((f) => f.staged) ?? [];
  const changes = status?.files.filter((f) => !f.staged) ?? [];

  return (
    <div className="git-panel">
      <div className="explorer-header git-header">
        <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
        <div className="git-actions">
          <button
            className="git-icon-btn"
            title="Buscar (fetch)"
            disabled={busy}
            onClick={() => act(() => gitFetch(rootPath))}
          >
            <Codicon name="refresh" />
          </button>
          <button
            className="git-icon-btn"
            title="Pull"
            disabled={busy || !status?.hasUpstream}
            onClick={() => act(() => gitPull(rootPath))}
          >
            <Codicon name="gitPull" />
            {status && status.behind > 0 ? status.behind : ""}
          </button>
          <button
            className="git-icon-btn"
            title="Push"
            disabled={busy || !status?.hasUpstream}
            onClick={() => act(() => gitPush(rootPath))}
          >
            <Codicon name="gitPush" />
            {status && status.ahead > 0 ? status.ahead : ""}
          </button>
        </div>
      </div>

      <div className="git-branch-row" title="Branch atual">
        <Codicon name="gitBranch" /> {status?.branch || "—"}
      </div>

      <div className="git-commit-box">
        <textarea
          className="git-message"
          placeholder={`Mensagem (commit em ${status?.branch || "branch"})`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
        />
        <button
          className="git-commit-btn"
          disabled={busy || !message.trim() || staged.length === 0}
          title={
            staged.length === 0
              ? "Prepare (stage) arquivos antes de commitar"
              : "Commit dos arquivos preparados"
          }
          onClick={() =>
            act(async () => {
              await gitCommit(rootPath, message);
              setMessage("");
            })
          }
        >
          <Codicon name="gitCommit" /> Commit
          {staged.length ? ` (${staged.length})` : ""}
        </button>
      </div>

      {error && <div className="git-error">{error}</div>}

      <div className="git-lists">
        {staged.length > 0 && (
          <div className="git-group">
            <div className="git-group-header">
              <span>Alterações preparadas</span>
              <span className="git-count">{staged.length}</span>
            </div>
            {staged.map((f) => (
              <GitFileRow
                key={`s-${f.path}`}
                file={f}
                actionIcon="remove"
                actionTitle="Remover do stage"
                onAction={() => act(() => gitUnstage(rootPath, f.path))}
                onOpen={() => onOpenFile(`${rootPath}/${f.path}`, fileName(f.path))}
                disabled={busy}
              />
            ))}
          </div>
        )}

        <div className="git-group">
          <div className="git-group-header">
            <span>Alterações</span>
            <div className="git-group-header-actions">
              {changes.length > 0 && (
                <button
                  className="git-link-btn"
                  disabled={busy}
                  title="Preparar tudo"
                  onClick={() => act(() => gitStageAll(rootPath))}
                >
                  <Codicon name="add" />
                </button>
              )}
              <span className="git-count">{changes.length}</span>
            </div>
          </div>
          {changes.length === 0 && staged.length === 0 ? (
            <div className="panel-empty">Nenhuma alteração.</div>
          ) : (
            changes.map((f) => (
              <GitFileRow
                key={`c-${f.path}`}
                file={f}
                actionIcon="add"
                actionTitle="Preparar (stage)"
                onAction={() => act(() => gitStage(rootPath, f.path))}
                onOpen={() => onOpenFile(`${rootPath}/${f.path}`, fileName(f.path))}
                disabled={busy}
              />
            ))
          )}
        </div>

        <div className="git-group">
          <button className="git-group-toggle" onClick={toggleHistory}>
            <span className="tree-chevron">
              <Codicon name={showHistory ? "chevronDown" : "chevronRight"} size={12} />
            </span>
            Histórico
          </button>
          {showHistory &&
            (commits.length === 0 ? (
              <div className="panel-empty">Sem commits.</div>
            ) : (
              commits.map((c) => (
                <div key={c.hash} className="git-commit-row" title={c.hash}>
                  <span className="git-commit-subject">{c.subject}</span>
                  <span className="git-commit-meta">
                    {c.short} · {c.author} · {c.date}
                  </span>
                </div>
              ))
            ))}
        </div>
      </div>
    </div>
  );
}

interface GitFileRowProps {
  file: GitFileStatus;
  actionIcon: IconAction;
  actionTitle: string;
  onAction: () => void;
  onOpen: () => void;
  disabled: boolean;
}

function GitFileRow({
  file,
  actionIcon,
  actionTitle,
  onAction,
  onOpen,
  disabled,
}: GitFileRowProps) {
  const b = badge(file);
  return (
    <div className="git-file-row" title={file.path}>
      <FileIcon path={file.path} className="git-file-icon" />
      <span className="git-file-name" onClick={onOpen}>
        {fileName(file.path)}
      </span>
      <span className="git-file-spacer" />
      <button
        className="git-file-action"
        title={actionTitle}
        disabled={disabled}
        onClick={onAction}
      >
        <Codicon name={actionIcon} />
      </button>
      <span className={`git-file-badge git-badge-${b.kind}`}>{b.letter}</span>
    </div>
  );
}
