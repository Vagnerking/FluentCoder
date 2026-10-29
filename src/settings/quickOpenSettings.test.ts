import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_QUICK_OPEN_MAX_FILES, getQuickOpenExcludeGlobs, getQuickOpenMaxFiles, getSearchExcludeMap } from "./quickOpenSettings.ts";
import { getFilesExcludeGlobs } from "./filesExclude.ts";
import { settings } from "./instance.ts";
import { toLayer } from "./model.ts";

function withUser(values: Record<string, unknown>, fn: () => void) {
  const prev = settings.model.user;
  settings.model.user = toLayer(values);
  try {
    fn();
  } finally {
    settings.model.user = prev;
  }
}

test("Quick Open: files.exclude + search.exclude por padrão (sem duplicar)", () => {
  withUser({}, () => {
    const globs = getQuickOpenExcludeGlobs();
    for (const g of ["**/.git", "**/bin", "**/obj", "**/node_modules", "**/*.code-search"]) assert.ok(globs.includes(g), g);
    assert.equal(new Set(globs).size, globs.length);
    assert.equal(getQuickOpenMaxFiles(), DEFAULT_QUICK_OPEN_MAX_FILES);
  });
});

test("search.exclude do usuário desliga default e adiciona padrões; teto configurável", () => {
  withUser({ "search.exclude": { "**/node_modules": false, "**/vendor": true, ruim: "sim" }, "fluent.quickOpen.maxFiles": 200000 }, () => {
    const map = getSearchExcludeMap();
    assert.equal(map["**/node_modules"], false);
    assert.equal(map["**/vendor"], true);
    assert.equal("ruim" in map, false);
    assert.ok(!getQuickOpenExcludeGlobs().includes("**/node_modules"));
    assert.equal(getQuickOpenMaxFiles(), 200000);
  });
  withUser({ "fluent.quickOpen.maxFiles": "abc" }, () => assert.equal(getQuickOpenMaxFiles(), DEFAULT_QUICK_OPEN_MAX_FILES));
});

test("files.exclude: o usuário desliga um default sem apagar os outros", () => {
  withUser({ "files.exclude": { "**/bin": false } }, () => {
    const globs = getFilesExcludeGlobs();
    assert.ok(!globs.includes("**/bin"));
    assert.ok(globs.includes("**/obj"));
  });
});
