import type { FileNode, FileDecoration } from "../types";
import { TreeNode } from "./TreeNode";

interface FileExplorerProps {
  /** Root folder name (e.g. "my-project"), or null when nothing is open. */
  rootName: string | null;
  /** Top-level entries of the open folder. */
  roots: FileNode[];
  activePath: string | null;
  onOpenFolder: () => void;
  onOpenFile: (node: FileNode) => void;
  /** Resolves the git/diagnostic decoration for a path; default = none. */
  decorationFor?: (path: string) => FileDecoration | undefined;
}

/** The left sidebar: a header with the folder name and the file tree. */
export function FileExplorer({
  rootName,
  roots,
  activePath,
  onOpenFolder,
  onOpenFile,
  decorationFor = () => undefined,
}: FileExplorerProps) {
  return (
    <div className="explorer">
      <div className="explorer-header">
        <span className="explorer-title">
          {rootName ?? "EXPLORADOR"}
        </span>
        <button className="explorer-open-btn" onClick={onOpenFolder} title="Abrir pasta">
          Abrir pasta
        </button>
      </div>

      <div className="explorer-tree">
        {roots.length === 0 ? (
          <div className="explorer-empty">
            Nenhuma pasta aberta.
            <br />
            <button className="link-btn" onClick={onOpenFolder}>
              Abrir uma pasta
            </button>
          </div>
        ) : (
          roots.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              onOpenFile={onOpenFile}
              decorationFor={decorationFor}
            />
          ))
        )}
      </div>
    </div>
  );
}
