import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FileNode, FileDecoration } from "../types";
import { readDir } from "../api";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";
import {
  ExplorerInlineCreation,
  type PendingCreation,
} from "./ExplorerInlineCreation";
import { ExplorerInlineRename } from "./ExplorerInlineRename";
import { ACTION_SLOT, ActionBar, type PaneAction } from "./ui/ViewPane";

/** Abaixo desta largura de linha, a raiz mostra só o "…" (o nome tem prioridade). */
const ROOT_ROW_COMPACT_WIDTH = 240;
/** Ações inline de uma raiz (o resto vai para o "…"), como no VS Code. */
const ROOT_INLINE_MAX = 3;

/**
 * Ações de uma pasta-raiz do workspace: só aparecem no hover/foco/seleção da
 * linha (CSS), no máximo 3 inline + "…", e numa linha estreita só o "…" —
 * o nome da pasta nunca é o que encolhe até sumir.
 */
function WorkspaceRootActions({ actions }: { actions: PaneAction[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    const read = () => setRowWidth(Math.round(row.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(row);
    return () => ro.disconnect();
  }, []);
  // 1 px = "medido, nada inline" (0 significaria "ainda não medido").
  const width =
    rowWidth === 0
      ? 0
      : rowWidth < ROOT_ROW_COMPACT_WIDTH
        ? 1
        : Math.min(rowWidth * 0.5, (ROOT_INLINE_MAX + 1) * ACTION_SLOT);
  return (
    <span className="tree-root-actions" ref={ref}>
      <ActionBar
        actions={actions}
        width={width}
        ariaLabel="Ações da pasta do workspace"
        moreLabel="Mais ações da pasta"
      />
    </span>
  );
}

/** A node currently being renamed inline. */
interface RenameTarget {
  path: string;
  name: string;
  isDir: boolean;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activePath: string | null;
  selectedDirectory: string | null;
  focusedPath: string | null;
  expandedPaths: ReadonlySet<string>;
  refreshVersion: number;
  pendingCreation: PendingCreation | null;
  creationBusy: boolean;
  creationError: string | null;
  renameTarget: RenameTarget | null;
  renameBusy: boolean;
  renameError: string | null;
  /** Path currently cut to the internal clipboard (dimmed), or null. */
  cutPath: string | null;
  onSelectDirectory: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  /** Clique simples abre em preview; duplo clique/Enter abre permanente. */
  onOpenFile: (node: FileNode, open?: { preview?: boolean }) => void;
  onSubmitCreation: (name: string) => void;
  onCancelCreation: () => void;
  onContextMenu: (event: React.MouseEvent, node: FileNode) => void;
  onFocusNode: (path: string) => void;
  onSubmitRename: (name: string) => void;
  onCancelRename: () => void;
  decorationFor: (path: string) => FileDecoration | undefined;
  loadChildren?: (node: FileNode) => Promise<FileNode[]>;
  workspaceRootKind?: "local" | "ssh";
  workspaceRootStatus?: "connected" | "connecting" | "error";
  workspaceRootSubtitle?: string;
  workspaceRootDisabled?: boolean;
  onConnectWorkspaceRoot?: (node: FileNode) => void;
  onDisconnectWorkspaceRoot?: (node: FileNode) => void;
  onRemoveWorkspaceRoot?: (node: FileNode) => void;
  onCreateWorkspaceRootFile?: (node: FileNode) => void;
  onCreateWorkspaceRootFolder?: (node: FileNode) => void;
  onRefreshWorkspaceRoot?: (node: FileNode) => void;
  onCollapseWorkspaceRoot?: (node: FileNode) => void;
}

export function TreeNode({
  node,
  depth,
  activePath,
  selectedDirectory,
  focusedPath,
  expandedPaths,
  refreshVersion,
  pendingCreation,
  creationBusy,
  creationError,
  renameTarget,
  renameBusy,
  renameError,
  cutPath,
  onSelectDirectory,
  onToggleDirectory,
  onOpenFile,
  onSubmitCreation,
  onCancelCreation,
  onContextMenu,
  onFocusNode,
  onSubmitRename,
  onCancelRename,
  decorationFor,
  loadChildren,
  workspaceRootKind,
  workspaceRootStatus,
  workspaceRootSubtitle,
  workspaceRootDisabled = false,
  onConnectWorkspaceRoot,
  onDisconnectWorkspaceRoot,
  onRemoveWorkspaceRoot,
  onCreateWorkspaceRootFile,
  onCreateWorkspaceRootFolder,
  onRefreshWorkspaceRoot,
  onCollapseWorkspaceRoot,
}: TreeNodeProps) {
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [childrenHeight, setChildrenHeight] = useState(0);
  const [renderChildren, setRenderChildren] = useState(false);
  const childrenInnerRef = useRef<HTMLDivElement>(null);
  const loadedVersionRef = useRef<number | null>(null);
  const expanded = node.isDir && expandedPaths.has(node.path);

  useEffect(() => {
    if (!expanded) {
      setLoading(false);
      return;
    }
    if (children !== null && loadedVersionRef.current === refreshVersion) return;
    let active = true;
    setLoading(true);
    (loadChildren ?? ((target: FileNode) => readDir(target.path)))(node)
      .then((entries) => {
        if (active) {
          setChildren(entries);
          loadedVersionRef.current = refreshVersion;
        }
      })
      .catch((error) => {
        console.error(error);
        if (active && children === null) setChildren([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // refreshVersion intentionally forces expanded folders to be read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, loadChildren, node, refreshVersion]);

  function activate() {
    onFocusNode(node.path);
    if (workspaceRootDisabled) return;
    if (!node.isDir) {
      onOpenFile(node, { preview: true });
      return;
    }
    onSelectDirectory(node.path);
    onToggleDirectory(node.path);
  }

  const isActive = !node.isDir && node.path === activePath;
  const isSelectedDirectory = node.isDir && node.path === selectedDirectory;
  const isFocused = node.path === focusedPath;
  const isCut = cutPath === node.path;
  // Files get the full decoration (git color/badge + diagnostics). Folders only
  // get a diagnostic decoration propagated from a descendant (deco.dir) — never
  // git, and never a badge — mirroring VSCode's folder tinting.
  const rawDeco = decorationFor(node.path);
  const deco = node.isDir ? (rawDeco?.dir ? rawDeco : undefined) : rawDeco;
  const beingRenamed = renameTarget?.path === node.path;
  const isWorkspaceRoot = depth === 0 && Boolean(workspaceRootKind);
  const hasExpandableChildren = node.isDir && !workspaceRootDisabled;
  const hasPendingCreation = pendingCreation?.parentPath === node.path;
  const shouldRenderChildren =
    hasExpandableChildren && (expanded || renderChildren || hasPendingCreation);

  useEffect(() => {
    if (!hasExpandableChildren) {
      if (renderChildren) setRenderChildren(false);
      return;
    }
    if (expanded || hasPendingCreation) {
      if (!renderChildren) setRenderChildren(true);
      return;
    }
    if (!renderChildren) return;

    const timeout = window.setTimeout(() => setRenderChildren(false), 130);
    return () => window.clearTimeout(timeout);
  }, [expanded, hasExpandableChildren, hasPendingCreation, renderChildren]);

  useLayoutEffect(() => {
    if (!shouldRenderChildren) return;
    const element = childrenInnerRef.current;
    if (!element) return;

    const measure = () => setChildrenHeight(element.scrollHeight);
    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }

    const timeout = window.setTimeout(measure, 0);
    return () => window.clearTimeout(timeout);
  }, [children, expanded, hasPendingCreation, loading, refreshVersion, shouldRenderChildren]);
  const rootAction =
    workspaceRootKind === "ssh"
      ? workspaceRootStatus === "connected"
        ? {
            label: "Desconectar root SSH",
            icon: "debugDisconnect" as const,
            run: onDisconnectWorkspaceRoot,
            disabled: false,
          }
        : {
            label: workspaceRootStatus === "connecting" ? "Conectando root SSH" : "Conectar root SSH",
            icon: workspaceRootStatus === "connecting" ? ("loading" as const) : ("remote" as const),
            run: onConnectWorkspaceRoot,
            disabled: workspaceRootStatus === "connecting",
          }
      : null;

  if (beingRenamed) {
    return (
      <ExplorerInlineRename
        path={node.path}
        initialName={node.name}
        isDir={node.isDir}
        depth={depth}
        busy={renameBusy}
        error={renameError}
        onSubmit={onSubmitRename}
        onCancel={onCancelRename}
      />
    );
  }

  return (
    <div className={isWorkspaceRoot ? "tree-node-wrap workspace-root-block" : "tree-node-wrap"}>
      <div
        id={`treeitem-${node.path}`}
        data-tree-path={node.path}
        data-tree-name={node.name}
        data-tree-dir={node.isDir ? "1" : "0"}
        data-tree-root-id={node.workspaceRootId}
        className={`tree-row${isWorkspaceRoot ? ` workspace-root-row workspace-root-${workspaceRootKind}` : ""}${workspaceRootDisabled ? " tree-row-disabled" : ""}${isActive ? " active" : ""}${
          isSelectedDirectory ? " directory-selected" : ""
        }${isFocused ? " focused" : ""}${isCut ? " cut" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={activate}
        onDoubleClick={() => {
          if (!node.isDir && !workspaceRootDisabled) onOpenFile(node, { preview: false });
        }}
        onContextMenu={(event) => onContextMenu(event, node)}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasExpandableChildren ? expanded : undefined}
        aria-selected={isActive || isSelectedDirectory || isFocused}
        title={node.path}
      >
        <span className={`tree-chevron${hasExpandableChildren ? " folder" : ""}${expanded ? " expanded" : ""}`}>
          {hasExpandableChildren && <Codicon name="chevronRight" size={12} />}
        </span>
        <FileIcon path={node.path} isDir={node.isDir} expanded={hasExpandableChildren && expanded} className="tree-icon" />
        <span className="tree-label-stack">
          <span className={`tree-label${deco ? ` deco-${deco.kind}` : ""}`}>{node.name}</span>
          {isWorkspaceRoot && workspaceRootSubtitle && (
            <span className="tree-root-subtitle">{workspaceRootSubtitle}</span>
          )}
        </span>
        {deco?.badge && <span className={`tree-badge deco-${deco.kind}`}>{deco.badge}</span>}
        {isWorkspaceRoot && (
          <WorkspaceRootActions
            actions={[
              ...(rootAction && workspaceRootStatus !== "connected"
                ? [{ id: "connect", icon: rootAction.icon, label: rootAction.label, disabled: rootAction.disabled, spin: rootAction.icon === "loading", run: () => rootAction.run?.(node) }]
                : []),
              ...(!workspaceRootDisabled && onCreateWorkspaceRootFile
                ? [{ id: "new-file", icon: "newFile" as const, label: "Novo arquivo nesta pasta", run: () => onCreateWorkspaceRootFile(node) }]
                : []),
              ...(!workspaceRootDisabled && onCreateWorkspaceRootFolder
                ? [{ id: "new-folder", icon: "newFolder" as const, label: "Nova pasta nesta pasta", run: () => onCreateWorkspaceRootFolder(node) }]
                : []),
              ...(!workspaceRootDisabled && onRefreshWorkspaceRoot
                ? [{ id: "refresh", icon: "refresh" as const, label: "Atualizar esta pasta", run: () => onRefreshWorkspaceRoot(node) }]
                : []),
              ...(!workspaceRootDisabled && onCollapseWorkspaceRoot
                ? [{
                    id: "collapse",
                    icon: expanded ? ("collapseAll" as const) : ("expandAll" as const),
                    label: expanded ? "Recolher esta pasta" : "Expandir esta pasta",
                    run: () => onCollapseWorkspaceRoot(node),
                  }]
                : []),
              ...(rootAction && workspaceRootStatus === "connected"
                ? [{ id: "disconnect", icon: rootAction.icon, label: rootAction.label, overflowOnly: true, run: () => rootAction.run?.(node) }]
                : []),
              ...(onRemoveWorkspaceRoot
                ? [{ id: "remove", icon: "close" as const, label: "Remover pasta do workspace", overflowOnly: true, run: () => onRemoveWorkspaceRoot(node) }]
                : []),
            ]}
          />
        )}
      </div>

      {shouldRenderChildren && (
        <div
          className={`tree-children${expanded ? " expanded" : ""}`}
          role="group"
          aria-hidden={!expanded}
          // Animated height (expand/collapse) + indent guide under this folder's
          // chevron (see `.tree-children::before`).
          style={
            {
              maxHeight: expanded ? childrenHeight : 0,
              "--tree-guide": `${depth * 12 + 12}px`,
            } as CSSProperties
          }
        >
          <div className="tree-children-inner" ref={childrenInnerRef}>
            {loading && (
              <div className="tree-row tree-muted" role="status" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>
                <Codicon name="loading" size={12} spin /> carregando…
              </div>
            )}
            {hasPendingCreation && (
              <ExplorerInlineCreation
                kind={pendingCreation.kind}
                depth={depth + 1}
                busy={creationBusy}
                error={creationError}
                onSubmit={onSubmitCreation}
                onCancel={onCancelCreation}
              />
            )}
            {children?.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                selectedDirectory={selectedDirectory}
                focusedPath={focusedPath}
                expandedPaths={expandedPaths}
                refreshVersion={refreshVersion}
                pendingCreation={pendingCreation}
                creationBusy={creationBusy}
                creationError={creationError}
                renameTarget={renameTarget}
                renameBusy={renameBusy}
                renameError={renameError}
                cutPath={cutPath}
                onSelectDirectory={onSelectDirectory}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
                onSubmitCreation={onSubmitCreation}
                onCancelCreation={onCancelCreation}
                onContextMenu={onContextMenu}
                onFocusNode={onFocusNode}
                onSubmitRename={onSubmitRename}
                onCancelRename={onCancelRename}
                decorationFor={decorationFor}
                loadChildren={loadChildren}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
