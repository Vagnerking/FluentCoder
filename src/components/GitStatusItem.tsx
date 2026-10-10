import { useState } from "react";
import { Menu } from "./ui/Menu";
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
  // The sync menu, anchored above the chip that opened it (pressing the chip
  // again toggles it).
  const [menu, setMenu] = useState<{ rect: DOMRect; el: HTMLElement } | null>(null);

  const openMenu = (e: React.MouseEvent | React.KeyboardEvent) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    setMenu((m) => (m ? null : { rect, el }));
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
          onKeyDown={(event) => {
            if (!props.onClickBranch || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            props.onClickBranch();
          }}
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
            openMenu(e);
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

      {menu && (
        <Menu
          ariaLabel="Sincronização Git"
          className="git-actions-menu"
          anchor={{ rect: menu.rect, placement: "top-start" }}
          onClose={() => setMenu(null)}
          isInside={(t) => menu.el.contains(t)}
          minWidth={248}
          header={
            <>
              <span className="ui-menu-title">
                <Codicon name="gitBranch" /> {branch}
              </span>
              <span className="ui-menu-subtitle">
                {hasUpstream ? `↓ ${behind} para baixar · ↑ ${ahead} para enviar` : "sem upstream"}
              </span>
            </>
          }
          footer={lastFetch ? `Última busca ${relativeTime(lastFetch)}` : "Ainda não buscou"}
          items={[
            hasUpstream
              ? {
                  id: "sync",
                  label: "Sincronizar alterações",
                  icon: "sync",
                  tone: "accent",
                  disabled: busy,
                  onSelect: props.onSync,
                }
              : {
                  id: "publish",
                  label: "Publicar branch",
                  icon: "cloudUpload",
                  tone: "accent",
                  disabled: busy,
                  onSelect: props.onPublish,
                },
            {
              id: "pull",
              label: `Pull${behind > 0 ? ` (${behind})` : ""}`,
              icon: "gitPull",
              disabled: busy || !hasUpstream,
              onSelect: props.onPull,
            },
            {
              id: "push",
              label: `Push${ahead > 0 ? ` (${ahead})` : ""}`,
              icon: "gitPush",
              disabled: busy || !hasUpstream,
              onSelect: props.onPush,
            },
            {
              id: "fetch",
              label: "Fetch",
              icon: "refresh",
              disabled: busy,
              onSelect: props.onFetch,
            },
            { id: "sep", separator: true },
            {
              id: "auto-fetch",
              label: "Buscar automaticamente",
              checked: autoFetch,
              onSelect: props.onToggleAutoFetch,
            },
          ]}
        />
      )}
    </>
  );
}