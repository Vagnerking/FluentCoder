import assert from "node:assert/strict";
import test from "node:test";
import { applySpatialRepulsion } from "./physics.ts";

test("spatial repulsion applies equal and opposite force", () => {
  const nodes = [
    { x: -10, y: 0, vx: 0, vy: 0 },
    { x: 10, y: 0, vx: 0, vy: 0 },
  ];
  assert.equal(applySpatialRepulsion(nodes), 1);
  assert.ok(nodes[0].vx < 0);
  assert.ok(nodes[1].vx > 0);
  assert.ok(Math.abs(nodes[0].vx + nodes[1].vx) < 1e-9);
});

test("4,000 spread nodes avoid all-pairs work", () => {
  const nodes = Array.from({ length: 4000 }, (_, index) => ({
    x: (index % 80) * 42,
    y: Math.floor(index / 80) * 42,
    vx: 0,
    vy: 0,
  }));
  const examined = applySpatialRepulsion(nodes);
  const allPairs = (nodes.length * (nodes.length - 1)) / 2;
  assert.ok(examined < allPairs / 20, `${examined} candidates should be far below ${allPairs}`);
});
