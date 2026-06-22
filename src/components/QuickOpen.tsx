import { useEffect, useMemo, useRef, useState } from "react";
import { listProjectFiles } from "../api";
import { useModalDismiss } from "./useModalDismiss";
import { rankFiles } from "../quickOpen/fuzzy";
import type { FileNode, ProjectFile } from "../types";
import { FileIcon } from "../icon-theme/material/FileIcon";

interface QuickOpenProps {
  /** Workspace root to index, or null when no folder is open. */
  rootPath: string | null;
  /** Opens the chosen file in a tab (reuses the editor's open handler). */
  onOpenFile: (node: FileNode) => void;
  /** Closes the palette. */
  onClose: () => void;
}

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
export function QuickOpen({ rootPath, onOpenFile, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build the index once when the palette opens; focus the input.
  useEffect(() => {
    inputRef.current?.focus();
    if (!rootPath) return;
    let cancelled = false;
    listProjectFiles(rootPath)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

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
    onOpenFile({ name: hit.file.name, path: hit.file.path, isDir: false });
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
            rootPath ? "Digite o nome de um arquivo…" : "Abra uma pasta primeiro"
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
              {!rootPath
                ? "Abra uma pasta para pesquisar arquivos."
                : query.trim()
                  ? "Nenhum arquivo encontrado."
                  : "Nenhum arquivo."}
            </div>
          ) : (
            visible.map((hit, i) => (
              <div
                key={hit.file.path}
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
