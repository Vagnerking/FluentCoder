import assert from "node:assert/strict";
import test from "node:test";
import {
  createGraphIslandInfo,
  createGraphIslandKeys,
  createGraphLayout,
  createGraphLayoutSnapshot,
  graphFolder,
  graphIslandLabel,
} from "./layout.ts";

test("graphFolder normalizes separators and keeps root files together", () => {
  assert.equal(graphFolder("src/components/App.tsx"), "src");
  assert.equal(graphFolder("docs\\guide.md"), "docs");
  assert.equal(graphFolder("README.md"), "Raiz");
});

test("graphIslandLabel names sub-projects from the shared path prefix", () => {
  assert.equal(graphIslandLabel([{ id: "api", rel: "src/api/index.ts", degree: 0 }]), "api");
  assert.equal(
    graphIslandLabel([
      { id: "api-a", rel: "src/api/controllers/a.ts", degree: 1 },
      { id: "api-b", rel: "src/api/services/b.ts", degree: 1 },
    ]),
    "api"
  );
  assert.equal(graphIslandLabel([{ id: "readme", rel: "README.md", degree: 0 }]), "README.md");
});

test("colony layout is deterministic and separates top-level folders", () => {
  const nodes = [
    { id: "a", rel: "src/a.ts", degree: 4 },
    { id: "b", rel: "src/b.ts", degree: 1 },
    { id: "c", rel: "docs/c.md", degree: 3 },
    { id: "d", rel: "docs/d.md", degree: 0 },
  ];
  const first = createGraphLayout(nodes, "colony");
  const second = createGraphLayout(nodes, "colony");
  assert.deepEqual(Array.from(first), Array.from(second));

  const src = first.get("a")!;
  const docs = first.get("c")!;
  assert.ok(Math.hypot(src.x - docs.x, src.y - docs.y) > 150);
});

test("the highest-degree node anchors each colony centre", () => {
  const layout = createGraphLayout(
    [
      { id: "leaf", rel: "src/leaf.ts", degree: 1, links: ["hub"] },
      { id: "hub", rel: "src/hub.ts", degree: 8, links: ["leaf"] },
    ],
    "colony"
  );
  assert.deepEqual(layout.get("hub"), { x: 0, y: 0 });
  assert.notDeepEqual(layout.get("leaf"), { x: 0, y: 0 });
});

test("disconnected projects in the same folder get separate island space", () => {
  const layout = createGraphLayout(
    [
      { id: "api", rel: "src/api/index.ts", degree: 0, links: [] },
      { id: "web", rel: "src/web/index.ts", degree: 0, links: [] },
      { id: "worker", rel: "src/worker/index.ts", degree: 0, links: [] },
    ],
    "colony"
  );
  const points = ["api", "web", "worker"].map((id) => layout.get(id)!);
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      assert.ok(
        Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 150,
        "unrelated same-folder nodes should not be visually glued together"
      );
    }
  }
  const centroid = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), {
    x: 0,
    y: 0,
  });
  centroid.x /= points.length;
  centroid.y /= points.length;
  assert.ok(Math.hypot(centroid.x, centroid.y) < 1, "small unrelated colonies should stay balanced");
});

test("multi-file projects in the same folder form a balanced colony triangle", () => {
  const projects = ["api", "web", "worker"];
  const nodes = projects.flatMap((project) =>
    Array.from({ length: 5 }, (_, index) => ({
      id: `${project}-${index}`,
      rel: `src/${project}/file-${index}.ts`,
      degree: index === 0 ? 4 : 1,
      links:
        index === 0
          ? Array.from({ length: 4 }, (_, child) => `${project}-${child + 1}`)
          : [`${project}-0`],
    }))
  );
  const layout = createGraphLayout(nodes, "colony");
  const centers = projects.map((project) => {
    const points = nodes
      .filter((node) => node.id.startsWith(`${project}-`))
      .map((node) => layout.get(node.id)!);
    return points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 }
    );
  });
  const distances: number[] = [];
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      distances.push(Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y));
    }
  }
  const min = Math.min(...distances);
  const max = Math.max(...distances);
  assert.ok(min > 260, `project islands should have clear breathing room, got ${min}`);
  assert.ok(max / min < 1.25, `three sibling projects should read as a balanced triangle, got ${max / min}`);
});

test("many mixed sibling projects keep minimum visual breathing room", () => {
  const projects = Array.from({ length: 12 }, (_, index) => `project-${index}`);
  const nodes = projects.flatMap((project) =>
    Array.from({ length: 5 }, (_, index) => ({
      id: `${project}-${index}`,
      rel: `src/${project}/file-${index}.ts`,
      degree: index === 0 ? 4 : 1,
      links:
        index === 0
          ? Array.from({ length: 4 }, (_, child) => `${project}-${child + 1}`)
          : [`${project}-0`],
    }))
  );
  const layout = createGraphLayout(nodes, "colony");
  const centers = projects.map((project) => {
    const points = nodes
      .filter((node) => node.id.startsWith(`${project}-`))
      .map((node) => layout.get(node.id)!);
    return points.reduce(
      (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
      { x: 0, y: 0 }
    );
  });

  let nearest = Infinity;
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      nearest = Math.min(nearest, Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y));
    }
  }
  assert.ok(nearest > 300, `candidate fallback should not squeeze sibling projects, got ${nearest}`);
});

test("island keys match connected components inside each folder", () => {
  const keys = createGraphIslandKeys([
    { id: "api-a", rel: "src/api/a.ts", degree: 1, links: ["api-b"] },
    { id: "api-b", rel: "src/api/b.ts", degree: 1, links: ["api-a"] },
    { id: "web", rel: "src/web/index.ts", degree: 0, links: [] },
    { id: "doc", rel: "docs/readme.md", degree: 0, links: [] },
  ]);
  assert.equal(keys.get("api-a"), keys.get("api-b"));
  assert.notEqual(keys.get("api-a"), keys.get("web"));
  assert.notEqual(keys.get("web"), keys.get("doc"));
});

test("files from the same sub-project form one visual island even without direct links", () => {
  const keys = createGraphIslandKeys([
    { id: "api-controller", rel: "src/api/controller.ts", degree: 0, links: [] },
    { id: "api-model", rel: "src/api/model.ts", degree: 0, links: [] },
    { id: "web-page", rel: "src/web/page.tsx", degree: 0, links: [] },
  ]);
  assert.equal(
    keys.get("api-controller"),
    keys.get("api-model"),
    "same sub-project files should not fragment into visual noise"
  );
  assert.notEqual(keys.get("api-controller"), keys.get("web-page"));
});

test("island info carries stable keys and readable labels", () => {
  const info = createGraphIslandInfo([
    { id: "api-a", rel: "src/api/a.ts", degree: 1, links: ["api-b"] },
    { id: "api-b", rel: "src/api/b.ts", degree: 1, links: ["api-a"] },
    { id: "web", rel: "src/web/index.ts", degree: 0, links: [] },
  ]);
  assert.equal(info.get("api-a")?.key, info.get("api-b")?.key);
  assert.equal(info.get("api-a")?.label, "api");
  assert.equal(info.get("web")?.label, "web");
});

test("layout snapshot keeps positions and island info consistent with public helpers", () => {
  const nodes = [
    { id: "api-a", rel: "src/api/a.ts", degree: 1, links: ["api-b"] },
    { id: "api-b", rel: "src/api/b.ts", degree: 1, links: ["api-a"] },
    { id: "web", rel: "src/web/index.ts", degree: 0, links: [] },
  ];
  const snapshot = createGraphLayoutSnapshot(nodes, "colony");
  assert.deepEqual(Array.from(snapshot.positions), Array.from(createGraphLayout(nodes, "colony")));
  assert.deepEqual(Array.from(snapshot.islandInfo), Array.from(createGraphIslandInfo(nodes)));
});

test("many unrelated nodes in one folder stay packed but readable", () => {
  const nodes = Array.from({ length: 200 }, (_, index) => ({
    id: `project-${index}`,
    rel: `src/project-${index}/index.ts`,
    degree: 0,
    links: [] as string[],
  }));
  const layout = createGraphLayout(nodes, "colony");
  const points = nodes.map((node) => layout.get(node.id)!);
  let nearest = Infinity;
  let farthest = 0;
  for (let i = 0; i < points.length; i++) {
    farthest = Math.max(farthest, Math.hypot(points[i].x, points[i].y));
    for (let j = i + 1; j < points.length; j++) {
      nearest = Math.min(
        nearest,
        Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
      );
    }
  }
  assert.ok(nearest > 150, `nearest unrelated islands should breathe, got ${nearest}`);
  assert.ok(farthest < 2100, `large same-folder colonies should not explode, got ${farthest}`);
});

test("dense sibling colonies reserve enough room for their actual island spread", () => {
  const nodes = Array.from({ length: 300 }, (_, index) => {
    const folder = index < 150 ? "apps" : "packages";
    const project = index % 150;
    return {
      id: `${folder}-${project}`,
      rel: `${folder}/project-${project}/index.ts`,
      degree: 0,
      links: [] as string[],
    };
  });
  const layout = createGraphLayout(nodes, "colony");
  const apps = nodes.slice(0, 150).map((node) => layout.get(node.id)!);
  const packages = nodes.slice(150).map((node) => layout.get(node.id)!);
  let nearestCrossFolder = Infinity;
  for (const a of apps) {
    for (const b of packages) {
      nearestCrossFolder = Math.min(nearestCrossFolder, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  assert.ok(
    nearestCrossFolder > 110,
    `dense colonies should not visually invade each other, got ${nearestCrossFolder}`
  );
});

test("connected islands use a regular honeycomb around their hub", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    id: `node-${index}`,
    rel: `src/feature/node-${index}.ts`,
    degree: index === 0 ? 11 : 1,
    links: index === 0 ? Array.from({ length: 11 }, (_, child) => `node-${child + 1}`) : ["node-0"],
  }));
  const layout = createGraphLayout(nodes, "colony");
  const hub = layout.get("node-0")!;
  assert.deepEqual(hub, { x: 0, y: 0 });
  for (let index = 1; index <= 6; index++) {
    const point = layout.get(`node-${index}`)!;
    assert.ok(
      Math.hypot(point.x - hub.x, point.y - hub.y) > 40,
      "first ring should not collapse into the hub"
    );
  }
});

test("organic layout keeps heavily linked children around their parent hub", () => {
  const nodes = [
    {
      id: "hub",
      rel: "src/hub.ts",
      degree: 12,
      links: Array.from({ length: 12 }, (_, index) => `leaf-${index}`),
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `leaf-${index}`,
      rel: `src/leaf-${index}.ts`,
      degree: 1,
      links: ["hub"],
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `loose-${index}`,
      rel: `docs/loose-${index}.md`,
      degree: 0,
      links: [] as string[],
    })),
  ];
  const layout = createGraphLayout(nodes, "organic");
  const hub = layout.get("hub")!;
  const leafDistances = Array.from({ length: 12 }, (_, index) => {
    const leaf = layout.get(`leaf-${index}`)!;
    return Math.hypot(leaf.x - hub.x, leaf.y - hub.y);
  });
  assert.ok(Math.max(...leafDistances) < 150, "hub children should read as one micro-cell");
  assert.ok(Math.min(...leafDistances) > 30, "children should not collapse onto their parent");
});

test("organic snapshot models hub clusters as invisible cells", () => {
  const nodes = [
    {
      id: "hub",
      rel: "docs/hub.md",
      degree: 9,
      links: Array.from({ length: 5 }, (_, index) => `ref-${index}`),
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `ref-${index}`,
      rel: `docs/ref-${index}.md`,
      degree: 1,
      links: ["hub"],
    })),
    { id: "loose", rel: "docs/loose.md", degree: 0, links: [] as string[] },
  ];
  const snapshot = createGraphLayoutSnapshot(nodes, "organic");
  const hubCell = snapshot.cellInfo.get("hub");
  assert.ok(hubCell, "hub should define an invisible cluster");
  for (let index = 0; index < 5; index++) {
    assert.equal(
      snapshot.cellInfo.get(`ref-${index}`)?.key,
      hubCell.key,
      "directly referenced files should agglomerate around the hub"
    );
  }
  assert.notEqual(
    snapshot.cellInfo.get("loose")?.key,
    hubCell.key,
    "unrelated files should stay outside the hub cluster"
  );
});

test("organic snapshot prefers incoming-reference hubs when clusters compete", () => {
  const nodes = [
    {
      id: "referenced-hub",
      rel: "docs/referenced-hub.md",
      degree: 3,
      refs: 3,
      links: ["shared", "ref-a", "ref-b"],
    },
    {
      id: "outgoing-hub",
      rel: "docs/outgoing-hub.md",
      degree: 3,
      refs: 0,
      links: ["shared", "out-a", "out-b"],
    },
    { id: "shared", rel: "docs/shared.md", degree: 2, links: ["referenced-hub", "outgoing-hub"] },
    { id: "ref-a", rel: "docs/ref-a.md", degree: 1, links: ["referenced-hub"] },
    { id: "ref-b", rel: "docs/ref-b.md", degree: 1, links: ["referenced-hub"] },
    { id: "out-a", rel: "docs/out-a.md", degree: 1, links: ["outgoing-hub"] },
    { id: "out-b", rel: "docs/out-b.md", degree: 1, links: ["outgoing-hub"] },
  ];
  const snapshot = createGraphLayoutSnapshot(nodes, "organic");
  const referencedCell = snapshot.cellInfo.get("referenced-hub");
  assert.ok(referencedCell, "incoming-reference hub should form the first competing cluster");
  assert.equal(
    snapshot.cellInfo.get("shared")?.key,
    referencedCell.key,
    "shared references should gravitate to the hub that is referenced more often"
  );
});

test("organic layout keeps local references tighter than cross-cluster references", () => {
  const makeCluster = (prefix: string, refs: number) => [
    {
      id: `${prefix}-hub`,
      rel: `docs/${prefix}/hub.md`,
      degree: 7,
      refs,
      links: [
        ...Array.from({ length: 6 }, (_, index) => `${prefix}-leaf-${index}`),
        prefix === "alpha" ? "beta-hub" : "alpha-hub",
      ],
    },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `${prefix}-leaf-${index}`,
      rel: `docs/${prefix}/leaf-${index}.md`,
      degree: 1,
      links: [`${prefix}-hub`],
    })),
  ];
  const nodes = [...makeCluster("alpha", 8), ...makeCluster("beta", 5)];
  const snapshot = createGraphLayoutSnapshot(nodes, "organic");
  const alphaHub = snapshot.positions.get("alpha-hub")!;
  const betaHub = snapshot.positions.get("beta-hub")!;
  const alphaLeafDistances = Array.from({ length: 6 }, (_, index) => {
    const leaf = snapshot.positions.get(`alpha-leaf-${index}`)!;
    return Math.hypot(leaf.x - alphaHub.x, leaf.y - alphaHub.y);
  });
  const betaLeafDistances = Array.from({ length: 6 }, (_, index) => {
    const leaf = snapshot.positions.get(`beta-leaf-${index}`)!;
    return Math.hypot(leaf.x - betaHub.x, leaf.y - betaHub.y);
  });
  const localMax = Math.max(...alphaLeafDistances, ...betaLeafDistances);
  const crossHubDistance = Math.hypot(alphaHub.x - betaHub.x, alphaHub.y - betaHub.y);
  assert.ok(localMax < 95, `local references should stay visually tight, got ${localMax}`);
  assert.ok(
    crossHubDistance > localMax * 2.2,
    `cross-cluster references should breathe: local ${localMax}, cross ${crossHubDistance}`
  );
});

test("organic snapshot agglomerates the dominant relation type around a hub", () => {
  const wikiRefs = Array.from({ length: 4 }, (_, index) => `wiki-${index}`);
  const importRefs = Array.from({ length: 3 }, (_, index) => `import-${index}`);
  const nodes = [
    {
      id: "hub",
      rel: "docs/hub.md",
      degree: wikiRefs.length + importRefs.length,
      refs: wikiRefs.length + importRefs.length,
      relations: [
        ...wikiRefs.map((target) => ({ target, kind: "wikilink" as const })),
        ...importRefs.map((target) => ({ target, kind: "import" as const })),
      ],
    },
    ...wikiRefs.map((id) => ({ id, rel: `docs/${id}.md`, degree: 1, refs: 0 })),
    ...importRefs.map((id) => ({ id, rel: `src/${id}.ts`, degree: 1, refs: 0 })),
  ];
  const snapshot = createGraphLayoutSnapshot(nodes, "organic");
  const hubCell = snapshot.cellInfo.get("hub");
  assert.equal(hubCell?.relationKind, "wikilink");
  const importCell = snapshot.cellInfo.get(importRefs[0]);
  for (const id of wikiRefs) {
    assert.equal(
      snapshot.cellInfo.get(id)?.key,
      hubCell?.key,
      "dominant wikilink references should stay in the hub core"
    );
  }
  for (const id of importRefs) {
    assert.notEqual(
      snapshot.cellInfo.get(id)?.key,
      hubCell?.key,
      "secondary import references should not be glued into the wikilink core"
    );
    assert.equal(
      snapshot.cellInfo.get(id)?.key,
      importCell?.key,
      "secondary import references should still agglomerate in their own satellite cell"
    );
    assert.equal(
      snapshot.cellInfo.get(id)?.hubId,
      hubCell?.hubId,
      "secondary relation satellites should stay anchored to the same hub"
    );
  }
  assert.equal(importCell?.relationKind, "import");
  const hubPoint = snapshot.positions.get("hub")!;
  const wikiMaxDistance = Math.max(
    ...wikiRefs.map((id) => {
      const point = snapshot.positions.get(id)!;
      return Math.hypot(point.x - hubPoint.x, point.y - hubPoint.y);
    })
  );
  const importMinDistance = Math.min(
    ...importRefs.map((id) => {
      const point = snapshot.positions.get(id)!;
      return Math.hypot(point.x - hubPoint.x, point.y - hubPoint.y);
    })
  );
  assert.ok(
    importMinDistance > wikiMaxDistance,
    `secondary relation satellite should sit outside the dominant core: wiki ${wikiMaxDistance}, import ${importMinDistance}`
  );
});

test("organic layout separates sibling hub micro-cells inside one global sphere", () => {
  const makeCell = (prefix: string) => [
    {
      id: `${prefix}-hub`,
      rel: `src/${prefix}/hub.ts`,
      degree: 10,
      links: Array.from({ length: 10 }, (_, index) => `${prefix}-leaf-${index}`),
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `${prefix}-leaf-${index}`,
      rel: `src/${prefix}/leaf-${index}.ts`,
      degree: 1,
      links: [`${prefix}-hub`],
    })),
  ];
  const nodes = [...makeCell("alpha"), ...makeCell("beta")];
  const layout = createGraphLayout(nodes, "organic");
  const alpha = layout.get("alpha-hub")!;
  const beta = layout.get("beta-hub")!;
  assert.ok(Math.hypot(alpha.x - beta.x, alpha.y - beta.y) > 210, "hub cells need breathing room");
  assert.ok(
    Array.from(layout.values()).every((point) => Math.hypot(point.x, point.y) < 520),
    "micro-cells should still live inside one broad graph sphere"
  );
});

test("colony layout returns finite positions for the 4,000-node safety cap", () => {
  const nodes = Array.from({ length: 4000 }, (_, index) => ({
    id: `node-${index}`,
    rel: `folder-${index % 24}/node-${index}.ts`,
    degree: index % 9,
  }));
  const layout = createGraphLayout(nodes, "colony");
  assert.equal(layout.size, nodes.length);
  assert.ok(Array.from(layout.values()).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});
