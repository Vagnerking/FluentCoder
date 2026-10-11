import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_QUICK_OPEN_MAX_FILES, getQuickOpenExcludeGlobs, getQuickOpenMaxFiles, getSearchExcludeMap } from "./quickOpenSettings.ts";

function withStorage(values: Record<string, string>, fn: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = { getItem: (k: string) => values[k] ?? null, setItem() {}, removeItem() {} };
  try {
    fn();
  } finally {
    g.localStorage = prev;
  }
}

test("Quick Open: files.exclude + search.exclude por padrão (sem duplicar)", () => {
  withStorage({}, () => {
    const globs = getQuickOpenExcludeGlobs();
    for (const g of ["**/.git", "**/bin", "**/obj", "**/node_modules", "**/*.code-search"]) assert.ok(globs.includes(g), g);
    assert.equal(new Set(globs).size, globs.length);
    assert.equal(getQuickOpenMaxFiles(), DEFAULT_QUICK_OPEN_MAX_FILES);
  });
});

test("search.exclude do usuário desliga default e adiciona padrões; teto configurável", () => {
  withStorage(
    { "search.exclude": JSON.stringify({ "**/node_modules": false, "**/vendor": true, ruim: "sim" }), "fluent.quickOpen.maxFiles": "200000" },
    () => {
      const map = getSearchExcludeMap();
      assert.equal(map["**/node_modules"], false);
      assert.equal(map["**/vendor"], true);
      assert.equal("ruim" in map, false);
      assert.ok(!getQuickOpenExcludeGlobs().includes("**/node_modules"));
      assert.equal(getQuickOpenMaxFiles(), 200000);
    },
  );
  withStorage({ "fluent.quickOpen.maxFiles": "abc" }, () => assert.equal(getQuickOpenMaxFiles(), DEFAULT_QUICK_OPEN_MAX_FILES));
});
