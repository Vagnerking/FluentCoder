import { useState } from "react";
import { createPortal } from "react-dom";
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
  tabSize,
  errorCount,
  warningCount,
  lspServers,
  onRestartLsp,
  onShowProblems,
  onSelectTsVersion,
}: StatusBarProps) {
  // Friendly language names (VSCode-style) so the status bar reads nicely —
  // e.g. "ASP.NET Razor" instead of the raw id "aspnetcorerazor".
  const LANGUAGE_LABELS: Record<string, string> = {
    aspnetcorerazor: "ASP.NET Razor",
    csharp: "C#",
    typescript: "TypeScript",
    typescriptreact: "TypeScript JSX",
    javascript: "JavaScript",
    javascriptreact: "JavaScript JSX",
    cpp: "C++",
    css: "CSS",
    scss: "SCSS",
    less: "Less",
    html: "HTML",
    json: "JSON",
    yaml: "YAML",
    dockerfile: "Dockerfile",
    shell: "Shell Script",
  };
  const langDisplay = language
    ? (LANGUAGE_LABELS[language] ??
        language.charAt(0).toUpperCase() + language.slice(1))
    : "";

  // The LSP actions menu (Restart, …) anchored above the clicked server item.
  const [lspMenu, setLspMenu] = useState<{
    server: LspServerStatus;
    x: number;
    y: number;
  } | null>(null);

  return (
    <div className="status-bar">
      <div className="status-left">
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
          <span className="status-item">
            Ln {line}, Col {column}
          </span>
        )}
        {langDisplay && <span className="status-item">{langDisplay}</span>}
        {fileName && <span className="status-item">UTF-8</span>}
        {fileName && <span className="status-item">Tab Size: {tabSize}</span>}
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
