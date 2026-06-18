import { useState } from "react";
import type { FileNode } from "../types";
import { readDir } from "../api";

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (node: FileNode) => void;
}

/**
 * One row in the explorer tree. Folders expand lazily — children are fetched
 * the first time the folder is opened, then cached in local state.
 */
export function TreeNode({ node, depth, activePath, onOpenFile }: TreeNodeProps) {
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
  const chevron = node.isDir ? (expanded ? "▾" : "▸") : "";
  const icon = node.isDir ? "📁" : "📄";

  return (
    <div>
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={toggle}
        title={node.path}
      >
        <span className="tree-chevron">{chevron}</span>
        <span className="tree-icon">{icon}</span>
        <span className="tree-label">{node.name}</span>
      </div>

      {expanded && (
        <div>
          {loading && (
            <div
              className="tree-row tree-muted"
              style={{ paddingLeft: (depth + 1) * 12 + 6 }}
            >
              carregando…
            </div>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
