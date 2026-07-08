import { useState } from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import type { BlameHunk, GitStatus } from "../types";
import { GitStatusItem } from "./GitStatusItem";
import { languageLabel } from "../language";
import type { GitRevisionDiffTarget } from "../api";
import {
  WorkspaceBranchStatus,
  type WorkspaceBranchStatusContext,
  type WorkspaceBranchStatusRoot,
} from "./status/WorkspaceBranchStatus";

/** Status of a single language server, surfaced in the status bar (ISSUE-28). */
export interface LspServerStatus {
  id: string;
  status: "starting" | "downloading" | "ready" | "error";
  error?: string;
  workspace?: {
    solutionPath?: string;
    projectCount: number;
    loaded: boolean;
  };
}

interface StatusBarProps {
  language: string;
  line: number;
  column: number;
  fileName: string | null;
  /** Current git branch of the open folder, or null when not a repo. */
  branch: string | null;
  /** Full git status (ahead/behind/conflicts) — drives the sync indicator. */
  gitStatus?: GitStatus | null;
  /** A git operation is running (spinner + disabled actions). */
  gitBusy?: boolean;
  /** Periodic background fetch is on. */
  autoFetch?: boolean;
  /** Epoch ms of the last successful fetch. */
  lastFetch?: number | null;
  /** Opens the branch picker (issue #16). Omitted ⇒ branch isn't clickable. */
  onClickBranch?: () => void;
  onGitSync?: () => void;
  onGitFetch?: () => void;
  onGitPull?: () => void;
  onGitPush?: () => void;
  onGitPublish?: () => void;
  onToggleAutoFetch?: () => void;
  /** `user@host` when attached to a remote SSH host (issue #8), else null. */
  remoteHost?: string | null;
  /** Visible workspace identity for multi-root Fluent workspaces. */
  workspaceContext?: WorkspaceBranchStatusContext | null;
  /** Opens the branch picker for a specific workspace root. */
  onSelectWorkspaceBranch?: (root: WorkspaceBranchStatusRoot) => void;
  /** Opens the connection-management menu (clicking the SSH chip when remote). */
  onManageRemote?: () => void;
  /** Opens a new remote connection (clicking the launcher when local). */
  onOpenRemote?: () => void;
  /** Editor tab size, reflected from the editor options. */
  tabSize: number;
  /** Live diagnostic counts from Monaco markers. */
  errorCount: number;
  warningCount: number;
  /** Active LSP servers and their state (empty when none running). */
  lspServers?: LspServerStatus[];
  /** Re-attempt starting a failed server (clicked in the status item). */
  onRestartLsp?: (serverId: string) => void;
  /** Opens the bottom panel on the Problems tab (clicking the diagnostic counts). */
  onShowProblems?: () => void;
  /** Opens the TypeScript version selector (project vs editor) for the TS server. */
  onSelectTsVersion?: () => void;
  /** Opens the language-mode picker for the active file (VS Code's "Change Language Mode"). */
  onSelectLanguage?: () => void;
  /** Git Fluent blame info for the current editor line. */
  currentLineBlame?: { hunk: BlameHunk; filePath: string } | null;
  /** Opens file history for the current line blame. */
  onOpenCurrentLineHistory?: (filePath: string, line?: number) => void;
  /** Opens the current line's file as it existed at the blamed commit. */
  onOpenCurrentLineRevision?: (
    filePath: string,
    commitHash: string,
    shortHash: string
  ) => void;
  /** Opens a diff for the current line's blamed commit. */
  onOpenCurrentLineRevisionDiff?: (
    filePath: string,
    commitHash: string,
    shortHash: string,
    compareTo: GitRevisionDiffTarget
  ) => void;
  /** Detected encoding of the active file (e.g. "UTF-8"); null when none open. */
  encoding?: string | null;
  /** Active file's line-ending style label ("LF"/"CRLF"); null when none open. */
  eol?: string | null;
  /** Opens the "Reopen/Save with Encoding" picker. Omitted ⇒ not clickable. */
  onSelectEncoding?: () => void;
  /** Opens the line-ending picker (LF/CRLF). Omitted ⇒ not clickable. */
  onSelectEol?: () => void;
}

/** Maps an LSP status to a codicon + label. */
const LSP_ICON: Record<LspServerStatus["status"], IconAction> = {
  starting: "loading",
  downloading: "loading",
  ready: "success",
  error: "error",
};
const LSP_LABEL: Record<LspServerStatus["status"], string> = {
  starting: "iniciando",
  downloading: "baixando",
  ready: "pronto",
  error: "erro",
};

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function blameAuthor(hunk: BlameHunk): string {
  return hunk.isCurrentUser ? "You" : hunk.author;
}

function blameShortHash(hunk: BlameHunk): string {
  return hunk.short || hunk.hash.slice(0, 7);
}

function initialsForAuthor(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function avatarStyle(author: string) {
  let hash = 0;
  for (const char of author) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { backgroundColor: `hsl(${hash % 360}, 58%, 48%)` };
}

export function StatusBar({
  language,
  line,
  column,
  fileName,
  branch,
  gitStatus,
  gitBusy,
  autoFetch,
  lastFetch,
  onClickBranch,
  onGitSync,
  onGitFetch,
  onGitPull,
  onGitPush,
  onGitPublish,
  onToggleAutoFetch,
  remoteHost,
  workspaceContext,
  onSelectWorkspaceBranch,
  onManageRemote,
  onOpenRemote,
  tabSize,
  errorCount,
  warningCount,
  lspServers,
  onRestartLsp,
  onShowProblems,
  onSelectTsVersion,
  onSelectLanguage,
  currentLineBlame,
  onOpenCurrentLineHistory,
  onOpenCurrentLineRevision,
  onOpenCurrentLineRevisionDiff,
  encoding,
  eol,
  onSelectEncoding,
  onSelectEol,
}: StatusBarProps) {
  // Friendly language name (VSCode-style), shared with the language-mode picker.
  const langDisplay = languageLabel(language);
  const hasWorkspaceContext = Boolean(workspaceContext);

  // The LSP actions menu (Restart, …) anchored above the clicked server item.
  const [lspMenu, setLspMenu] = useState<{
    server: LspServerStatus;
    x: number;
    y: number;
  } | null>(null);
  const [blameMenu, setBlameMenu] = useState<{ x: number; y: number } | null>(null);

  const closeBlameMenu = () => setBlameMenu(null);
  const runBlameAction = (action: () => void) => {
    action();
    closeBlameMenu();
  };

  return (
    <div className="status-bar">
      <div className="status-left">
        {remoteHost ? (
          <span
            className="status-item status-remote"
            title={`Conectado via SSH a ${remoteHost}.${
              onManageRemote ? "\nClique para gerenciar a conexão." : ""
            }`}
            // Kept as a span (not <button>): `.status-item` is a flex chip with no
            // native-button reset, so a real button would break the bar's layout.
            // We give it full keyboard parity instead (F2-AUD-016 / F2-AUD-008).
            role={onManageRemote ? "button" : undefined}
            tabIndex={onManageRemote ? 0 : undefined}
            aria-label={
              onManageRemote ? `Gerenciar conexão SSH com ${remoteHost}` : undefined
            }
            onClick={onManageRemote}
            onKeyDown={(e) => {
              if (onManageRemote && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onManageRemote();
              }
            }}
          >
            <Codicon name="remote" /> SSH: {remoteHost}
          </span>
        ) : onOpenRemote ? (
          // Always-present remote launcher (VS Code's bottom-left `><`): click to
          // open a remote (SSH) connection. Shows the local/neutral state.
          <span
            className="status-item status-remote-local"
            title="Abrir uma conexão remota (SSH)"
            aria-label="Abrir uma conexão remota"
            role="button"
            tabIndex={0}
            onClick={onOpenRemote}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenRemote();
              }
            }}
          >
            <Codicon name="remote" />
          </span>
        ) : null}
        {workspaceContext && (
          <WorkspaceBranchStatus
            workspace={workspaceContext}
            onSelectBranch={onSelectWorkspaceBranch}
          />
        )}
        {!hasWorkspaceContext && gitStatus?.isRepo ? (
          <GitStatusItem
            status={gitStatus}
            busy={!!gitBusy}
            autoFetch={!!autoFetch}
            lastFetch={lastFetch ?? null}
            onClickBranch={onClickBranch}
            onSync={onGitSync ?? (() => {})}
            onFetch={onGitFetch ?? (() => {})}
            onPull={onGitPull ?? (() => {})}
            onPush={onGitPush ?? (() => {})}
            onPublish={onGitPublish ?? (() => {})}
            onToggleAutoFetch={onToggleAutoFetch ?? (() => {})}
          />
        ) : !hasWorkspaceContext ? (
          branch && (
            <span
              className="status-item"
              onClick={onClickBranch}
              onKeyDown={
                onClickBranch
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onClickBranch();
                      }
                    }
                  : undefined
              }
              title={onClickBranch ? "Trocar de branch" : undefined}
              role={onClickBranch ? "button" : undefined}
              tabIndex={onClickBranch ? 0 : undefined}
              aria-label={onClickBranch ? `Branch ${branch}; trocar de branch` : undefined}
            >
              <Codicon name="gitBranch" /> {branch}
            </span>
          )
        ) : null}
        {currentLineBlame && (
          <span
            className={`status-item status-blame${
              onOpenCurrentLineHistory ? " status-clickable" : ""
            }`}
            title={`${blameAuthor(currentLineBlame.hunk)} · ${
              currentLineBlame.hunk.date
            }\n${currentLineBlame.hunk.short} ${currentLineBlame.hunk.subject}\nClique para abrir o histórico de ${baseName(
              currentLineBlame.filePath
            )}`}
            role={onOpenCurrentLineHistory ? "button" : undefined}
            tabIndex={onOpenCurrentLineHistory ? 0 : undefined}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setBlameMenu({ x: rect.left, y: rect.top });
            }}
            onKeyDown={
              onOpenCurrentLineHistory
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setBlameMenu({ x: rect.left, y: rect.top });
                    }
                  }
                : undefined
            }
          >
            <Codicon name="gitCommit" />
            <span>{blameAuthor(currentLineBlame.hunk)}</span>
            <span className="status-blame-date">{currentLineBlame.hunk.date}</span>
            <span className="status-blame-subject">{currentLineBlame.hunk.subject}</span>
          </span>
        )}
        <span
          className={`status-item status-diagnostics${
            onShowProblems ? " status-clickable" : ""
          }`}
          title={onShowProblems ? "Mostrar Problemas" : undefined}
          role={onShowProblems ? "button" : undefined}
          tabIndex={onShowProblems ? 0 : undefined}
          aria-label={
            onShowProblems
              ? `${errorCount} erros, ${warningCount} avisos; mostrar Problemas`
              : undefined
          }
          onClick={onShowProblems}
          onKeyDown={
            onShowProblems
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onShowProblems();
                  }
                }
              : undefined
          }
        >
          <span className="status-diag status-diag-error">
            <Codicon name="error" />
            {errorCount}
          </span>
          <span className="status-diag status-diag-warning">
            <Codicon name="warning" />
            {warningCount}
          </span>
        </span>
        {lspServers?.map((s) => (
          <span
            key={s.id}
            className={`status-item status-lsp status-lsp-${s.status} status-clickable`}
            title={`${s.id}: ${LSP_LABEL[s.status]} (clique para ações)`}
            role="button"
            tabIndex={0}
            aria-label={`${s.id}: ${LSP_LABEL[s.status]}; abrir ações do servidor`}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setLspMenu({ server: s, x: rect.left, y: rect.top });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setLspMenu({ server: s, x: rect.left, y: rect.top });
              }
            }}
          >
            <Codicon name={LSP_ICON[s.status]} /> {s.id}
          </span>
        ))}
        {lspServers
          ?.filter((server) => server.workspace)
          .map((server) => {
            const workspace = server.workspace!;
            const solution = workspace.solutionPath
              ? baseName(workspace.solutionPath)
              : "projetos C#";
            const projects =
              workspace.projectCount === 1
                ? "1 projeto"
                : `${workspace.projectCount} projetos`;

            return (
              <span
                key={`${server.id}-workspace`}
                className="status-item status-workspace"
                title={
                  workspace.solutionPath
                    ? `${workspace.solutionPath}\n${projects} ${
                        workspace.loaded ? "carregados" : "carregando"
                      }`
                    : projects
                }
              >
                <Codicon name={workspace.loaded ? "folderOpened" : "loading"} />
                {solution} · {projects}
              </span>
            );
          })}
      </div>
      <div className="status-right">
        {fileName && (
          <span className="status-item status-cursor">
            Ln {line}, Col {column}
          </span>
        )}
        {langDisplay && (
          <span
            className={`status-item status-language${
              onSelectLanguage ? " status-clickable" : ""
            }`}
            title={onSelectLanguage ? "Selecionar modo de linguagem" : undefined}
            role={onSelectLanguage ? "button" : undefined}
            tabIndex={onSelectLanguage ? 0 : undefined}
            aria-label={
              onSelectLanguage
                ? `Linguagem: ${langDisplay}; selecionar modo de linguagem`
                : undefined
            }
            onClick={onSelectLanguage}
            onKeyDown={
              onSelectLanguage
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectLanguage();
                    }
                  }
                : undefined
            }
          >
            {langDisplay}
          </span>
        )}
        {fileName && encoding && (
          <span
            className={`status-item status-encoding${
              onSelectEncoding ? " status-clickable" : ""
            }`}
            title={onSelectEncoding ? "Selecionar codificação" : undefined}
            role={onSelectEncoding ? "button" : undefined}
            tabIndex={onSelectEncoding ? 0 : undefined}
            aria-label={
              onSelectEncoding
                ? `Codificação: ${encoding}; selecionar codificação`
                : undefined
            }
            onClick={onSelectEncoding}
            onKeyDown={
              onSelectEncoding
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectEncoding();
                    }
                  }
                : undefined
            }
          >
            {encoding}
          </span>
        )}
        {fileName && eol && (
          <span
            className={`status-item status-eol${
              onSelectEol ? " status-clickable" : ""
            }`}
            title={onSelectEol ? "Selecionar fim de linha" : undefined}
            role={onSelectEol ? "button" : undefined}
            tabIndex={onSelectEol ? 0 : undefined}
            aria-label={
              onSelectEol ? `Fim de linha: ${eol}; selecionar fim de linha` : undefined
            }
            onClick={onSelectEol}
            onKeyDown={
              onSelectEol
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectEol();
                    }
                  }
                : undefined
            }
          >
            {eol}
          </span>
        )}
        {fileName && (
          <span className="status-item status-tabsize">Tab Size: {tabSize}</span>
        )}
      </div>

      {lspMenu &&
        createPortal(
          <>
            <div
              className="lsp-menu-overlay"
              onClick={() => setLspMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setLspMenu(null);
              }}
            />
            <div
              className="lsp-menu"
              style={{ left: lspMenu.x, top: lspMenu.y }}
              role="menu"
            >
            <div className="lsp-menu-title">
              <Codicon name={LSP_ICON[lspMenu.server.status]} />
              {lspMenu.server.id} · {LSP_LABEL[lspMenu.server.status]}
            </div>
            {lspMenu.server.status === "error" && lspMenu.server.error && (
              <div className="lsp-menu-error">{lspMenu.server.error}</div>
            )}
            <button
              type="button"
              className="lsp-menu-item"
              role="menuitem"
              onClick={() => {
                onRestartLsp?.(lspMenu.server.id);
                setLspMenu(null);
              }}
            >
              <Codicon name="restart" size={14} /> Reiniciar servidor
            </button>
            {lspMenu.server.id === "typescript" && onSelectTsVersion && (
              <button
                type="button"
                className="lsp-menu-item"
                role="menuitem"
                onClick={() => {
                  onSelectTsVersion();
                  setLspMenu(null);
                }}
              >
                <Codicon name="settings" size={14} /> Selecionar versão do TypeScript…
              </button>
            )}
            </div>
          </>,
          document.body
        )}
      {blameMenu &&
        currentLineBlame &&
        createPortal(
          <>
            <div
              className="status-menu-overlay"
              onClick={closeBlameMenu}
              onContextMenu={(e) => {
                e.preventDefault();
                closeBlameMenu();
              }}
            />
            <div
              className="status-blame-menu"
              style={{ left: blameMenu.x, top: blameMenu.y }}
              role="menu"
            >
              <div className="status-blame-menu-head">
                {currentLineBlame.hunk.avatarUrl ? (
                  <img
                    className="status-blame-menu-avatar"
                    src={currentLineBlame.hunk.avatarUrl}
                    alt=""
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className="status-blame-menu-avatar fallback"
                    style={avatarStyle(currentLineBlame.hunk.author)}
                    aria-hidden="true"
                  >
                    {initialsForAuthor(currentLineBlame.hunk.author)}
                  </span>
                )}
                <div className="status-blame-menu-identity">
                  <div>
                    <strong>{blameAuthor(currentLineBlame.hunk)}</strong>
                    <span>{currentLineBlame.hunk.date}</span>
                  </div>
                  <p>{currentLineBlame.hunk.subject || "Linha ainda não commitada."}</p>
                </div>
              </div>
              <div className="status-blame-menu-actions">
                <button
                  type="button"
                  className="status-blame-menu-action primary"
                  disabled={!currentLineBlame.hunk.hash}
                  onClick={() =>
                    runBlameAction(() =>
                      void navigator.clipboard?.writeText(currentLineBlame.hunk.hash)
                    )
                  }
                >
                  <Codicon name="gitCommit" size={13} />
                  {blameShortHash(currentLineBlame.hunk) || "sem commit"}
                </button>
                <button
                  type="button"
                  className="status-blame-menu-action"
                  disabled={!currentLineBlame.hunk.hash}
                  title="Copiar hash"
                  onClick={() =>
                    runBlameAction(() =>
                      void navigator.clipboard?.writeText(currentLineBlame.hunk.hash)
                    )
                  }
                >
                  <Codicon name="copy" size={13} />
                </button>
                <button
                  type="button"
                  className="status-blame-menu-action"
                  disabled={!currentLineBlame.hunk.hash || !onOpenCurrentLineRevision}
                  title="Abrir arquivo nesta revisão"
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineRevision?.(
                        currentLineBlame.filePath,
                        currentLineBlame.hunk.hash,
                        blameShortHash(currentLineBlame.hunk)
                      )
                    )
                  }
                >
                  <Codicon name="file" size={13} />
                </button>
                <button
                  type="button"
                  className="status-blame-menu-action"
                  disabled={!currentLineBlame.hunk.hash || !onOpenCurrentLineRevisionDiff}
                  title="Abrir alterações desta revisão"
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineRevisionDiff?.(
                        currentLineBlame.filePath,
                        currentLineBlame.hunk.hash,
                        blameShortHash(currentLineBlame.hunk),
                        "previous"
                      )
                    )
                  }
                >
                  <Codicon name="openChanges" size={13} />
                </button>
                <button
                  type="button"
                  className="status-blame-menu-action"
                  disabled={!currentLineBlame.hunk.hash || !onOpenCurrentLineRevisionDiff}
                  title="Comparar com arquivo atual"
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineRevisionDiff?.(
                        currentLineBlame.filePath,
                        currentLineBlame.hunk.hash,
                        blameShortHash(currentLineBlame.hunk),
                        "working"
                      )
                    )
                  }
                >
                  <Codicon name="compareWithSelected" size={13} />
                </button>
                <button
                  type="button"
                  className="status-blame-menu-action"
                  disabled={!currentLineBlame.hunk.remoteUrl}
                  title="Abrir commit remoto"
                  onClick={() =>
                    runBlameAction(() =>
                      window.open(currentLineBlame.hunk.remoteUrl, "_blank", "noopener,noreferrer")
                    )
                  }
                >
                  <Codicon name="remote" size={13} />
                </button>
              </div>
              <div className="status-blame-menu-details">
                <button
                  type="button"
                  className="status-blame-menu-row"
                  disabled={!currentLineBlame.hunk.line}
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineHistory?.(
                        currentLineBlame.filePath,
                        currentLineBlame.hunk.line
                      )
                    )
                  }
                >
                  <Codicon name="fileHistory" size={14} />
                  Abrir histórico da linha {currentLineBlame.hunk.line}
                </button>
                <button
                  type="button"
                  className="status-blame-menu-row"
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineHistory?.(currentLineBlame.filePath)
                    )
                  }
                >
                  <Codicon name="fileHistory" size={14} />
                  Abrir histórico de {baseName(currentLineBlame.filePath)}
                </button>
                <button
                  type="button"
                  className="status-blame-menu-row"
                  disabled={!currentLineBlame.hunk.hash || !onOpenCurrentLineRevisionDiff}
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineRevisionDiff?.(
                        currentLineBlame.filePath,
                        currentLineBlame.hunk.hash,
                        blameShortHash(currentLineBlame.hunk),
                        "previous"
                      )
                    )
                  }
                >
                  <Codicon name="openChanges" size={14} />
                  Open Changes with Previous Revision
                </button>
                <button
                  type="button"
                  className="status-blame-menu-row"
                  disabled={!currentLineBlame.hunk.hash || !onOpenCurrentLineRevisionDiff}
                  onClick={() =>
                    runBlameAction(() =>
                      onOpenCurrentLineRevisionDiff?.(
                        currentLineBlame.filePath,
                        currentLineBlame.hunk.hash,
                        blameShortHash(currentLineBlame.hunk),
                        "working"
                      )
                    )
                  }
                >
                  <Codicon name="compareWithSelected" size={14} />
                  Open Changes with Working File
                </button>
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
