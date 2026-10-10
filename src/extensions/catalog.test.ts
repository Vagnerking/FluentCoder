import assert from "node:assert/strict";
import test from "node:test";
import { RECOMMENDED, UPDATE_INTERVAL_MS, formatCount, isRecommended, pruneUpdates, shouldCheckUpdates, sourceBadge, type CatalogSource } from "./catalog.ts";

test("catálogo: throttle de 12 h na checagem de atualizações", () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldCheckUpdates(null, now), true);
  assert.equal(shouldCheckUpdates(now - 60_000, now), false);
  assert.equal(shouldCheckUpdates(now - UPDATE_INTERVAL_MS, now), true);
  assert.equal(shouldCheckUpdates(now + 60_000, now), true, "relógio voltou");
  assert.equal(shouldCheckUpdates(Number.NaN, now), true);
});

test("catálogo: recomendadas e origem exibida", () => {
  assert.deepEqual(RECOMMENDED.map((r) => r.id), ["anthropic.claude-code", "openai.chatgpt"]);
  assert.ok(isRecommended("Anthropic.Claude-Code"));
  assert.ok(!isRecommended("acme.x"));
  const sources: CatalogSource[] = [{ id: "open-vsx", label: "Open VSX", url: "https://open-vsx.org/api", contentHosts: [], enabled: true, builtin: true }];
  assert.equal(sourceBadge({ location: "vscode", source: null }, sources), "VS Code");
  assert.equal(sourceBadge({ location: "app", source: { kind: "registry", registry: "open-vsx", namespace: "a", name: "b" } }, sources), "Open VSX");
  assert.equal(sourceBadge({ location: "app", source: { kind: "vscode-import", from: "/x" } }, sources), "App");
});

test("catálogo: atualizações já instaladas somem da lista", () => {
  const ups = [
    { id: "a.b", current: "1.0.0", latest: "1.1.0", sourceId: "open-vsx", namespace: "a", name: "b", preRelease: false },
    { id: "c.d", current: "2.0.0", latest: "3.0.0", sourceId: "open-vsx", namespace: "c", name: "d", preRelease: false },
  ];
  assert.deepEqual(pruneUpdates(ups, [{ id: "a.b", version: "1.1.0" }, { id: "c.d", version: "2.0.0" }]).map((u) => u.id), ["c.d"]);
  assert.equal(formatCount(9_434_801), "9,4 mi");
  assert.equal(formatCount(42_558), "42,6 mil");
});
