export interface PhysicsNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Applies short-range repulsion using a uniform spatial grid. Returns the
 * number of candidate pairs examined, which makes the complexity observable in
 * tests and guards against accidentally restoring an all-pairs loop.
 */
export function applySpatialRepulsion(
  nodes: readonly PhysicsNode[],
  cellSize = 110,
  strength = 2600
): number {
  const cutoff = cellSize;
  const cutoff2 = cutoff * cutoff;
  const grid = new Map<string, number[]>();

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const cellX = Math.floor(node.x / cellSize);
    const cellY = Math.floor(node.y / cellSize);
    const key = `${cellX}:${cellY}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  }

  let examined = 0;
  for (let index = 0; index < nodes.length; index++) {
    const first = nodes[index];
    const cellX = Math.floor(first.x / cellSize);
    const cellY = Math.floor(first.y / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const bucket = grid.get(`${cellX + offsetX}:${cellY + offsetY}`);
        if (!bucket) continue;
        for (const otherIndex of bucket) {
          if (otherIndex <= index) continue;
          examined++;
          const second = nodes[otherIndex];
          let dx = first.x - second.x;
          let dy = first.y - second.y;
          let distance2 = dx * dx + dy * dy;
          if (distance2 > cutoff2) continue;
          if (distance2 < 0.01) {
            dx = (index - otherIndex) * 0.1 + 0.1;
            dy = 0.1;
            distance2 = dx * dx + dy * dy;
          }
          const force = Math.min(3.2, strength / distance2) * (1 - distance2 / cutoff2);
          const distance = Math.sqrt(distance2);
          first.vx += (dx / distance) * force;
          first.vy += (dy / distance) * force;
          second.vx -= (dx / distance) * force;
          second.vy -= (dy / distance) * force;
        }
      }
    }
  }
  return examined;
}
