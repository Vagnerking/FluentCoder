import { useState } from "react";
import type { FileNode, FileDecoration } from "../types";
import { readDir } from "../api";
import { FileIcon } from "../icon-theme/material/FileIcon";
import { Codicon } from "../icons/codicons/Codicon";

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (node: FileNode) => void;
  /** Resolves the git/diagnostic decoration for a path (color + badge). */
  decorationFor: (path: string) => FileDecoration | undefined;
}

/**
 * One row in the explorer tree. Folders expand lazily — children are fetched
 * the first time the folder is opened, then cached in local state.
 *
 * Icons come from the Material Icon Theme via {@link FileIcon}; file state
 * (modified/new/error/warning) is shown by coloring the label and a trailing
 * git badge, mirroring VSCode's explorer decorations.
 */
export function TreeNode({
  node,
  depth,
  activePath,
  onOpenFile,
  decorationFor,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (!node.isDir) {
      onOpenFile(node);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoading(true);
      try {
        setChildren(await readDir(node.path));
      } catch (err) {
        console.error(err);
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  }

  const isActive = !node.isDir && node.path === activePath;
  const deco = node.isDir ? undefined : decorationFor(node.path);

  return (
    <div>
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={toggle}
        title={node.path}
      >
        <span
          className={`tree-chevron${node.isDir ? " folder" : ""}${expanded ? " expanded" : ""}`}
        >
          {node.isDir && <Codicon name="chevronRight" size={12} />}
        </span>
        <FileIcon
          path={node.path}
          isDir={node.isDir}
          expanded={expanded}
          className="tree-icon"
        />
        <span
          className={`tree-label${deco ? ` deco-${deco.kind}` : ""}`}
        >
          {node.name}
        </span>
        {deco?.badge && (
          <span className={`tree-badge deco-${deco.kind}`}>{deco.badge}</span>
        )}
      </div>

      {node.isDir && (
        <div className={`tree-children${expanded ? " expanded" : ""}`}>
          <div className="tree-children-inner">
            {loading && (
              <div
                className="tree-row tree-muted"
                style={{ paddingLeft: (depth + 1) * 12 + 6 }}
              >
                <Codicon name="loading" size={12} /> carregando…
              </div>
            )}
            {children?.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
                decorationFor={decorationFor}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
