import { useEffect, useMemo, useRef, useState } from "react";
import { listProjectFiles } from "../api";
import { useModalDismiss } from "./useModalDismiss";
import { rankFiles } from "../quickOpen/fuzzy";
import type { FileNode, OpenFile, ProjectFile } from "../types";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface QuickOpenProps {
  /** Workspace root to index, or null when no folder is open. */
  rootPath: string | null;
  /** All roots in a Fluent workspace. SSH roots are indexed when connected. */
  workspaceRoots?: QuickOpenWorkspaceRoot[];
  /** Opens the chosen file in a tab (reuses the editor's open handler). */
  onOpenFile: (node: FileNode) => void;
  /** Closes the palette. */
  onClose: () => void;
}

interface QuickOpenWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
  remote?: {
    host: string;
    user: string;
  };
  connId?: string;
  status?: "connected" | "connecting" | "error";
}

interface QuickOpenTarget {
  id: string;
  label: string;
  path: string;
  provider: "local" | "ssh";
  remote?: QuickOpenWorkspaceRoot["remote"];
  connId?: string;
}

type QuickOpenFile = ProjectFile & {
  rootId?: string;
  workspaceRemote?: OpenFile["workspaceRemote"];
};

/** How many results to render at once — the fuzzy match ranks everything, but
 *  painting thousands of rows is pointless and slow. */
const MAX_VISIBLE = 100;

/**
 * Splits a label into highlighted/plain runs from a set of matched indices,
 * so the matched letters can be bolded VSCode-style.
 */
function highlight(label: string, positions: number[]) {
  if (positions.length === 0) return label;
  const set = new Set(positions);
  const out: React.ReactNode[] = [];
  let run = "";
  let matchRun = "";
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) {
      if (run) {
        out.push(run);
        run = "";
      }
      matchRun += label[i];
    } else {
      if (matchRun) {
        out.push(
          <span key={i} className="quick-open-match">
            {matchRun}
          </span>
        );
        matchRun = "";
      }
      run += label[i];
    }
  }
  if (matchRun) out.push(<span className="quick-open-match">{matchRun}</span>);
  if (run) out.push(run);
  return out;
}

/**
 * Quick Open palette (Ctrl+P). A floating, centered overlay that fuzzy-searches
 * the project's files by name and opens the selected one on Enter. The file
 * index comes from the Rust `list_project_files` command; ranking is done by
 * the pure matcher in `quickOpen/fuzzy`.
 */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function QuickOpen({
  rootPath,
  workspaceRoots = [],
  onOpenFile,
  onClose,
}: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<QuickOpenFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const targets = useMemo<QuickOpenTarget[]>(() => {
    const workspaceTargets = workspaceRoots
      .filter((root) => root.provider === "local" || root.connId)
      .map((root) => ({
        id: root.id,
        label: root.name || baseName(root.path),
        path: root.path,
        provider: root.provider,
        remote: root.remote,
        connId: root.connId,
      }));
    if (workspaceTargets.length > 0) return workspaceTargets;
    if (!rootPath) return [];
    return [{ id: "root", label: baseName(rootPath), path: rootPath, provider: "local" }];
  }, [rootPath, workspaceRoots]);

  // Build the index once when the palette opens; focus the input.
  useEffect(() => {
    inputRef.current?.focus();
    if (targets.length === 0) {
      setFiles([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const all: QuickOpenFile[] = [];
      for (const target of targets) {
        try {
          const list = await listProjectFiles(target.path, target.connId);
          if (cancelled) return;
          const workspaceRemote =
            target.provider === "ssh" && target.connId && target.remote
              ? {
                  folderId: target.id,
                  connId: target.connId,
                  host: target.remote.host,
                  user: target.remote.user,
                  rootPath: target.path,
                }
              : undefined;
          const filesForRoot = list.map((file) => ({
            ...file,
            rootId: target.id,
            rel: targets.length > 1 ? `${target.label}/${file.rel}` : file.rel,
            workspaceRemote,
          }));
          all.push(...filesForRoot);
        } catch (err) {
          console.error(err);
        }
      }
      if (!cancelled) setFiles(all);
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [targets]);

  const ranked = useMemo(() => rankFiles(query, files), [query, files]);
  const visible = ranked.slice(0, MAX_VISIBLE);

  // Keep the selection in range whenever the result set changes.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function openAt(index: number) {
    const hit = visible[index];
    if (!hit) return;
    const file = hit.file as QuickOpenFile;
    onOpenFile({
      name: file.name,
      path: file.path,
      isDir: false,
      workspaceRemote: file.workspaceRemote,
    });
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (visible.length ? (s + 1) % visible.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        visible.length ? (s - 1 + visible.length) % visible.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      openAt(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="quick-open-backdrop" {...useModalDismiss(onClose)}>
      <div className="quick-open">
        <div className="quick-pick-title">Ir para arquivo</div>
        <input
          ref={inputRef}
          className="quick-open-input"
          type="text"
          placeholder={
            targets.length > 0
              ? "Digite o nome de um arquivo…"
              : "Abra uma pasta ou workspace primeiro"
          }
          value={query}
          aria-label="Quick Open: pesquisar arquivos por nome"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="quick-open-list" role="listbox" ref={listRef}>
          {visible.length === 0 ? (
            <div className="quick-open-empty">
              {targets.length === 0
                ? "Abra uma pasta ou workspace para pesquisar arquivos."
                : loading
                  ? "Carregando arquivos…"
                  : query.trim()
                  ? "Nenhum arquivo encontrado."
                  : "Nenhum arquivo."}
            </div>
          ) : (
            visible.map((hit, i) => (
              <div
                key={`${(hit.file as QuickOpenFile).rootId ?? "root"}:${hit.file.path}`}
                role="option"
                aria-selected={i === selected}
                className={
                  "quick-open-item" + (i === selected ? " selected" : "")
                }
                title={hit.file.path}
                onMouseMove={() => setSelected(i)}
                onClick={() => openAt(i)}
              >
                <FileIcon path={hit.file.path} className="quick-open-icon" />
                <span className="quick-open-name">
                  {highlight(hit.file.name, hit.positions)}
                </span>
                <span className="quick-open-path">{hit.file.rel}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
