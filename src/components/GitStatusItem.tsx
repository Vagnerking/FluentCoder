import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Codicon } from "../icons/codicons/Codicon";
import type { GitStatus } from "../types";

export interface GitStatusItemProps {
  status: GitStatus;
  /** A git op (sync/pull/push/fetch) is running → spinner + disabled. */
  busy: boolean;
  /** Auto-fetch enabled (periodic background fetch). */
  autoFetch: boolean;
  /** Epoch ms of the last successful fetch, or null. */
  lastFetch: number | null;
  onClickBranch?: () => void;
  onSync: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onPublish: () => void;
  onToggleAutoFetch: () => void;
}

/** "há X" relative time for the last-fetch hint. */
function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "agora há pouco";
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

/**
 * VS Code-style Git indicator for the status bar — branch + sync state. Shows
 * ahead/behind counts, a publish action for unpublished branches, a conflict
 * badge during a merge/rebase, and a spinner while syncing. Clicking the sync
 * chip opens a premium actions menu (Sync / Pull / Push / Fetch / Publish +
 * an auto-fetch toggle and the last-fetch time).
 */
export function GitStatusItem(props: GitStatusItemProps) {
  const { status, busy, autoFetch, lastFetch } = props;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.top });
  };
  const run = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  const { ahead, behind, hasUpstream, conflicted, branch } = status;
  const synced = hasUpstream && ahead === 0 && behind === 0 && !busy;

  // Rich tooltip describing the exact sync state + last fetch.
  const syncTitle = busy
    ? "Sincronizando…"
    : !hasUpstream
      ? `A branch "${branch}" ainda não foi publicada.\nClique para publicar e definir o upstream.`
      : `${behind} para baixar · ${ahead} para enviar` +
        (lastFetch ? `\nBuscado ${relativeTime(lastFetch)}` : "") +
        "\nClique para opções de sincronização.";

  return (
    <>
      {branch && (
        <span
          className="status-item status-git-branch"
          onClick={props.onClickBranch}
          title={props.onClickBranch ? `Branch: ${branch}\nClique para trocar de branch` : undefined}
          role={props.onClickBranch ? "button" : undefined}
          tabIndex={props.onClickBranch ? 0 : undefined}
        >
          <Codicon name="gitBranch" /> {branch}
          {conflicted > 0 && (
            <span className="status-git-conflict" title={`${conflicted} arquivo(s) em conflito`}>
              <Codicon name="warning" />
              {conflicted}
            </span>
          )}
        </span>
      )}

      <span
        className={`status-item status-git-sync${synced ? " synced" : ""}`}
        onClick={openMenu}
        title={syncTitle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu(e as unknown as React.MouseEvent);
          }
        }}
      >
        {busy ? (
          <Codicon name="sync" spin />
        ) : !hasUpstream ? (
          <>
            <Codicon name="cloudUpload" /> Publicar
          </>
        ) : (
          <>
            <span className="status-git-count">
              <Codicon name="gitPull" />
              {behind}
            </span>
            <span className="status-git-count">
              <Codicon name="gitPush" />
              {ahead}
            </span>
            <Codicon name="sync" />
          </>
        )}
      </span>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="git-actions-menu"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
          >
            <div className="git-actions-title">
              <Codicon name="gitBranch" /> {branch}
              <span className="git-actions-sub">
                {hasUpstream ? `↓ ${behind}  ↑ ${ahead}` : "sem upstream"}
              </span>
            </div>

            {hasUpstream ? (
              <button
                type="button"
                className="git-actions-item primary"
                role="menuitem"
                disabled={busy}
                onClick={run(props.onSync)}
              >
                <Codicon name="sync" /> Sincronizar alterações
              </button>
            ) : (
              <button
                type="button"
                className="git-actions-item primary"
                role="menuitem"
                disabled={busy}
                onClick={run(props.onPublish)}
              >
                <Codicon name="cloudUpload" /> Publicar branch
              </button>
            )}

            <button
              type="button"
              className="git-actions-item"
              role="menuitem"
              disabled={busy || !hasUpstream}
              onClick={run(props.onPull)}
            >
              <Codicon name="gitPull" /> Pull{behind > 0 ? ` (${behind})` : ""}
            </button>
            <button
              type="button"
              className="git-actions-item"
              role="menuitem"
              disabled={busy || !hasUpstream}
              onClick={run(props.onPush)}
            >
              <Codicon name="gitPush" /> Push{ahead > 0 ? ` (${ahead})` : ""}
            </button>
            <button
              type="button"
              className="git-actions-item"
              role="menuitem"
              disabled={busy}
              onClick={run(props.onFetch)}
            >
              <Codicon name="refresh" /> Fetch
            </button>

            <div className="git-actions-sep" />

            <button
              type="button"
              className="git-actions-item toggle"
              role="menuitemcheckbox"
              aria-checked={autoFetch}
              onClick={run(props.onToggleAutoFetch)}
            >
              <Codicon name={autoFetch ? "success" : "close"} />
              Buscar automaticamente
              <span className="git-actions-state">{autoFetch ? "ligado" : "desligado"}</span>
            </button>
            <div className="git-actions-footer">
              {lastFetch ? `Última busca ${relativeTime(lastFetch)}` : "Ainda não buscou"}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
