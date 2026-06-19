import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  copyPath,
  copyTextToClipboard,
  createFile,
  createFolder,
  deleteToTrash,
  movePath,
  renamePath,
  revealInExplorer,
} from "../api";
import type { ContextMenuItem, FileNode, FileDecoration } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import {
  ExplorerInlineCreation,
  type PendingCreation,
} from "./ExplorerInlineCreation";
import { TreeNode } from "./TreeNode";
import { TreeContextMenu } from "./TreeContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";

/** Internal cut/copy clipboard for explorer file operations (not the OS one). */
export interface FileClipboard {
  path: string;
  mode: "cut" | "copy";
}

/** A path currently being renamed inline, plus whether it's a directory. */
interface RenameTarget {
  path: string;
  name: string;
  isDir: boolean;
}

interface FileExplorerProps {
  rootName: string | null;
  rootPath: string | null;
  roots: FileNode[];
  activePath: string | null;
  onOpenFile: (node: FileNode) => void;
  onRefreshRoot: () => Promise<void>;
  decorationFor?: (path: string) => FileDecoration | undefined;
  /** Notifies the host that a path was renamed, so it can re-point open tabs. */
  onPathRenamed?: (oldPath: string, newPath: string, isDir: boolean) => void;
  /** Notifies the host that a path was deleted, so it can close affected tabs. */
  onPathDeleted?: (path: string, isDir: boolean) => void;
  /** Opens/focuses the integrated terminal with the given working directory. */
  onOpenTerminalAt?: (cwd: string) => void;
  /** Opens/focuses the search panel scoped to the given folder. */
  onFindInFolder?: (folderPath: string) => void;
}

/** Last path segment, handling Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Parent directory of `path`, preserving the native separator. */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

export function FileExplorer({
  rootName,
  rootPath,
  roots,
  activePath,
  onOpenFile,
  onRefreshRoot,
  decorationFor = () => undefined,
  onPathRenamed,
  onPathDeleted,
  onOpenTerminalAt,
  onFindInFolder,
}: FileExplorerProps) {
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(rootPath);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pending, setPending] = useState<PendingCreation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // Context-menu + explorer-operation state.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);
  // Flat list of currently visible nodes, kept by TreeNode reporting in render
  // order is impractical; instead we track an ordered map of visible nodes.
  const visibleNodesRef = useRef<FileNode[]>([]);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedDirectory(rootPath);
    setExpandedPaths(new Set());
    setPending(null);
    setError(null);
    setRenameTarget(null);
    setClipboard(null);
    setFocusedPath(null);
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

  // ---- Explorer operations (rename / delete / cut-copy-paste / paths / OS) ----

  const beginRename = useCallback((node: FileNode) => {
    setRenameError(null);
    setRenameTarget({ path: node.path, name: node.name, isDir: node.isDir });
  }, []);

  async function submitRename(newName: string) {
    if (!rootPath || !renameTarget || busy) return;
    const trimmed = newName.trim();
    if (!trimmed) {
      setRenameError("Informe um nome.");
      return;
    }
    if (trimmed === renameTarget.name) {
      setRenameTarget(null); // unchanged → just cancel
      return;
    }
    setBusy(true);
    setRenameError(null);
    try {
      const renamed = await renamePath(rootPath, renameTarget.path, trimmed);
      onPathRenamed?.(renameTarget.path, renamed.path, renameTarget.isDir);
      setRenameTarget(null);
      await onRefreshRoot();
      setRefreshVersion((v) => v + 1);
      setStatus("Item renomeado.");
    } catch (cause) {
      setRenameError(String(cause)); // keep the input open on collision
    } finally {
      setBusy(false);
    }
  }

  const requestDelete = useCallback((node: FileNode) => {
    setDeleteTarget(node);
  }, []);

  async function confirmDelete() {
    const node = deleteTarget;
    setDeleteTarget(null);
    if (!rootPath || !node) return;
    setBusy(true);
    try {
      await deleteToTrash(rootPath, node.path);
      onPathDeleted?.(node.path, node.isDir);
      if (clipboard?.path === node.path) setClipboard(null);
      await onRefreshRoot();
      setRefreshVersion((v) => v + 1);
      setStatus("Item movido para a Lixeira.");
    } catch (cause) {
      setStatus(`Não foi possível excluir: ${String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  const cutOrCopy = useCallback((node: FileNode, mode: "cut" | "copy") => {
    setClipboard({ path: node.path, mode });
    setStatus(mode === "cut" ? "Item recortado." : "Item copiado.");
  }, []);

  const paste = useCallback(
    async (destNode: FileNode | null) => {
      if (!rootPath || !clipboard || busy) return;
      // Destination: the selected folder, or the parent of a selected file.
      const destParent = destNode
        ? destNode.isDir
          ? destNode.path
          : parentDir(destNode.path)
        : selectedDirectory ?? rootPath;
      setBusy(true);
      try {
        if (clipboard.mode === "copy") {
          await copyPath(rootPath, clipboard.path, destParent);
        } else {
          await movePath(rootPath, clipboard.path, destParent);
          setClipboard(null); // source is gone after a move
        }
        await onRefreshRoot();
        setRefreshVersion((v) => v + 1);
        setStatus("Item colado.");
      } catch (cause) {
        setStatus(`Não foi possível colar: ${String(cause)}`);
      } finally {
        setBusy(false);
      }
    },
    [rootPath, clipboard, busy, selectedDirectory, onRefreshRoot]
  );

  const copyAbsolutePath = useCallback(async (node: FileNode) => {
    const ok = await copyTextToClipboard(node.path);
    setStatus(ok ? "Caminho copiado." : "Não foi possível copiar o caminho.");
  }, []);

  const copyRelativePath = useCallback(
    async (node: FileNode) => {
      let rel = node.path;
      if (rootPath && node.path.startsWith(rootPath)) {
        rel = node.path.slice(rootPath.length).replace(/^[\\/]+/, "");
        if (!rel) rel = baseName(rootPath); // the root itself → its folder name
      }
      const ok = await copyTextToClipboard(rel);
      setStatus(ok ? "Caminho relativo copiado." : "Não foi possível copiar o caminho.");
    },
    [rootPath]
  );

  const revealInOs = useCallback(
    async (node: FileNode) => {
      if (!rootPath) return;
      try {
        await revealInExplorer(rootPath, node.path);
      } catch (cause) {
        setStatus(`Não foi possível revelar no Explorer: ${String(cause)}`);
      }
    },
    [rootPath]
  );

  const openInTerminal = useCallback(
    (node: FileNode) => {
      const cwd = node.isDir ? node.path : parentDir(node.path);
      onOpenTerminalAt?.(cwd);
    },
    [onOpenTerminalAt]
  );

  // ---- Context-menu item assembly (VS Code order, folder × file) ----

  const buildItems = useCallback(
    (node: FileNode): ContextMenuItem[] => {
      const pasteEnabled = clipboard != null;
      const common: ContextMenuItem[] = [
        { id: "reveal", label: "Revelar no Explorer do Windows", icon: "revealExplorer", run: () => revealInOs(node) },
        { id: "terminal", label: "Abrir no Terminal Integrado", icon: "terminal", run: () => openInTerminal(node) },
        ...(node.isDir
          ? [
              {
                id: "findInFolder",
                label: "Localizar na pasta",
                icon: "findInFolder" as const,
                run: () => onFindInFolder?.(node.path),
              },
            ]
          : []),
        { id: "sep-os", label: "", separator: true },
        { id: "cut", label: "Recortar", accelerator: "Ctrl+X", icon: "cut", run: () => cutOrCopy(node, "cut") },
        { id: "copy", label: "Copiar", accelerator: "Ctrl+C", icon: "copy", run: () => cutOrCopy(node, "copy") },
        {
          id: "paste",
          label: "Colar",
          accelerator: "Ctrl+V",
          icon: "paste",
          enabled: pasteEnabled,
          run: pasteEnabled ? () => paste(node) : undefined,
        },
        { id: "sep-clip", label: "", separator: true },
        { id: "copyPath", label: "Copiar caminho", accelerator: "Shift+Alt+C", icon: "copyPath", run: () => copyAbsolutePath(node) },
        {
          id: "copyRelPath",
          label: "Copiar caminho relativo",
          accelerator: "Ctrl+K Ctrl+Shift+C",
          icon: "copyPath",
          run: () => copyRelativePath(node),
        },
        { id: "sep-paths", label: "", separator: true },
        { id: "rename", label: "Renomear", accelerator: "F2", icon: "rename", run: () => beginRename(node) },
        { id: "delete", label: "Excluir", accelerator: "Del", icon: "delete", run: () => requestDelete(node) },
      ];

      if (node.isDir) {
        return [
          { id: "newFile", label: "Novo arquivo", icon: "newFile", run: () => { setSelectedDirectory(node.path); setPending({ kind: "file", parentPath: node.path }); setExpandedPaths((c) => new Set(c).add(node.path)); } },
          { id: "newFolder", label: "Nova pasta", icon: "newFolder", run: () => { setSelectedDirectory(node.path); setPending({ kind: "folder", parentPath: node.path }); setExpandedPaths((c) => new Set(c).add(node.path)); } },
          { id: "sep-new", label: "", separator: true },
          ...common,
        ];
      }

      // File: leading disabled "advanced" items (Épico de Ações Avançadas).
      return [
        { id: "openToSide", label: "Abrir ao lado", enabled: false },
        { id: "openWith", label: "Abrir com…", icon: "openWith", enabled: false },
        { id: "sep-open", label: "", separator: true },
        ...common,
        { id: "sep-git", label: "", separator: true },
        { id: "git", label: "Git", enabled: false },
      ];
    },
    [
      clipboard,
      revealInOs,
      openInTerminal,
      onFindInFolder,
      cutOrCopy,
      paste,
      copyAbsolutePath,
      copyRelativePath,
      beginRename,
      requestDelete,
    ]
  );

  const openContextMenu = useCallback(
    (e: React.MouseEvent, node: FileNode) => {
      e.preventDefault();
      e.stopPropagation();
      setFocusedPath(node.path);
      if (node.isDir) setSelectedDirectory(node.path);
      setContextMenu({ x: e.clientX, y: e.clientY, items: buildItems(node) });
    },
    [buildItems]
  );

  // ---- Keyboard navigation + focus-gated shortcuts (issue 64) ----
  // The key handler lives on the tree container (tabIndex=0), so it only ever
  // fires when the tree itself owns focus — Del/F2/Ctrl+X/C/V never reach the
  // Monaco editor, which keeps its own focus and shortcuts.

  const visible = visibleNodesRef.current;

  function focusByIndex(index: number) {
    const node = visible[index];
    if (!node) return;
    setFocusedPath(node.path);
    if (node.isDir) setSelectedDirectory(node.path);
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-tree-path="${CSS.escape(node.path)}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (renameTarget) return; // editing inline — let the input handle keys
    const list = visibleNodesRef.current;
    const index = list.findIndex((n) => n.path === focusedPath);
    const current = index >= 0 ? list[index] : null;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusByIndex(index < 0 ? 0 : Math.min(index + 1, list.length - 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        focusByIndex(index <= 0 ? 0 : index - 1);
        return;
      case "ArrowRight":
        if (current?.isDir) {
          e.preventDefault();
          if (!expandedPaths.has(current.path)) {
            setExpandedPaths((c) => new Set(c).add(current.path));
          } else {
            focusByIndex(Math.min(index + 1, list.length - 1));
          }
        }
        return;
      case "ArrowLeft":
        if (current) {
          e.preventDefault();
          if (current.isDir && expandedPaths.has(current.path)) {
            setExpandedPaths((c) => {
              const next = new Set(c);
              next.delete(current.path);
              return next;
            });
          } else {
            const parent = parentDir(current.path);
            const pIdx = list.findIndex((n) => n.path === parent);
            if (pIdx >= 0) focusByIndex(pIdx);
          }
        }
        return;
      case "Enter":
        if (current) {
          e.preventDefault();
          if (current.isDir) {
            setSelectedDirectory(current.path);
            setExpandedPaths((c) => {
              const next = new Set(c);
              if (next.has(current.path)) next.delete(current.path);
              else next.add(current.path);
              return next;
            });
          } else {
            onOpenFile(current);
          }
        }
        return;
      case "F2":
        if (current) {
          e.preventDefault();
          beginRename(current);
        }
        return;
      case "Delete":
        if (current) {
          e.preventDefault();
          requestDelete(current);
        }
        return;
    }

    // Clipboard shortcuts (only while the tree owns focus → no Monaco clash).
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "x" && current) {
        e.preventDefault();
        cutOrCopy(current, "cut");
      } else if (k === "c" && current && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        cutOrCopy(current, "copy");
      } else if (k === "v") {
        e.preventDefault();
        paste(current);
      }
    } else if (e.shiftKey && e.altKey && e.key.toLowerCase() === "c" && current) {
      e.preventDefault();
      copyAbsolutePath(current);
    }
  }

  // Recompute the flat list of visible nodes whenever structure changes. We
  // gather it lazily from the rendered rows after each paint so it always
  // matches what the user sees (respecting lazily-loaded children).
  useEffect(() => {
    const rows = treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-path]");
    if (!rows) return;
    visibleNodesRef.current = Array.from(rows).map((el) => ({
      path: el.dataset.treePath!,
      name: el.dataset.treeName ?? baseName(el.dataset.treePath!),
      isDir: el.dataset.treeDir === "1",
    }));
  });

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
        ) : null}
      </div>

      <div className="explorer-status" aria-live="polite">
        {status}
      </div>

      <div
        className="explorer-tree"
        ref={treeRef}
        role="tree"
        aria-label="Arquivos do projeto"
        tabIndex={rootPath ? 0 : undefined}
        onKeyDown={onTreeKeyDown}
        aria-activedescendant={focusedPath ? `treeitem-${focusedPath}` : undefined}
      >
        {!rootPath ? (
          <div className="explorer-empty">
            Nenhuma pasta aberta.
            <br />
            Use o menu Arquivo (ou Ctrl+K Ctrl+O) para abrir uma pasta.
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
                focusedPath={focusedPath}
                expandedPaths={expandedPaths}
                refreshVersion={refreshVersion}
                pendingCreation={pending}
                creationBusy={busy}
                creationError={error}
                renameTarget={renameTarget}
                renameBusy={busy}
                renameError={renameError}
                cutPath={clipboard?.mode === "cut" ? clipboard.path : null}
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
                onContextMenu={openContextMenu}
                onFocusNode={setFocusedPath}
                onSubmitRename={submitRename}
                onCancelRename={() => {
                  setRenameTarget(null);
                  setRenameError(null);
                }}
                decorationFor={decorationFor}
              />
            ))}
          </>
        )}
      </div>

      {contextMenu && (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => {
            setContextMenu(null);
            treeRef.current?.focus();
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Excluir"
          message={`Tem certeza que deseja excluir '${deleteTarget.name}'? O item será movido para a Lixeira.`}
          cancelValue={false}
          buttons={[
            { label: "Mover para a Lixeira", value: true, variant: "danger", default: true },
            { label: "Cancelar", value: false, variant: "secondary" },
          ]}
          onChoice={(confirmed) => {
            if (confirmed) confirmDelete();
            else setDeleteTarget(null);
          }}
        />
      )}
    </div>
  );
}
