import { Codicon } from "../icons/codicons/Codicon";
import type { IconAction } from "../icons/codicons/codicon-map";

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
  /** Opens the branch picker (issue #16). Omitted ⇒ branch isn't clickable. */
  onClickBranch?: () => void;
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
  onClickBranch,
  remoteHost,
  onManageRemote,
  onOpenRemote,
  tabSize,
  errorCount,
  warningCount,
  lspServers,
  onRestartLsp,
}: StatusBarProps) {
  const langDisplay = language
    ? language.charAt(0).toUpperCase() + language.slice(1)
    : "";

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
        {branch && (
          <span
            className="status-item"
            onClick={onClickBranch}
            title={onClickBranch ? "Trocar de branch" : undefined}
            role={onClickBranch ? "button" : undefined}
          >
            <Codicon name="gitBranch" /> {branch}
          </span>
        )}
        <span className="status-item">
          <Codicon name="error" /> {errorCount}&nbsp;&nbsp;
          <Codicon name="warning" /> {warningCount}
        </span>
        {lspServers?.map((s) => (
          <span
            key={s.id}
            className={`status-item status-lsp status-lsp-${s.status}`}
            title={
              s.status === "error"
                ? `${s.id}: ${s.error ?? "erro"} (clique para tentar de novo)`
                : `${s.id}: ${LSP_LABEL[s.status]}`
            }
            onClick={
              s.status === "error" && onRestartLsp
                ? () => onRestartLsp(s.id)
                : undefined
            }
            style={s.status === "error" && onRestartLsp ? { cursor: "pointer" } : undefined}
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
          <span className="status-item">
            Ln {line}, Col {column}
          </span>
        )}
        {langDisplay && <span className="status-item">{langDisplay}</span>}
        {fileName && <span className="status-item">UTF-8</span>}
        {fileName && <span className="status-item">Tab Size: {tabSize}</span>}
      </div>
    </div>
  );
}
