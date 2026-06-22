import { Fragment } from "react";
import { groupOrder, type LayoutNode, type Orientation } from "../editorGroups";

export interface EditorGridProps {
  node: LayoutNode;
  /** Renders one group's content (App owns the per-group handlers). */
  renderGroup: (groupId: string) => React.ReactNode;
  /** Sets the two adjacent pane weights at a split handle. */
  onResize: (
    branchPath: number[],
    index: number,
    left: number,
    right: number
  ) => void;
  /** Internal: path of child indices from the root to this node. */
  branchPath?: number[];
}

/** A draggable handle between two panes of a split; resizes them live. */
function SplitHandle({
  orientation,
  onResize,
}: {
  orientation: Orientation;
  onResize: (fracLeft: number, fracRight: number) => void;
}) {
  const horiz = orientation === "row";
  return (
    <div
      className={`split-handle split-${orientation}`}
      onPointerDown={(e) => {
        const handle = e.currentTarget;
        const prev = handle.previousElementSibling as HTMLElement | null;
        const next = handle.nextElementSibling as HTMLElement | null;
        if (!prev || !next) return;
        handle.setPointerCapture(e.pointerId);
        const start = horiz ? e.clientX : e.clientY;
        const aStart = horiz ? prev.offsetWidth : prev.offsetHeight;
        const bStart = horiz ? next.offsetWidth : next.offsetHeight;
        const total = aStart + bStart;
        const MIN = 80;
        const move = (me: PointerEvent) => {
          const delta = (horiz ? me.clientX : me.clientY) - start;
          const a = Math.max(MIN, Math.min(aStart + delta, total - MIN));
          onResize(a / total, (total - a) / total);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

/** Recursively renders the editor split grid: branches as flex rows/columns
 *  with resize handles between panes, leaves as group content. */
export function EditorGrid({
  node,
  renderGroup,
  onResize,
  branchPath = [],
}: EditorGridProps) {
  if (node.type === "leaf") {
    return <>{renderGroup(node.group)}</>;
  }
  return (
    <div className={`editor-split editor-split-${node.orientation}`}>
      {node.children.map((child, i) => (
        // Key by the subtree's leftmost group id (stable across inserts), so
        // adding a sibling split doesn't reshuffle keys and remount Monaco.
        <Fragment key={groupOrder(child)[0] ?? i}>
          <div className="editor-split-pane" style={{ flexGrow: node.sizes[i] }}>
            <EditorGrid
              node={child}
              renderGroup={renderGroup}
              onResize={onResize}
              branchPath={[...branchPath, i]}
            />
          </div>
          {i < node.children.length - 1 && (
            <SplitHandle
              orientation={node.orientation}
              onResize={(fl, fr) => {
                const pair = node.sizes[i] + node.sizes[i + 1];
                onResize(branchPath, i, pair * fl, pair * fr);
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
