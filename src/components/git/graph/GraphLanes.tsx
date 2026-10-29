import { memo } from "react";
import {
  LANE_GEOMETRY,
  edgePath,
  hiddenLaneCount,
  isPathEdge,
  laneX,
  projectLane,
  type GraphRowLayout,
} from "../../../git/graphLayout";

export type GraphNodeMarker = "normal" | "head" | "incoming" | "outgoing";

interface GraphLanesProps {
  row: GraphRowLayout;
  /** Largura do SVG em lanes visíveis (inclui a coluna de transbordo). */
  lanes: number;
  maxLanes: number;
  marker: GraphNodeMarker;
  /** Linhagem ativa: caminho destacado (o resto esmaece). */
  path: ReadonlySet<string> | null;
  /** Largura de cada lane (px); menor na sidebar estreita. */
  laneWidth?: number;
}

const H = LANE_GEOMETRY.rowHeight;
const MID = H / 2;
const R = LANE_GEOMETRY.nodeRadius;

function color(index: number): string {
  return `var(--graph-lane-${index})`;
}

/**
 * Trilhos de UMA linha (o grafo é virtualizado: só as linhas visíveis
 * desenham). Lanes além de `maxLanes` dobram numa coluna tracejada "+N".
 */
export const GraphLanes = memo(function GraphLanes({
  row,
  lanes,
  maxLanes,
  marker,
  path,
  laneWidth = LANE_GEOMETRY.laneWidth,
}: GraphLanesProps) {
  const pad = laneWidth < LANE_GEOMETRY.laneWidth ? 4 : LANE_GEOMETRY.padding;
  const width = pad * 2 + lanes * laneWidth;
  const x = (lane: number) => laneX(projectLane(lane, maxLanes), laneWidth, pad);
  const overflow = (lane: number) => lane >= maxLanes;
  const onPath = path?.has(row.hash) ?? false;
  const dim = (lit: boolean) => (path ? (lit ? " is-lit" : " is-dim") : "");
  const nodeX = x(row.lane);
  const hidden = hiddenLaneCount(row, maxLanes);
  const seenOverflow = new Set<string>();

  return (
    <svg className="graph-lanes" width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true">
      {row.pass.map((p) => {
        // Várias lanes no transbordo viram um só traço.
        if (overflow(p.lane)) {
          if (seenOverflow.has("pass")) return null;
          seenOverflow.add("pass");
        }
        return (
          <path
            key={`p${p.lane}`}
            d={`M${x(p.lane)} 0V${H}`}
            stroke={color(p.color)}
            className={`graph-edge${overflow(p.lane) ? " is-overflow" : ""}${dim(isPathEdge(p.target, null, path ?? EMPTY))}`}
          />
        );
      })}
      {row.top.map((t) => (
        <path
          key={`t${t.lane}`}
          d={edgePath(x(t.lane), 0, nodeX, MID)}
          stroke={color(t.color)}
          className={`graph-edge${overflow(t.lane) ? " is-overflow" : ""}${dim(onPath && t.lane === row.lane)}`}
        />
      ))}
      {row.bottom.map((b) => (
        <path
          key={`b${b.lane}-${b.target}`}
          d={edgePath(nodeX, MID, x(b.lane), H)}
          stroke={color(b.color)}
          className={`graph-edge${b.merge ? " is-merge" : ""}${overflow(b.lane) ? " is-overflow" : ""}${dim(
            onPath && isPathEdge(b.target, row.hash, path ?? EMPTY)
          )}`}
        />
      ))}
      <GraphNode x={nodeX} color={row.color} merge={row.isMerge} marker={marker} className={dim(onPath)} />
      {hidden > 0 && (
        <text className="graph-overflow-label" x={laneX(maxLanes, laneWidth, pad)} y={H - 2} textAnchor="middle">
          +{hidden}
        </text>
      )}
    </svg>
  );
});

const EMPTY: ReadonlySet<string> = new Set();

function GraphNode({
  x,
  color: index,
  merge,
  marker,
  className,
}: {
  x: number;
  color: number;
  merge: boolean;
  marker: GraphNodeMarker;
  className: string;
}) {
  const stroke = color(index);
  if (marker === "head") {
    // HEAD: anel duplo (VS Code).
    return (
      <g className={`graph-node is-head${className}`}>
        <circle cx={x} cy={MID} r={R + 1.5} fill="var(--graph-node-bg)" stroke={stroke} strokeWidth={2} />
        <circle cx={x} cy={MID} r={R - 1.5} fill={stroke} />
      </g>
    );
  }
  if (marker === "incoming") {
    return (
      <circle
        className={`graph-node is-incoming${className}`}
        cx={x}
        cy={MID}
        r={R}
        fill="var(--graph-node-bg)"
        stroke={stroke}
        strokeWidth={1.5}
        strokeDasharray="2 1.5"
      />
    );
  }
  if (merge) {
    return (
      <g className={`graph-node is-merge${className}`}>
        <circle cx={x} cy={MID} r={R} fill="var(--graph-node-bg)" stroke={stroke} strokeWidth={2} />
        <circle cx={x} cy={MID} r={1.5} fill={stroke} />
      </g>
    );
  }
  return (
    <circle
      className={`graph-node${marker === "outgoing" ? " is-outgoing" : ""}${className}`}
      cx={x}
      cy={MID}
      r={R}
      fill={stroke}
      stroke="var(--graph-node-bg)"
      strokeWidth={1.5}
    />
  );
}
