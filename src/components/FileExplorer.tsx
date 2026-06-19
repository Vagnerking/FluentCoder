import { useEffect, useMemo, useState } from "react";
import { createFile, createFolder } from "../api";
import type { FileNode, FileDecoration } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import {
  ExplorerInlineCreation,
  type PendingCreation,
} from "./ExplorerInlineCreation";
import { TreeNode } from "./TreeNode";

interface FileExplorerProps {
  rootName: string | null;
  rootPath: string | null;
  roots: FileNode[];
  activePath: string | null;
  onOpenFolder: () => void;
  onOpenFile: (node: FileNode) => void;
  onRefreshRoot: () => Promise<void>;
  decorationFor?: (path: string) => FileDecoration | undefined;
}

export function FileExplorer({
  rootName,
  rootPath,
  roots,
  activePath,
  onOpenFolder,
  onOpenFile,
  onRefreshRoot,
  decorationFor = () => undefined,
}: FileExplorerProps) {
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(rootPath);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pending, setPending] = useState<PendingCreation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setSelectedDirectory(rootPath);
    setExpandedPaths(new Set());
    setPending(null);
    setError(null);
  }, [rootPath]);

  const hasExpandedFolders = expandedPaths.size > 0;
  const actionsDisabled = !rootPath || busy;
  const targetDirectory = selectedDirectory ?? rootPath;

  const actionButtons = useMemo(
    () => [
      { action: "newFile" as const, label: "Novo arquivo", kind: "file" as const },
      { action: "newFolder" as const, label: "Nova pasta", kind: "folder" as const },
    ],
    []
  );

  function beginCreation(kind: PendingCreation["kind"]) {
    if (!targetDirectory) return;
    setPending({ kind, parentPath: targetDirectory });
    setError(null);
    if (targetDirectory !== rootPath) {
      setExpandedPaths((current) => new Set(current).add(targetDirectory));
    }
  }

  async function submitCreation(name: string) {
    if (!rootPath || !pending || busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Informe um nome.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created =
        pending.kind === "file"
          ? await createFile(rootPath, pending.parentPath, trimmed)
          : await createFolder(rootPath, pending.parentPath, trimmed);
      await onRefreshRoot();
      setRefreshVersion((value) => value + 1);
      setPending(null);
      setStatus(pending.kind === "file" ? "Arquivo criado." : "Pasta criada.");
      if (created.isDir) {
        setSelectedDirectory(created.path);
        setExpandedPaths((current) => new Set(current).add(created.path));
      } else {
        onOpenFile(created);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!rootPath || busy) return;
    setBusy(true);
    setStatus("Atualizando explorador…");
    try {
      await onRefreshRoot();
      setRefreshVersion((value) => value + 1);
      setStatus("Explorador atualizado.");
    } catch (cause) {
      setStatus(`Não foi possível atualizar o explorador: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  function collapseAll() {
    setExpandedPaths(new Set());
    setStatus("Pastas recolhidas.");
  }

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span className="explorer-title" title={rootName ?? "EXPLORADOR"}>
          {rootName ?? "EXPLORADOR"}
        </span>
        {rootPath ? (
          <div className="explorer-actions" role="toolbar" aria-label="Ações do explorador">
            {actionButtons.map(({ action, label, kind }) => (
              <button
                key={action}
                className="explorer-action"
                title={label}
                aria-label={label}
                disabled={actionsDisabled}
                onClick={() => beginCreation(kind)}
              >
                <Codicon name={action} size={16} />
              </button>
            ))}
            <button
              className="explorer-action"
              title="Atualizar explorador"
              aria-label="Atualizar explorador"
              disabled={actionsDisabled}
              onClick={refresh}
            >
              <Codicon name="refresh" size={16} spin={busy} />
            </button>
            <button
              className="explorer-action"
              title="Recolher pastas"
              aria-label="Recolher pastas"
              disabled={actionsDisabled || !hasExpandedFolders}
              onClick={collapseAll}
            >
              <Codicon name="collapseAll" size={16} />
            </button>
          </div>
        ) : (
          <button className="explorer-open-btn" onClick={onOpenFolder} title="Abrir pasta">
            Abrir pasta
          </button>
        )}
      </div>

      <div className="explorer-status" aria-live="polite">
        {status}
      </div>

      <div className="explorer-tree">
        {!rootPath ? (
          <div className="explorer-empty">
            Nenhuma pasta aberta.
            <br />
            <button className="link-btn" onClick={onOpenFolder}>
              Abrir uma pasta
            </button>
          </div>
        ) : (
          <>
            {pending?.parentPath === rootPath && (
              <ExplorerInlineCreation
                kind={pending.kind}
                depth={0}
                busy={busy}
                error={error}
                onSubmit={submitCreation}
                onCancel={() => setPending(null)}
              />
            )}
            {roots.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                selectedDirectory={selectedDirectory}
                expandedPaths={expandedPaths}
                refreshVersion={refreshVersion}
                pendingCreation={pending}
                creationBusy={busy}
                creationError={error}
                onSelectDirectory={setSelectedDirectory}
                onToggleDirectory={(path) =>
                  setExpandedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                onOpenFile={onOpenFile}
                onSubmitCreation={submitCreation}
                onCancelCreation={() => setPending(null)}
                decorationFor={decorationFor}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
