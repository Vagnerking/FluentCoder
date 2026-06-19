import { useEffect, useState } from "react";
import type { FileNode, FileDecoration } from "../types";
import { readDir } from "../api";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";
import {
  ExplorerInlineCreation,
  type PendingCreation,
} from "./ExplorerInlineCreation";

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activePath: string | null;
  selectedDirectory: string | null;
  expandedPaths: ReadonlySet<string>;
  refreshVersion: number;
  pendingCreation: PendingCreation | null;
  creationBusy: boolean;
  creationError: string | null;
  onSelectDirectory: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (node: FileNode) => void;
  onSubmitCreation: (name: string) => void;
  onCancelCreation: () => void;
  decorationFor: (path: string) => FileDecoration | undefined;
}

export function TreeNode({
  node,
  depth,
  activePath,
  selectedDirectory,
  expandedPaths,
  refreshVersion,
  pendingCreation,
  creationBusy,
  creationError,
  onSelectDirectory,
  onToggleDirectory,
  onOpenFile,
  onSubmitCreation,
  onCancelCreation,
  decorationFor,
}: TreeNodeProps) {
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const expanded = node.isDir && expandedPaths.has(node.path);

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setLoading(true);
    readDir(node.path)
      .then((entries) => {
        if (active) setChildren(entries);
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
  }, [expanded, node.path, refreshVersion]);

  function activate() {
    if (!node.isDir) {
      onOpenFile(node);
      return;
    }
    onSelectDirectory(node.path);
    onToggleDirectory(node.path);
  }

  const isActive = !node.isDir && node.path === activePath;
  const isSelectedDirectory = node.isDir && node.path === selectedDirectory;
  const deco = node.isDir ? undefined : decorationFor(node.path);

  return (
    <div>
      <div
        className={`tree-row${isActive ? " active" : ""}${isSelectedDirectory ? " directory-selected" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activate();
          }
        }}
        role="treeitem"
        tabIndex={0}
        aria-expanded={node.isDir ? expanded : undefined}
        aria-selected={isActive || isSelectedDirectory}
        title={node.path}
      >
        <span className={`tree-chevron${node.isDir ? " folder" : ""}${expanded ? " expanded" : ""}`}>
          {node.isDir && <Codicon name="chevronRight" size={12} />}
        </span>
        <FileIcon path={node.path} isDir={node.isDir} expanded={expanded} className="tree-icon" />
        <span className={`tree-label${deco ? ` deco-${deco.kind}` : ""}`}>{node.name}</span>
        {deco?.badge && <span className={`tree-badge deco-${deco.kind}`}>{deco.badge}</span>}
      </div>

      {node.isDir && (
        <div className={`tree-children${expanded ? " expanded" : ""}`} role="group">
          <div className="tree-children-inner">
            {loading && (
              <div className="tree-row tree-muted" role="status" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>
                <Codicon name="loading" size={12} spin /> carregando…
              </div>
            )}
            {pendingCreation?.parentPath === node.path && (
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
                expandedPaths={expandedPaths}
                refreshVersion={refreshVersion}
                pendingCreation={pendingCreation}
                creationBusy={creationBusy}
                creationError={creationError}
                onSelectDirectory={onSelectDirectory}
                onToggleDirectory={onToggleDirectory}
                onOpenFile={onOpenFile}
                onSubmitCreation={onSubmitCreation}
                onCancelCreation={onCancelCreation}
                decorationFor={decorationFor}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
