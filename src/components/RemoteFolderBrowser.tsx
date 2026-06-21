import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { sshCanonicalize, sshListDir } from "../api";
import { Codicon } from "../icons/codicons/Codicon";
import { useModalDismiss } from "./useModalDismiss";
import type { FileNode } from "../types";

interface RemoteFolderBrowserProps {
  connId: string;
  /** `user@host`, shown in the header for context. */
  target: string;
  /** Where to start browsing (`.` = the remote home directory). */
  initialPath?: string;
  /** Called with the chosen absolute remote path. */
  onPick: (path: string) => void;
  /** Closes the browser without picking (caller disconnects). */
  onCancel: () => void;
}

/** Parent of a POSIX path (`/a/b` → `/a`, `/a` → `/`). */
function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return "/";
  return trimmed.slice(0, i);
}

/** Last segment of a POSIX path (`/a/b` → `b`). */
function basenameOf(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? clean : clean.slice(i + 1) || "/";
}

/** Breadcrumb segments for a POSIX path: root first, then each folder. */
function crumbsOf(path: string): { label: string; path: string }[] {
  const clean = path.replace(/\/+$/, "");
  const crumbs = [{ label: "/", path: "/" }];
  if (clean === "" || clean === "/" || clean === ".") return crumbs;
  let acc = "";
  for (const part of clean.split("/").filter(Boolean)) {
    acc += "/" + part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/**
 * Remote folder browser (issue #8). After connecting, the user navigates the
 * host's filesystem and picks the folder to open — with a clickable breadcrumb,
 * keyboard navigation (↑/↓, Enter to enter, Backspace to go up, Esc to cancel),
 * and a Fluent-styled list. Lists directories over SFTP via the connection id.
 */
export function RemoteFolderBrowser({
  connId,
  target,
  initialPath = ".",
  onPick,
  onCancel,
}: RemoteFolderBrowserProps) {
  const [path, setPath] = useState<string>("");
  const [dirs, setDirs] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const list = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError(null);
      try {
        const entries = await sshListDir(connId, dir);
        const onlyDirs = entries
          .filter((e) => e.isDir && !e.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name));
        setDirs(onlyDirs);
        setPath(dir);
        setSelected(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [connId]
  );

  // Resolve the start path to an absolute one, then list it.
  useEffect(() => {
    let cancelled = false;
    sshCanonicalize(connId, initialPath)
      .then((abs) => {
        if (!cancelled) void list(abs || "/");
      })
      .catch(() => {
        if (!cancelled) void list(initialPath);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, initialPath, list]);

  const atRoot = path === "/" || path === "";
  const rowCount = (atRoot ? 0 : 1) + dirs.length;

  // Keep the list focused for keyboard nav, and keep the selection in range +
  // scrolled into view.
  useEffect(() => {
    if (!loading) listRef.current?.focus();
  }, [loading, path]);
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, rowCount - 1)));
  }, [rowCount]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function activate(index: number) {
    if (!atRoot && index === 0) {
      void list(parentOf(path));
      return;
    }
    const dir = dirs[index - (atRoot ? 0 : 1)];
    if (dir) void list(dir.path);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (rowCount ? (s + 1) % rowCount : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (rowCount ? (s - 1 + rowCount) % rowCount : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    } else if (e.key === "Backspace" && !atRoot) {
      e.preventDefault();
      void list(parentOf(path));
    }
  }

  const crumbs = crumbsOf(path);
  const pickLabel = atRoot ? "esta pasta" : basenameOf(path);

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onCancel)}>
      <div
        className="ssh-card ssh-browser"
        role="dialog"
        aria-label="Escolher pasta remota"
        onKeyDown={onKeyDown}
      >
        <header className="ssh-head">
          <span className="ssh-head-badge">
            <Codicon name="remote" />
          </span>
          <div className="ssh-head-text">
            <span className="ssh-head-title">Abrir pasta remota</span>
            <span className="ssh-head-sub">{target}</span>
          </div>
        </header>

        <nav className="ssh-crumbs" aria-label="Caminho atual">
          {crumbs.map((c, i) => (
            <Fragment key={c.path}>
              {i > 0 && (
                <Codicon name="chevronRight" className="ssh-crumb-sep" />
              )}
              <button
                type="button"
                className={
                  "ssh-crumb" + (i === crumbs.length - 1 ? " current" : "")
                }
                title={c.path}
                onClick={() => void list(c.path)}
              >
                {i === 0 ? <Codicon name="remote" /> : c.label}
              </button>
            </Fragment>
          ))}
        </nav>

        <div
          className="ssh-browser-list"
          role="listbox"
          tabIndex={0}
          ref={listRef}
          aria-label="Subpastas"
          aria-activedescendant={`ssh-row-${selected}`}
        >
          {loading ? (
            <div className="ssh-browser-status">
              <Codicon name="loading" /> Carregando…
            </div>
          ) : error ? (
            <div className="ssh-browser-status ssh-browser-error">
              <Codicon name="error" /> {error}
            </div>
          ) : (
            <>
              {!atRoot && (
                <div
                  id="ssh-row-0"
                  data-row={0}
                  role="option"
                  aria-selected={selected === 0}
                  className={
                    "ssh-browser-item up" + (selected === 0 ? " selected" : "")
                  }
                  onMouseMove={() => setSelected(0)}
                  onClick={() => void list(parentOf(path))}
                >
                  <Codicon name="arrowUp" className="ssh-browser-item-icon" />
                  <span className="ssh-browser-item-name">Pasta acima</span>
                </div>
              )}
              {dirs.length === 0 ? (
                <div className="ssh-browser-status">Nenhuma subpasta aqui.</div>
              ) : (
                dirs.map((d, i) => {
                  const row = i + (atRoot ? 0 : 1);
                  return (
                    <div
                      key={d.path}
                      id={`ssh-row-${row}`}
                      data-row={row}
                      role="option"
                      aria-selected={selected === row}
                      className={
                        "ssh-browser-item" + (selected === row ? " selected" : "")
                      }
                      title={d.path}
                      onMouseMove={() => setSelected(row)}
                      onClick={() => void list(d.path)}
                    >
                      <Codicon name="folder" className="ssh-browser-item-icon" />
                      <span className="ssh-browser-item-name">{d.name}</span>
                      <Codicon
                        name="chevronRight"
                        className="ssh-browser-chevron"
                      />
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        <div className="ssh-browser-footer">
          <span className="ssh-browser-footer-info">
            {loading || error
              ? ""
              : `${dirs.length} ${dirs.length === 1 ? "subpasta" : "subpastas"}`}
          </span>
          <div className="ssh-dialog-actions">
            <button type="button" className="ssh-dialog-cancel" onClick={onCancel}>
              Cancelar
            </button>
            <button
              type="button"
              className="ssh-dialog-connect"
              disabled={loading || !!error}
              onClick={() => onPick(path)}
            >
              Abrir {pickLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
