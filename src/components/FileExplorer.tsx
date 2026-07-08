import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  copyPath,
  copyTextToClipboard,
  createFile,
  createFolder,
  deleteToTrash,
  movePath,
  renamePath,
  readDir,
  revealInExplorer,
  sshCopyPath,
  sshCreateFile,
  sshCreateFolder,
  sshDeletePath,
  sshListDir,
  sshMovePath,
  sshRenamePath,
} from "../api";
import type { ContextMenuItem, FileNode, FileDecoration } from "../types";
import { Codicon } from "../icons/codicons/Codicon";
import { FileIcon } from "../icon-theme/material/FileIcon";
import {
  ExplorerInlineCreation,
  type PendingCreation,
} from "./ExplorerInlineCreation";
import { TreeNode } from "./TreeNode";
import { TreeContextMenu } from "./TreeContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { buildAdvancedFileMenuItems } from "../explorer/advancedFileMenu";

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
  workspaceRoots?: ExplorerWorkspaceRoot[];
  isWorkspace?: boolean;
  activePath: string | null;
  onOpenFile: (node: FileNode) => void;
  onRefreshRoot: () => Promise<void>;
  decorationFor?: (path: string) => FileDecoration | undefined;
  /** Notifies the host that a path was renamed, so it can re-point open tabs. */
  onPathRenamed?: (oldPath: string, newPath: string, isDir: boolean) => void;
  /** Notifies the host that a path was deleted, so it can close affected tabs. */
  onPathDeleted?: (path: string, isDir: boolean) => void;
  /** Opens/focuses the integrated terminal with the given working directory. */
  onOpenTerminalAt?: (cwd: string, connId?: string) => void;
  /** Opens/focuses the search panel scoped to the given folder. */
  onFindInFolder?: (folderPath: string, rootId?: string) => void;
  /** Renames the display label of a top-level workspace root. */
  onRenameWorkspaceRoot?: (rootId: string, name: string) => void;
  /** Removes a top-level root from the workspace without deleting files. */
  onRemoveWorkspaceRoot?: (rootId: string) => void;
  /** Opens/retries the SSH connection for a top-level workspace root. */
  onConnectWorkspaceRoot?: (rootId: string) => void;
  /** Disconnects a connected SSH workspace root without removing it. */
  onDisconnectWorkspaceRoot?: (rootId: string) => void;
  /** Adds a local folder to the current workspace. */
  onAddFolderToWorkspace?: () => void;
  /** Adds an SSH folder to the current workspace. */
  onAddSshFolderToWorkspace?: () => void;
  /**
   * Advanced file actions (épico "Ações Avançadas do Explorador", issues
   * 69-71), wired by App and folded into the file context menu via
   * `buildAdvancedFileMenuItems` (see `src/explorer/advancedFileMenu.ts`).
   */
  advancedActions?: ExplorerAdvancedActions;
  /**
   * Absolute paths changed in the working tree (issue #19). Drives the "show
   * only changed files" toggle — a flat list of just these, for focus.
   */
  changedPaths?: string[];
}

export interface ExplorerWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  provider: "local" | "ssh";
  remote?: {
    host: string;
    user: string;
    port?: number;
  };
  connId?: string;
  status?: "connected" | "connecting" | "error";
  error?: string;
}

/** Handlers App passes down for the advanced file context-menu items. */
export interface ExplorerAdvancedActions {
  /** ISSUE-70 — open the "Open With…" selector for `path` at `x,y`. */
  onShowOpenWith: (path: string, x: number, y: number) => void;
  /** Open the working-tree diff for `path`, like VS Code's Open Changes. */
  onOpenChanges?: (path: string) => void;
  /** ISSUE-71 — show `path`'s git history in the Source Control panel. */
  onFileHistory: (path: string) => void;
  /** True when the file's owning workspace root is a git repo. */
  isGitRepo: (path: string) => boolean;
}

/** Last path segment, handling Windows and POSIX separators. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function workspaceRootSubtitle(root: ExplorerWorkspaceRoot): string {
  if (root.provider === "ssh") {
    const remote = root.remote;
    const authority = remote
      ? `${remote.user}@${remote.host}${remote.port && remote.port !== 22 ? `:${remote.port}` : ""}`
      : "SSH";
    const state =
      root.status === "connecting"
        ? "conectando"
        : root.status === "error"
          ? root.error ?? "falha ao conectar"
          : root.connId
            ? "conectado"
            : "desconectado";
    return `${authority} - ${state} - ${root.path}`;
  }
  return root.path;
}

/** Parent directory of `path`, preserving the native separator. */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : path;
}

function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized)
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function sameExplorerPath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

export function FileExplorer({
  rootName,
  rootPath,
  roots,
  workspaceRoots = [],
  isWorkspace = false,
  activePath,
  onOpenFile,
  onRefreshRoot,
  decorationFor = () => undefined,
  changedPaths = [],
  onPathRenamed,
  onPathDeleted,
  onOpenTerminalAt,
  onFindInFolder,
  onRenameWorkspaceRoot,
  onRemoveWorkspaceRoot,
  onConnectWorkspaceRoot,
  onDisconnectWorkspaceRoot,
  onAddFolderToWorkspace,
  onAddSshFolderToWorkspace,
  advancedActions,
}: FileExplorerProps) {
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(rootPath);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pending, setPending] = useState<PendingCreation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // "Show only changed files" (issue #19): flattens the tree to just the files
  // changed in the working tree, for a focused view of work in progress.
  const [onlyChanged, setOnlyChanged] = useState(false);

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
  const hasExplorerContent = Boolean(rootPath) || workspaceRoots.length > 0 || isWorkspace;
  const workspaceView = isWorkspace || workspaceRoots.length > 1 || (!rootPath && workspaceRoots.length > 0);
  const workspaceTitle = workspaceView ? rootName ?? "Workspace" : rootName ?? "EXPLORADOR";
  const visibleStatus = /\b(expandido|recolhido|recolhidas)\.?$/i.test(status)
    ? ""
    : status;

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
  const localWorkspaceRoots = useMemo(
    () =>
      workspaceRoots.length > 0
        ? workspaceRoots.filter((root) => root.provider === "local")
        : rootPath
          ? [{ id: "root", name: baseName(rootPath), path: rootPath, provider: "local" as const }]
          : [],
    [rootPath, workspaceRoots]
  );
  const showWorkspaceRootNodes =
    (workspaceView && workspaceRoots.length > 0) ||
    workspaceRoots.length > 1 ||
    (!rootPath && workspaceRoots.length > 0) ||
    (workspaceRoots.length === 1 && workspaceRoots[0]?.provider === "ssh");
  const displayRoots = useMemo<FileNode[]>(
    () =>
      showWorkspaceRootNodes
        ? workspaceRoots
            .map((root) => ({
            name: root.name,
            path: root.path,
            isDir: true,
            workspaceRootId: root.id,
            workspaceRemote:
              root.provider === "ssh" && root.connId && root.remote
                ? {
                    folderId: root.id,
                    connId: root.connId,
                    host: root.remote.host,
                    user: root.remote.user,
                    rootPath: root.path,
                  }
                : undefined,
          }))
        : roots,
    [showWorkspaceRootNodes, roots, workspaceRoots]
  );

  const workspaceRootAtPath = useCallback(
    (path: string): ExplorerWorkspaceRoot | null =>
      workspaceRoots.find((root) => sameExplorerPath(root.path, path)) ?? null,
    [workspaceRoots]
  );

  const workspaceRootForNode = useCallback(
    (node: FileNode): ExplorerWorkspaceRoot | null =>
      (node.workspaceRootId
        ? workspaceRoots.find((root) => root.id === node.workspaceRootId)
        : null) ?? workspaceRootAtPath(node.path),
    [workspaceRootAtPath, workspaceRoots]
  );

  const workspaceRootForPath = useCallback(
    (path: string | null | undefined): ExplorerWorkspaceRoot | null => {
      if (!path) return null;
      const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
      let best: ExplorerWorkspaceRoot | null = null;
      for (const root of workspaceRoots) {
        const normalizedRoot = root.path.replace(/\\/g, "/").replace(/\/+$/, "");
        const windows = /^[a-zA-Z]:\//.test(normalizedPath) && /^[a-zA-Z]:\//.test(normalizedRoot);
        const pathKey = windows ? normalizedPath.toLocaleLowerCase("en-US") : normalizedPath;
        const rootKey = windows ? normalizedRoot.toLocaleLowerCase("en-US") : normalizedRoot;
        if (pathKey === rootKey || pathKey.startsWith(`${rootKey}/`)) {
          if (!best || normalizedRoot.length > best.path.replace(/\\/g, "/").length) {
            best = root;
          }
        }
      }
      return best;
    },
    [workspaceRoots]
  );

  const loadChildren = useCallback(
    async (node: FileNode) => {
      const owner = workspaceRootForNode(node) ?? workspaceRootForPath(node.path);
      const remote = node.workspaceRemote;
      if (remote) {
        const entries = await sshListDir(remote.connId, node.path);
        return entries.map((entry) => ({
          ...entry,
          workspaceRootId: remote.folderId,
          workspaceRemote: remote,
        }));
      }
      if (owner?.provider === "ssh") {
        if (!owner.connId || !owner.remote) throw new Error("Root SSH ainda não conectada.");
        const workspaceRemote = {
          folderId: owner.id,
          connId: owner.connId,
          host: owner.remote.host,
          user: owner.remote.user,
          rootPath: owner.path,
        };
        const entries = await sshListDir(owner.connId, node.path);
        return entries.map((entry) => ({
          ...entry,
          workspaceRootId: owner.id,
          workspaceRemote,
        }));
      }
      const entries = await readDir(node.path);
      return entries.map((entry) => ({
        ...entry,
        workspaceRootId: owner?.id ?? node.workspaceRootId,
      }));
    },
    [workspaceRootForNode, workspaceRootForPath]
  );

  const rootForPath = useCallback(
    (path: string | null | undefined): string | null => {
      if (!path) return rootPath;
      const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
      let best: string | null = null;
      for (const root of localWorkspaceRoots) {
        const normalizedRoot = root.path.replace(/\\/g, "/").replace(/\/+$/, "");
        const pathKey = /^[a-zA-Z]:\//.test(normalizedPath)
          ? normalizedPath.toLocaleLowerCase("en-US")
          : normalizedPath;
        const rootKey = /^[a-zA-Z]:\//.test(normalizedRoot)
          ? normalizedRoot.toLocaleLowerCase("en-US")
          : normalizedRoot;
        if (pathKey === rootKey || pathKey.startsWith(`${rootKey}/`)) {
          if (!best || normalizedRoot.length > best.replace(/\\/g, "/").length) {
            best = root.path;
          }
        }
      }
      return best ?? rootPath;
    },
    [localWorkspaceRoots, rootPath]
  );

  const localRootForPath = useCallback(
    (path: string | null | undefined): string | null => {
      if (!path) return rootPath;
      const owner = workspaceRootForPath(path);
      if (owner?.provider === "ssh") return null;
      return rootForPath(path);
    },
    [rootForPath, rootPath, workspaceRootForPath]
  );

  const targetDirectory = selectedDirectory ?? rootPath;
  const targetOwner = workspaceRootForPath(targetDirectory);
  const targetRootPath = targetOwner?.provider === "ssh" ? targetOwner.path : rootForPath(targetDirectory);
  const actionsDisabled = !targetRootPath || (targetOwner?.provider === "ssh" && !targetOwner.connId) || busy;

  useEffect(() => {
    if (rootPath) return;

    if (selectedDirectory) {
      const owner = workspaceRootForPath(selectedDirectory);
      if (owner && (owner.provider === "local" || owner.connId)) return;
    }

    const firstAvailableRoot = displayRoots[0]?.path ?? null;
    if (firstAvailableRoot && firstAvailableRoot !== selectedDirectory) {
      setSelectedDirectory(firstAvailableRoot);
    }
  }, [displayRoots, rootPath, selectedDirectory, workspaceRootForPath]);

  function beginCreation(kind: PendingCreation["kind"]) {
    if (!targetDirectory || !targetRootPath) return;
    setPending({ kind, parentPath: targetDirectory });
    setError(null);
    if (targetDirectory !== rootPath) {
      setExpandedPaths((current) => new Set(current).add(targetDirectory));
    }
  }

  async function submitCreation(name: string) {
    if (!pending || busy) return;
    const owner = workspaceRootForPath(pending.parentPath);
    const operationRoot = owner?.provider === "ssh" ? owner.path : rootForPath(pending.parentPath);
    if (!operationRoot) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Informe um nome.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const created =
        owner?.provider === "ssh"
          ? pending.kind === "file"
            ? await sshCreateFile(owner.connId!, pending.parentPath, trimmed)
            : await sshCreateFolder(owner.connId!, pending.parentPath, trimmed)
          : pending.kind === "file"
            ? await createFile(operationRoot, pending.parentPath, trimmed)
            : await createFolder(operationRoot, pending.parentPath, trimmed);
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
    if (busy || (!rootPath && displayRoots.length === 0)) return;
    setBusy(true);
    setStatus("Atualizando explorador…");
    try {
      if (rootPath) await onRefreshRoot();
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
    setStatus("");
  }

  function beginCreationAt(node: FileNode, kind: PendingCreation["kind"]) {
    const owner = workspaceRootForNode(node) ?? workspaceRootForPath(node.path);
    if (owner?.provider === "ssh" && !owner.connId) return;
    setSelectedDirectory(node.path);
    setPending({ kind, parentPath: node.path });
    setError(null);
    setExpandedPaths((current) => new Set(current).add(node.path));
  }

  function refreshWorkspaceRootNode(node: FileNode) {
    setSelectedDirectory(node.path);
    setRefreshVersion((value) => value + 1);
    setStatus(`Atualizando ${node.name}...`);
    void onRefreshRoot()
      .then(() => setStatus(`${node.name} atualizado.`))
      .catch((cause) => setStatus(`Não foi possível atualizar ${node.name}: ${String(cause)}`));
  }

  function toggleWorkspaceRootNode(node: FileNode) {
    const prefix = `${pathKey(node.path)}/`;
    setStatus("");
    setExpandedPaths((current) => {
      if (!current.has(node.path)) {
        const next = new Set(current);
        next.add(node.path);
        return next;
      }
      const next = new Set<string>();
      for (const path of current) {
        const key = pathKey(path);
        if (key !== pathKey(node.path) && !key.startsWith(prefix)) next.add(path);
      }
      return next;
    });
  }

  // ---- Explorer operations (rename / delete / cut-copy-paste / paths / OS) ----

  const beginRename = useCallback((node: FileNode) => {
    setRenameError(null);
    setRenameTarget({ path: node.path, name: node.name, isDir: node.isDir });
  }, []);

  async function submitRename(newName: string) {
    if (!renameTarget || busy) return;
    const owner = workspaceRootForPath(renameTarget.path);
    const operationRoot = localRootForPath(renameTarget.path);
    if (!operationRoot && !owner?.connId) return;
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
      const renamed =
        owner?.provider === "ssh"
          ? await sshRenamePath(owner.connId!, renameTarget.path, trimmed)
          : await renamePath(operationRoot!, renameTarget.path, trimmed);
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
    if (!node) return;
    const owner = workspaceRootForPath(node.path);
    const operationRoot = localRootForPath(node.path);
    if (!operationRoot && !owner?.connId) return;
    setBusy(true);
    try {
      if (owner?.provider === "ssh") await sshDeletePath(owner.connId!, node.path);
      else await deleteToTrash(operationRoot!, node.path);
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
      if (!clipboard || busy) return;
      // Destination: the selected folder, or the parent of a selected file.
      const destParent = destNode
        ? destNode.isDir
          ? destNode.path
          : parentDir(destNode.path)
        : selectedDirectory ?? rootPath;
      if (!destParent) return;
      const sourceOwner = workspaceRootForPath(clipboard.path);
      const destOwner = workspaceRootForPath(destParent);
      const sourceRoot = sourceOwner?.provider === "ssh" ? sourceOwner.path : rootForPath(clipboard.path);
      const destRoot = destOwner?.provider === "ssh" ? destOwner.path : rootForPath(destParent);
      if (!sourceRoot || !destRoot || sourceRoot !== destRoot || sourceOwner?.id !== destOwner?.id) {
        setStatus("Mover ou copiar entre roots diferentes ainda não é suportado.");
        return;
      }
      if (sourceOwner?.provider === "ssh" && !sourceOwner.connId) {
        setStatus("A root SSH ainda não está conectada.");
        return;
      }
      setBusy(true);
      try {
        if (clipboard.mode === "copy") {
          if (sourceOwner?.provider === "ssh") {
            await sshCopyPath(sourceOwner.connId!, clipboard.path, destParent);
          } else {
            await copyPath(sourceRoot, clipboard.path, destParent);
          }
        } else {
          if (sourceOwner?.provider === "ssh") {
            await sshMovePath(sourceOwner.connId!, clipboard.path, destParent);
          } else {
            await movePath(sourceRoot, clipboard.path, destParent);
          }
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
    [rootPath, clipboard, busy, selectedDirectory, onRefreshRoot, rootForPath, workspaceRootForPath]
  );

  const copyAbsolutePath = useCallback(async (node: FileNode) => {
    const ok = await copyTextToClipboard(node.path);
    setStatus(ok ? "Caminho copiado." : "Não foi possível copiar o caminho.");
  }, []);

  const copyRelativePath = useCallback(
    async (node: FileNode) => {
      let rel = node.path;
      const operationRoot = rootForPath(node.path);
      if (operationRoot && node.path.startsWith(operationRoot)) {
        rel = node.path.slice(operationRoot.length).replace(/^[\\/]+/, "");
        if (!rel) rel = baseName(operationRoot); // the root itself → its folder name
      }
      const ok = await copyTextToClipboard(rel);
      setStatus(ok ? "Caminho relativo copiado." : "Não foi possível copiar o caminho.");
    },
    [rootForPath]
  );

  const revealInOs = useCallback(
    async (node: FileNode) => {
      const owner = workspaceRootForPath(node.path);
      if (owner?.provider === "ssh") {
        const ok = await copyTextToClipboard(node.path);
        setStatus(
          ok
            ? "Caminho remoto copiado. O Explorer do Windows não abre roots SSH diretamente."
            : "Explorer local não abre roots SSH e não foi possível copiar o caminho remoto."
        );
        return;
      }
      const operationRoot = rootForPath(node.path);
      if (!operationRoot) return;
      try {
        await revealInExplorer(operationRoot, node.path);
      } catch (cause) {
        setStatus(`Não foi possível revelar no Explorer: ${String(cause)}`);
      }
    },
    [rootForPath, workspaceRootForPath]
  );

  const openInTerminal = useCallback(
    (node: FileNode) => {
      const owner = workspaceRootForPath(node.path);
      if (owner?.provider === "ssh" && !owner.connId) {
        setStatus("Root SSH ainda não está conectada para abrir o terminal.");
        return;
      }
      const cwd = node.isDir ? node.path : parentDir(node.path);
      onOpenTerminalAt?.(cwd, owner?.provider === "ssh" ? owner.connId : undefined);
    },
    [onOpenTerminalAt, workspaceRootForPath]
  );

  // ---- Context-menu item assembly (VS Code order, folder × file) ----

  const buildItems = useCallback(
    (node: FileNode, x: number, y: number): ContextMenuItem[] => {
      const workspaceRoot = workspaceRootForNode(node);
      if (workspaceRoot && showWorkspaceRootNodes) {
        const connected = workspaceRoot.provider === "local" || Boolean(workspaceRoot.connId);
        const pasteEnabled = clipboard != null && connected;
        const canRetrySsh = workspaceRoot.provider === "ssh" && workspaceRoot.status !== "connecting";
        const renameRoot = () => {
          const next = window.prompt("Nome da pasta no workspace:", workspaceRoot.name)?.trim();
          if (next && next !== workspaceRoot.name) {
            onRenameWorkspaceRoot?.(workspaceRoot.id, next);
            setStatus("Pasta do workspace renomeada.");
          }
        };
        const removeRoot = () => {
          const confirmed = window.confirm(
            `Remover '${workspaceRoot.name}' do workspace?\n\nOs arquivos não serão excluídos.`
          );
          if (confirmed) {
            onRemoveWorkspaceRoot?.(workspaceRoot.id);
            setStatus("Pasta removida do workspace.");
          }
        };

        return [
          ...(workspaceRoot.provider === "ssh"
            ? [
                {
                  id: connected ? "workspace-root-disconnect" : "workspace-root-connect",
                  label: connected ? "Desconectar SSH" : "Conectar SSH",
                  icon: connected ? ("debugDisconnect" as const) : ("remote" as const),
                  enabled: connected
                    ? Boolean(onDisconnectWorkspaceRoot)
                    : Boolean(onConnectWorkspaceRoot) && canRetrySsh,
                  run: connected
                    ? onDisconnectWorkspaceRoot
                      ? () => onDisconnectWorkspaceRoot(workspaceRoot.id)
                      : undefined
                    : onConnectWorkspaceRoot && canRetrySsh
                      ? () => onConnectWorkspaceRoot(workspaceRoot.id)
                      : undefined,
                },
                { id: "workspace-root-sep-ssh", label: "", separator: true },
              ]
            : []),
          {
            id: "workspace-root-newFile",
            label: "Novo arquivo",
            icon: "newFile",
            enabled: connected,
            run: connected
              ? () => {
                  setSelectedDirectory(workspaceRoot.path);
                  setPending({ kind: "file", parentPath: workspaceRoot.path });
                  setExpandedPaths((current) => new Set(current).add(workspaceRoot.path));
                }
              : undefined,
          },
          {
            id: "workspace-root-newFolder",
            label: "Nova pasta",
            icon: "newFolder",
            enabled: connected,
            run: connected
              ? () => {
                  setSelectedDirectory(workspaceRoot.path);
                  setPending({ kind: "folder", parentPath: workspaceRoot.path });
                  setExpandedPaths((current) => new Set(current).add(workspaceRoot.path));
                }
              : undefined,
          },
          { id: "workspace-root-sep-new", label: "", separator: true },
          {
            id: "workspace-root-find",
            label: "Localizar na pasta",
            icon: "findInFolder",
            enabled: connected,
            run: connected ? () => onFindInFolder?.(workspaceRoot.path, workspaceRoot.id) : undefined,
          },
          {
            id: "workspace-root-terminal",
            label: "Abrir no Terminal Integrado",
            icon: "terminal",
            enabled: connected,
            run: connected ? () => openInTerminal(node) : undefined,
          },
          {
            id: "workspace-root-reveal",
            label:
              workspaceRoot.provider === "ssh"
                ? "Copiar Caminho Remoto"
                : "Revelar no Explorer do Windows",
            icon: workspaceRoot.provider === "ssh" ? "copyPath" : "revealExplorer",
            enabled: connected,
            run: connected ? () => revealInOs(node) : undefined,
          },
          { id: "workspace-root-sep-paths", label: "", separator: true },
          {
            id: "workspace-root-paste",
            label: "Colar",
            accelerator: "Ctrl+V",
            icon: "paste",
            enabled: pasteEnabled,
            run: pasteEnabled ? () => paste(node) : undefined,
          },
          {
            id: "workspace-root-copyPath",
            label: "Copiar caminho",
            accelerator: "Shift+Alt+C",
            icon: "copyPath",
            run: () => copyAbsolutePath(node),
          },
          {
            id: "workspace-root-copyRelPath",
            label: "Copiar nome da pasta",
            icon: "copyPath",
            run: () => void copyTextToClipboard(workspaceRoot.name),
          },
          { id: "workspace-root-sep-workspace", label: "", separator: true },
          {
            id: "workspace-root-rename",
            label: "Renomear no Workspace",
            icon: "rename",
            enabled: Boolean(onRenameWorkspaceRoot),
            run: onRenameWorkspaceRoot ? renameRoot : undefined,
          },
          {
            id: "workspace-root-remove",
            label: "Remover Pasta do Workspace",
            icon: "trash",
            enabled: Boolean(onRemoveWorkspaceRoot),
            run: onRemoveWorkspaceRoot ? removeRoot : undefined,
          },
        ];
      }

      const pasteEnabled = clipboard != null;
      const owner = workspaceRootForPath(node.path);
      const common: ContextMenuItem[] = [
        {
          id: "reveal",
          label:
            owner?.provider === "ssh"
              ? "Copiar Caminho Remoto"
              : "Revelar no Explorer do Windows",
          icon: owner?.provider === "ssh" ? "copyPath" : "revealExplorer",
          run: () => revealInOs(node),
        },
        { id: "terminal", label: "Abrir no Terminal Integrado", icon: "terminal", run: () => openInTerminal(node) },
        ...(node.isDir
          ? [
              {
                id: "findInFolder",
                label: "Localizar na pasta",
                icon: "findInFolder" as const,
                run: () => onFindInFolder?.(node.path, owner?.id),
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

      // File: base items, then the advanced items from the "Ações Avançadas"
      // épico (Open With works; split/diff/timeline stay disabled). When the
      // host didn't wire advancedActions, fall back to a single disabled stub.
      const advanced: ContextMenuItem[] = advancedActions
        ? buildAdvancedFileMenuItems(
            {
              path: node.path,
              x,
              y,
              isGitRepo: advancedActions.isGitRepo(node.path),
              compareSelection: null,
            },
            {
              onOpenWith: advancedActions.onShowOpenWith,
              onOpenChanges: advancedActions.onOpenChanges,
              onFileHistory: advancedActions.onFileHistory,
            }
          )
        : [{ id: "advanced", label: "Mais ações", enabled: false }];

      return [
        ...advanced,
        { id: "sep-adv", label: "", separator: true },
        ...common,
      ];
    },
    [
      clipboard,
      advancedActions,
      revealInOs,
      openInTerminal,
      onFindInFolder,
      cutOrCopy,
      paste,
      copyAbsolutePath,
      copyRelativePath,
      beginRename,
      requestDelete,
      workspaceRootAtPath,
      showWorkspaceRootNodes,
      onRenameWorkspaceRoot,
      onRemoveWorkspaceRoot,
      onConnectWorkspaceRoot,
      onDisconnectWorkspaceRoot,
      workspaceRootForNode,
    ]
  );

  const openContextMenu = useCallback(
    (e: React.MouseEvent, node: FileNode) => {
      e.preventDefault();
      e.stopPropagation();
      setFocusedPath(node.path);
      if (node.isDir) setSelectedDirectory(node.path);
      setContextMenu({ x: e.clientX, y: e.clientY, items: buildItems(node, e.clientX, e.clientY) });
    },
    [buildItems]
  );

  // ---- Empty-area context menu (issue #18) ----
  // Root-level actions when right-clicking the blank space of the tree (VS Code
  // style). Node right-clicks stopPropagation in `openContextMenu`, so only true
  // empty-area clicks reach here. Operates on the workspace root.
  const buildRootItems = useCallback((): ContextMenuItem[] => {
    const targetPath = targetDirectory ?? rootPath;
    const targetRoot = targetRootPath;
    const targetNode: FileNode | null = targetPath
      ? {
          name: baseName(targetPath),
          path: targetPath,
          isDir: true,
        }
      : null;
    const createEnabled = Boolean(targetNode && targetRoot && !actionsDisabled);
    const revealEnabled = Boolean(targetNode && targetRoot);
    const rootNode: FileNode = {
      name: baseName(targetPath ?? rootPath ?? ""),
      path: targetPath ?? rootPath ?? "",
      isDir: true,
    };
    const pasteEnabled = clipboard != null;
    const workspaceItems: ContextMenuItem[] = workspaceView
      ? [
          {
            id: "workspace-add-folder",
            label: "Adicionar Pasta ao Workspace...",
            icon: "add",
            enabled: Boolean(onAddFolderToWorkspace),
            run: onAddFolderToWorkspace,
          },
          {
            id: "workspace-add-ssh-folder",
            label: "Adicionar Pasta SSH ao Workspace...",
            icon: "remote",
            enabled: Boolean(onAddSshFolderToWorkspace),
            run: onAddSshFolderToWorkspace,
          },
          { id: "workspace-sep-add", label: "", separator: true },
        ]
      : [];

    return [
      ...workspaceItems,
      {
        id: "root-newFile",
        label: "Novo arquivo",
        icon: "newFile",
        enabled: createEnabled,
        run: () => {
          if (!targetNode) return;
          setSelectedDirectory(targetNode.path);
          setPending({ kind: "file", parentPath: targetNode.path });
        },
      },
      {
        id: "root-newFolder",
        label: "Nova pasta",
        icon: "newFolder",
        enabled: createEnabled,
        run: () => {
          if (!targetNode) return;
          setSelectedDirectory(targetNode.path);
          setPending({ kind: "folder", parentPath: targetNode.path });
        },
      },
      { id: "root-sep-clip", label: "", separator: true },
      {
        id: "root-paste",
        label: "Colar",
        accelerator: "Ctrl+V",
        icon: "paste",
        enabled: pasteEnabled && Boolean(targetNode),
        run: pasteEnabled && targetNode ? () => paste(rootNode) : undefined,
      },
      { id: "root-sep-os", label: "", separator: true },
      {
        id: "root-reveal",
        label: targetOwner?.provider === "ssh" ? "Copiar Caminho Remoto" : "Revelar no Explorer do Windows",
        icon: targetOwner?.provider === "ssh" ? "copyPath" : "revealExplorer",
        enabled: revealEnabled,
        run: revealEnabled ? () => revealInOs(rootNode) : undefined,
      },
    ];
  }, [
    actionsDisabled,
    clipboard,
    onAddFolderToWorkspace,
    onAddSshFolderToWorkspace,
    paste,
    revealInOs,
    rootPath,
    targetDirectory,
    targetOwner,
    targetRootPath,
    workspaceView,
  ]);

  const openEmptyAreaMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasExplorerContent) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, items: buildRootItems() });
    },
    [buildRootItems, hasExplorerContent]
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
          const workspaceRoot = workspaceRootAtPath(current.path);
          if (workspaceRoot && showWorkspaceRootNodes) {
            const next = window.prompt("Nome da pasta no workspace:", workspaceRoot.name)?.trim();
            if (next && next !== workspaceRoot.name) {
              onRenameWorkspaceRoot?.(workspaceRoot.id, next);
              setStatus("Pasta do workspace renomeada.");
            }
          } else {
            beginRename(current);
          }
        }
        return;
      case "Delete":
        if (current) {
          e.preventDefault();
          const workspaceRoot = workspaceRootAtPath(current.path);
          if (workspaceRoot && showWorkspaceRootNodes) {
            const confirmed = window.confirm(
              `Remover '${workspaceRoot.name}' do workspace?\n\nOs arquivos não serão excluídos.`
            );
            if (confirmed) {
              onRemoveWorkspaceRoot?.(workspaceRoot.id);
              setStatus("Pasta removida do workspace.");
            }
          } else {
            requestDelete(current);
          }
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
    const frame = window.requestAnimationFrame(() => {
      const rows = treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-path]");
      if (!rows) return;
      visibleNodesRef.current = Array.from(rows)
        .filter((el) => !el.closest(".tree-children:not(.expanded)"))
        .map((el) => ({
          path: el.dataset.treePath!,
          name: el.dataset.treeName ?? baseName(el.dataset.treePath!),
          isDir: el.dataset.treeDir === "1",
          workspaceRootId: el.dataset.treeRootId || undefined,
        }));
    });
    return () => window.cancelAnimationFrame(frame);
  });

  return (
    <div className="explorer">
      <div className="explorer-header">
        <div className="explorer-title-stack" title={workspaceTitle}>
          <span className="explorer-title">
            {workspaceTitle}
          </span>
        </div>
        {hasExplorerContent ? (
          <div className="explorer-actions" role="toolbar" aria-label="Ações do explorador">
            {workspaceView && onAddFolderToWorkspace && (
              <button
                className="explorer-action"
                title="Adicionar pasta ao workspace"
                aria-label="Adicionar pasta ao workspace"
                onClick={onAddFolderToWorkspace}
              >
                <Codicon name="add" size={16} />
              </button>
            )}
            {workspaceView && onAddSshFolderToWorkspace && (
              <button
                className="explorer-action"
                title="Adicionar pasta SSH ao workspace"
                aria-label="Adicionar pasta SSH ao workspace"
                onClick={onAddSshFolderToWorkspace}
              >
                <Codicon name="remote" size={16} />
              </button>
            )}
            {!workspaceView && (
              <>
                <button
                  className="explorer-action"
                  title="Novo arquivo"
                  aria-label="Novo arquivo"
                  disabled={actionsDisabled}
                  onClick={() => beginCreation("file")}
                >
                  <Codicon name="newFile" size={16} />
                </button>
                <button
                  className="explorer-action"
                  title="Nova pasta"
                  aria-label="Nova pasta"
                  disabled={actionsDisabled}
                  onClick={() => beginCreation("folder")}
                >
                  <Codicon name="newFolder" size={16} />
                </button>
              </>
            )}
            <button
              className={`explorer-action${onlyChanged ? " active" : ""}`}
              title={
                onlyChanged
                  ? "Mostrar todos os arquivos"
                  : "Mostrar apenas arquivos alterados"
              }
              aria-label="Alternar exibição de arquivos alterados"
              aria-pressed={onlyChanged}
              disabled={actionsDisabled}
              onClick={() => setOnlyChanged((v) => !v)}
            >
              <Codicon name="sourceControl" size={16} />
            </button>
            <button
              className="explorer-action"
              title="Atualizar explorador"
              aria-label="Atualizar explorador"
              disabled={actionsDisabled}
              onClick={refresh}
            >
              <Codicon name="refresh" size={16} spin={busy} />
            </button>
            {!workspaceView && (
              <button
                className="explorer-action"
                title="Recolher pastas"
                aria-label="Recolher pastas"
                disabled={actionsDisabled || !hasExpandedFolders}
                onClick={collapseAll}
              >
                <Codicon name="collapseAll" size={16} />
              </button>
            )}
          </div>
        ) : null}
      </div>

      <div className="explorer-status" aria-live="polite">
        {visibleStatus}
      </div>

      <div
        className="explorer-tree"
        ref={treeRef}
        role="tree"
        aria-label="Arquivos do projeto"
        tabIndex={hasExplorerContent ? 0 : undefined}
        onKeyDown={onTreeKeyDown}
        onContextMenu={openEmptyAreaMenu}
        aria-activedescendant={focusedPath ? `treeitem-${focusedPath}` : undefined}
      >
        {!hasExplorerContent ? (
          <div className="explorer-empty">
            Nenhuma pasta aberta.
            <br />
            Use o menu Arquivo (ou Ctrl+K Ctrl+O) para abrir uma pasta.
          </div>
        ) : onlyChanged ? (
          changedPaths.length === 0 ? (
            <div className="explorer-empty">Nenhum arquivo alterado na branch.</div>
          ) : (
            changedPaths.map((p) => {
              const rel = rootPath && p.startsWith(rootPath)
                ? p.slice(rootPath.length).replace(/^[\\/]+/, "")
                : p;
              const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
              return (
                <div
                  key={p}
                  id={`treeitem-${p}`}
                  data-tree-path={p}
                  data-tree-name={baseName(p)}
                  data-tree-dir="0"
                  className={`explorer-flat-row${p === activePath ? " active" : ""}`}
                  title={rel}
                  role="treeitem"
                  onClick={() => {
                    setFocusedPath(p);
                    onOpenFile({ name: baseName(p), path: p, isDir: false });
                  }}
                >
                  <FileIcon path={p} className="explorer-flat-icon" />
                  <span className="explorer-flat-name">{baseName(p)}</span>
                  {dir && <span className="explorer-flat-dir">{dir}</span>}
                </div>
              );
            })
          )
        ) : (
          <>
            {workspaceView && displayRoots.length === 0 && (
              <div className="explorer-empty">
                Workspace vazio.
                <br />
                Use o botão direito ou os atalhos do topo para adicionar uma pasta.
              </div>
            )}
            {!showWorkspaceRootNodes && pending?.parentPath === rootPath && (
              <ExplorerInlineCreation
                kind={pending.kind}
                depth={0}
                busy={busy}
                error={error}
                onSubmit={submitCreation}
                onCancel={() => setPending(null)}
              />
            )}
            {displayRoots.map((node) => {
              const workspaceRoot = showWorkspaceRootNodes ? workspaceRootForNode(node) : null;
              return (
                <TreeNode
                  key={node.workspaceRootId ?? node.path}
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
                  loadChildren={loadChildren}
                  workspaceRootKind={workspaceRoot?.provider}
                  workspaceRootStatus={workspaceRoot?.status}
                  workspaceRootSubtitle={workspaceRoot ? workspaceRootSubtitle(workspaceRoot) : undefined}
                  workspaceRootDisabled={workspaceRoot?.provider === "ssh" && !workspaceRoot.connId}
                  onConnectWorkspaceRoot={(rootNode) => {
                    const root = workspaceRootForNode(rootNode);
                    if (root) onConnectWorkspaceRoot?.(root.id);
                  }}
                  onDisconnectWorkspaceRoot={(rootNode) => {
                    const root = workspaceRootForNode(rootNode);
                    if (root) onDisconnectWorkspaceRoot?.(root.id);
                  }}
                  onRemoveWorkspaceRoot={(rootNode) => {
                    const root = workspaceRootForNode(rootNode);
                    if (root) onRemoveWorkspaceRoot?.(root.id);
                  }}
                  onCreateWorkspaceRootFile={(rootNode) => beginCreationAt(rootNode, "file")}
                  onCreateWorkspaceRootFolder={(rootNode) => beginCreationAt(rootNode, "folder")}
                  onRefreshWorkspaceRoot={refreshWorkspaceRootNode}
                  onCollapseWorkspaceRoot={toggleWorkspaceRootNode}
                />
              );
            })}
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
