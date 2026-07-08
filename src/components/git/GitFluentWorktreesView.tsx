import type { MouseEvent } from "react";
import type { GitWorktreeInfo } from "../../types";
import { Codicon } from "../../icons/codicons/Codicon";
import { Tooltip } from "../Tooltip";

interface GitFluentWorktreesViewProps {
  worktrees: GitWorktreeInfo[];
  busy: boolean;
  canOpenWorktreeInCurrentWindow: boolean;
  formatPath: (path: string) => string;
  onOpenWorktreeMenu: (event: MouseEvent, worktree: GitWorktreeInfo) => void;
  onOpenWorktreeInCurrentWindow: (worktree: GitWorktreeInfo) => void;
}

export function GitFluentWorktreesView({
  worktrees,
  busy,
  canOpenWorktreeInCurrentWindow,
  formatPath,
  onOpenWorktreeMenu,
  onOpenWorktreeInCurrentWindow,
}: GitFluentWorktreesViewProps) {
  return (
    <div className="git-fluent-list" role="tabpanel">
      {worktrees.length === 0 ? (
        <div className="git-fluent-empty">Nenhuma worktree vinculada.</div>
      ) : (
        <div className="git-worktree-list" role="tree" aria-label="Worktrees">
          <div className="git-ref-section-header">
            <span>
              <Codicon name="gitWorktree" size={12} />
              Worktrees
            </span>
            <small>{worktrees.length}</small>
          </div>
          {worktrees.map((worktree) => {
            const branchLabel = worktree.detached
              ? "HEAD detached"
              : worktree.branch || (worktree.bare ? "bare" : "sem branch");
            const shortHead = worktree.head ? worktree.head.slice(0, 7) : null;
            return (
              <div
                key={`fluent-worktree-${worktree.path}`}
                role="treeitem"
                tabIndex={0}
                className={`git-worktree-row${worktree.current ? " current" : ""}${worktree.detached ? " detached" : ""}`}
                title={`${worktree.path}${shortHead ? `\nHEAD ${shortHead}` : ""}`}
                onContextMenu={(event) => onOpenWorktreeMenu(event, worktree)}
              >
                <Codicon name={worktree.current ? "success" : worktree.detached ? "gitCommit" : "gitWorktree"} size={13} />
                <div className="git-worktree-main">
                  <span className="git-worktree-branch">{branchLabel}</span>
                  <span className="git-worktree-path">{formatPath(worktree.path)}</span>
                </div>
                {shortHead && <code className="git-worktree-head">{shortHead}</code>}
                <div className="git-worktree-flags">
                  {worktree.current && <span className="git-worktree-flag current">Atual</span>}
                  {worktree.detached && <span className="git-worktree-flag">Detached</span>}
                  {worktree.bare && <span className="git-worktree-flag">Bare</span>}
                </div>
                <span className="git-worktree-actions">
                  <Tooltip label={canOpenWorktreeInCurrentWindow ? "Abrir nesta janela" : "Abrir indisponível em SSH"}>
                    <button
                      type="button"
                      className="git-file-action"
                      aria-label="Abrir worktree nesta janela"
                      disabled={busy || !canOpenWorktreeInCurrentWindow}
                      onClick={() => onOpenWorktreeInCurrentWindow(worktree)}
                    >
                      <Codicon name="openWith" size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip label="Mais ações">
                    <button
                      type="button"
                      className="git-file-action"
                      aria-label={`Mais ações para ${branchLabel}`}
                      onClick={(event) => onOpenWorktreeMenu(event, worktree)}
                    >
                      <Codicon name="filterFiles" size={13} />
                    </button>
                  </Tooltip>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
