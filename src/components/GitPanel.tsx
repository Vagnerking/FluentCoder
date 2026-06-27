import { useCallback, useEffect, useState } from "react";
import {
  gitCommit,
  gitDiscardAll,
  gitDiscardFile,
  gitFetch,
  gitLog,
  gitLogFile,
  gitPull,
  gitPush,
  gitStage,
  gitStageAll,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitUnstage,
} from "../api";
import type {
  ContextMenuItem,
  GitCommit,
  GitFileStatus,
  GitStashEntry,
  GitStatus,
} from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { TreeContextMenu } from "./TreeContextMenu";
import { Tooltip } from "./Tooltip";

interface GitPanelProps {
  /** Open folder; the repo is resolved from here. Null when nothing is open. */
  rootPath: string | null;
  /** Open a file (e.g. when a changed file is clicked). */
  onOpenFile: (path: string, name: string) => void;
  /**
   * Absolute path whose history to show (ISSUE-71 · File History). When set, the
   * History section auto-expands and lists only this file's commits, with a
   * banner to clear back to the repo-wide log. Null = normal repo history.
   */
  historyFile?: string | null;
  /** Clears the file-history filter, returning to the repo-wide log. */
  onClearHistoryFile?: () => void;
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

export function GitPanel({
  rootPath,
  onOpenFile,
  historyFile = null,
  onClearHistoryFile,
}: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [showStashes, setShowStashes] = useState(false);
  // Commits for the file under "File History" (ISSUE-71). Separate from the
  // repo-wide `commits` so switching back doesn't refetch the whole log.
  const [fileCommits, setFileCommits] = useState<GitCommit[]>([]);
  // Right-click context menu over a changed file (issue #9), VS Code-style.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setStatus(null);
      return;
    }
    try {
      const s = await gitStatus(rootPath);
      setStatus(s);
      setError(null);
      gitStashList(rootPath).then(setStashes).catch(() => {});
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

  // File History (ISSUE-71): when App sets `historyFile`, expand the History
  // section and fetch that file's commits via `git_log_file`.
  useEffect(() => {
    if (!rootPath || !historyFile) {
      setFileCommits([]);
      return;
    }
    setShowHistory(true);
    let cancelled = false;
    gitLogFile(rootPath, historyFile, 50)
      .then((c) => {
        if (!cancelled) setFileCommits(c);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, historyFile]);

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

  const conflicts = status?.files.filter((f) => f.conflicted) ?? [];
  const staged = status?.files.filter((f) => f.staged && !f.conflicted) ?? [];
  const changes = status?.files.filter((f) => !f.staged && !f.conflicted) ?? [];

  const discardFile = (f: GitFileStatus) =>
    act(async () => {
      if (
        !window.confirm(
          `Descartar as alterações de "${fileName(f.path)}"? Esta ação não pode ser desfeita.`
        )
      )
        return;
      await gitDiscardFile(rootPath, f.path, f.untracked);
    });

  // Right-click menu for a changed file (issue #9). Mirrors VS Code's Source
  // Control context menu: Open File, Open Changes (diff — "em breve", like the
  // explorer's), and the stage/unstage/discard action set for the file's group.
  const openFileMenu = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const fileMenu = (
    f: GitFileStatus,
    group: "conflict" | "staged" | "changes"
  ): ContextMenuItem[] => {
    const open: ContextMenuItem = {
      id: "open",
      label: "Abrir Arquivo",
      icon: "file",
      run: () => onOpenFile(`${rootPath}/${f.path}`, fileName(f.path)),
    };
    const openChanges: ContextMenuItem = {
      id: "openChanges",
      label: "Abrir Alterações",
      icon: "openChanges",
      enabled: false,
      title: "Em breve (visualização de diff)",
    };
    const sep: ContextMenuItem = { id: "sep", label: "", separator: true };
    if (group === "conflict") {
      return [
        open,
        sep,
        {
          id: "resolve",
          label: "Marcar como resolvido",
          icon: "success",
          run: () => act(() => gitStage(rootPath, f.path)),
        },
      ];
    }
    if (group === "staged") {
      return [
        open,
        openChanges,
        sep,
        {
          id: "unstage",
          label: "Remover do stage",
          icon: "remove",
          run: () => act(() => gitUnstage(rootPath, f.path)),
        },
      ];
    }
    return [
      open,
      openChanges,
      sep,
      {
        id: "stage",
        label: "Preparar (stage)",
        icon: "add",
        run: () => act(() => gitStage(rootPath, f.path)),
      },
      {
        id: "discard",
        label: "Descartar Alterações",
        icon: "discard",
        run: () => discardFile(f),
      },
    ];
  };

  return (
    <div className="git-panel">
      <div className="explorer-header git-header">
        <span className="explorer-title">CONTROLE DE CÓDIGO-FONTE</span>
        <div className="git-actions">
          <Tooltip label="Buscar (fetch)">
            <button
              className="git-icon-btn"
              aria-label="Buscar (fetch)"
              disabled={busy}
              onClick={() => act(() => gitFetch(rootPath))}
            >
              <Codicon name="refresh" />
            </button>
          </Tooltip>
          <Tooltip label="Pull">
            <button
              className="git-icon-btn"
              aria-label="Pull"
              disabled={busy || !status?.hasUpstream}
              onClick={() => act(() => gitPull(rootPath))}
            >
              <Codicon name="gitPull" />
              {status && status.behind > 0 ? status.behind : ""}
            </button>
          </Tooltip>
          <Tooltip label="Push">
            <button
              className="git-icon-btn"
              aria-label="Push"
              disabled={busy || !status?.hasUpstream}
              onClick={() => act(() => gitPush(rootPath))}
            >
              <Codicon name="gitPush" />
              {status && status.ahead > 0 ? status.ahead : ""}
            </button>
          </Tooltip>
          <Tooltip label="Guardar alterações (stash)">
            <button
              className="git-icon-btn"
              aria-label="Guardar alterações (stash)"
              disabled={busy || (status?.files.length ?? 0) === 0}
              onClick={() => {
                const raw = window.prompt("Mensagem do stash (opcional):");
                if (raw === null) return;
                void act(() => gitStashPush(rootPath, raw || undefined));
              }}
            >
              <Codicon name="bookmark" />
            </button>
          </Tooltip>
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
        {conflicts.length > 0 && (
          <div className="git-group">
            <div className="git-group-header git-group-conflict">
              <span>
                <Codicon name="warning" size={13} /> Conflitos de merge
              </span>
              <span className="git-count">{conflicts.length}</span>
            </div>
            {conflicts.map((f) => (
              <GitFileRow
                key={`x-${f.path}`}
                file={f}
                actionIcon="success"
                actionTitle="Marcar como resolvido (stage)"
                onAction={() => act(() => gitStage(rootPath, f.path))}
                onOpen={() => onOpenFile(`${rootPath}/${f.path}`, fileName(f.path))}
                onContextMenu={(e) => openFileMenu(e, fileMenu(f, "conflict"))}
                disabled={busy}
              />
            ))}
          </div>
        )}

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
                onContextMenu={(e) => openFileMenu(e, fileMenu(f, "staged"))}
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
                <>
                  <Tooltip label="Descartar todas as alterações">
                    <button
                      className="git-link-btn"
                      disabled={busy}
                      aria-label="Descartar todas as alterações"
                      onClick={() =>
                        act(async () => {
                          if (
                            !window.confirm(
                              "Descartar TODAS as alterações do diretório de trabalho? Esta ação não pode ser desfeita."
                            )
                          )
                            return;
                          await gitDiscardAll(rootPath);
                        })
                      }
                    >
                      <Codicon name="discard" />
                    </button>
                  </Tooltip>
                  <Tooltip label="Preparar tudo">
                    <button
                      className="git-link-btn"
                      disabled={busy}
                      aria-label="Preparar tudo"
                      onClick={() => act(() => gitStageAll(rootPath))}
                    >
                      <Codicon name="add" />
                    </button>
                  </Tooltip>
                </>
              )}
              <span className="git-count">{changes.length}</span>
            </div>
          </div>
          {changes.length === 0 && staged.length === 0 && conflicts.length === 0 ? (
            <div className="panel-empty">Nenhuma alteração.</div>
          ) : (
            changes.map((f) => (
              <GitFileRow
                key={`c-${f.path}`}
                file={f}
                actionIcon="add"
                actionTitle="Preparar (stage)"
                onAction={() => act(() => gitStage(rootPath, f.path))}
                onDiscard={() => discardFile(f)}
                onOpen={() => onOpenFile(`${rootPath}/${f.path}`, fileName(f.path))}
                onContextMenu={(e) => openFileMenu(e, fileMenu(f, "changes"))}
                disabled={busy}
              />
            ))
          )}
        </div>

        {stashes.length > 0 && (
          <div className="git-group">
            <button
              className="git-group-toggle"
              onClick={() => setShowStashes((v) => !v)}
            >
              <span className="tree-chevron">
                <Codicon name={showStashes ? "chevronDown" : "chevronRight"} size={12} />
              </span>
              Stashes
              <span className="git-count">{stashes.length}</span>
            </button>
            {showStashes &&
              stashes.map((st) => (
                <div key={st.index} className="git-stash-row" title={st.message}>
                  <Codicon name="bookmark" size={13} />
                  <span className="git-stash-msg">{st.message}</span>
                  <span className="git-file-spacer" />
                  <Tooltip label="Aplicar (mantém o stash)">
                    <button
                      className="git-file-action"
                      aria-label="Aplicar (mantém o stash)"
                      disabled={busy}
                      onClick={() => act(() => gitStashApply(rootPath, st.index))}
                    >
                      <Codicon name="add" size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Pop (aplica e remove)">
                    <button
                      className="git-file-action"
                      aria-label="Pop (aplica e remove)"
                      disabled={busy}
                      onClick={() => act(() => gitStashPop(rootPath, st.index))}
                    >
                      <Codicon name="gitPull" size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Descartar stash">
                    <button
                      className="git-file-action"
                      aria-label="Descartar stash"
                      disabled={busy}
                      onClick={() =>
                        act(async () => {
                          if (!window.confirm("Descartar este stash?")) return;
                          await gitStashDrop(rootPath, st.index);
                        })
                      }
                    >
                      <Codicon name="trash" size={14} />
                    </button>
                  </Tooltip>
                </div>
              ))}
          </div>
        )}

        <div className="git-group">
          <button className="git-group-toggle" onClick={toggleHistory}>
            <span className="tree-chevron">
              <Codicon name={showHistory ? "chevronDown" : "chevronRight"} size={12} />
            </span>
            {historyFile ? `Histórico de ${fileName(historyFile)}` : "Histórico"}
          </button>
          {historyFile && (
            <button
              className="git-link-btn git-history-clear"
              title="Voltar ao histórico do repositório"
              onClick={() => onClearHistoryFile?.()}
            >
              <Codicon name="close" size={12} /> Limpar filtro
            </button>
          )}
          {showHistory &&
            (() => {
              const list = historyFile ? fileCommits : commits;
              if (list.length === 0) {
                return (
                  <div className="panel-empty">
                    {historyFile
                      ? "Nenhum commit para este arquivo."
                      : "Sem commits."}
                  </div>
                );
              }
              return list.map((c) => (
                <div key={c.hash} className="git-commit-row" title={c.hash}>
                  <span className="git-commit-subject">{c.subject}</span>
                  <span className="git-commit-meta">
                    {c.short} · {c.author} · {c.date}
                  </span>
                </div>
              ));
            })()}
        </div>
      </div>

      {contextMenu && (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

interface GitFileRowProps {
  file: GitFileStatus;
  actionIcon: IconAction;
  actionTitle: string;
  onAction: () => void;
  onOpen: () => void;
  /** Optional "discard changes" action (shown before the primary action). */
  onDiscard?: () => void;
  /** Right-click handler (issue #9): opens the Git context menu for this file. */
  onContextMenu?: (e: React.MouseEvent) => void;
  disabled: boolean;
}

function GitFileRow({
  file,
  actionIcon,
  actionTitle,
  onAction,
  onOpen,
  onDiscard,
  onContextMenu,
  disabled,
}: GitFileRowProps) {
  const b = badge(file);
  return (
    <div className="git-file-row" title={file.path} onContextMenu={onContextMenu}>
      <FileIcon path={file.path} className="git-file-icon" />
      <span className="git-file-name" onClick={onOpen}>
        {fileName(file.path)}
      </span>
      <span className="git-file-spacer" />
      {onDiscard && (
        <Tooltip label="Descartar alterações">
          <button
            className="git-file-action"
            aria-label="Descartar alterações"
            disabled={disabled}
            onClick={onDiscard}
          >
            <Codicon name="discard" />
          </button>
        </Tooltip>
      )}
      <Tooltip label={actionTitle}>
        <button
          className="git-file-action"
          aria-label={actionTitle}
          disabled={disabled}
          onClick={onAction}
        >
          <Codicon name={actionIcon} />
        </button>
      </Tooltip>
      <span className={`git-file-badge git-badge-${b.kind}`}>{b.letter}</span>
    </div>
  );
}
