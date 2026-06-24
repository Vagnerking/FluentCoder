import { useState } from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";
import type { GitStatus } from "../types";
import { GitStatusItem } from "./GitStatusItem";
import { languageLabel } from "../language";

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
}: StatusBarProps) {
  // Friendly language name (VSCode-style), shared with the language-mode picker.
  const langDisplay = languageLabel(language);

  // The LSP actions menu (Restart, …) anchored above the clicked server item.
  const [lspMenu, setLspMenu] = useState<{
    server: LspServerStatus;
    x: number;
    y: number;
  } | null>(null);

  return (
    <div className="status-bar">
      <div className="status-left">
        {remoteHost ? (
          <span
            className="status-item status-remote"
            title={`Conectado via SSH a ${remoteHost}.\nClique para gerenciar a conexão.`}
            role={onManageRemote ? "button" : undefined}
            tabIndex={onManageRemote ? 0 : undefined}
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
        {gitStatus?.isRepo ? (
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
        ) : (
          branch && (
            <span
              className="status-item"
              onClick={onClickBranch}
              title={onClickBranch ? "Trocar de branch" : undefined}
              role={onClickBranch ? "button" : undefined}
            >
              <Codicon name="gitBranch" /> {branch}
            </span>
          )
        )}
        <span
          className={`status-item status-diagnostics${
            onShowProblems ? " status-clickable" : ""
          }`}
          title={onShowProblems ? "Mostrar Problemas" : undefined}
          role={onShowProblems ? "button" : undefined}
          tabIndex={onShowProblems ? 0 : undefined}
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
        {fileName && <span className="status-item status-encoding">UTF-8</span>}
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
    </div>
  );
}
