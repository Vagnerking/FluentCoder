import assert from "node:assert/strict";
import test from "node:test";
import type { OpenFile } from "../../types.ts";
import {
  openTabInList,
  setTabPinned,
  tabDescriptions,
  tabRovingIndex,
  tabsKeptAfterClose,
} from "./tabLogic.ts";

const f = (path: string, extra: Partial<OpenFile> = {}): OpenFile => ({
  path,
  name: path.split(/[\\/]/).pop()!,
  content: "",
  dirty: false,
  ...extra,
});

test("foco itinerante: setas com volta, Home/End, outras teclas ignoradas", () => {
  assert.equal(tabRovingIndex(0, "ArrowRight", 3), 1);
  assert.equal(tabRovingIndex(2, "ArrowRight", 3), 0);
  assert.equal(tabRovingIndex(0, "ArrowLeft", 3), 2);
  assert.equal(tabRovingIndex(1, "Home", 3), 0);
  assert.equal(tabRovingIndex(0, "End", 3), 2);
  assert.equal(tabRovingIndex(0, "Enter", 3), null);
  assert.equal(tabRovingIndex(0, "ArrowRight", 0), null);
  // índice fora da faixa (aba removida) é corrigido antes de mover
  assert.equal(tabRovingIndex(9, "ArrowLeft", 3), 1);
});

test("homônimos ganham o menor sufixo de pasta que os distingue", () => {
  const d = tabDescriptions([
    f("/repo/src/git/index.ts"),
    f("/repo/src/styles/index.ts"),
    f("/repo/src/App.tsx"),
  ]);
  assert.equal(d.get("/repo/src/git/index.ts"), "…/git");
  assert.equal(d.get("/repo/src/styles/index.ts"), "…/styles");
  assert.equal(d.has("/repo/src/App.tsx"), false);
});

test("homônimos com a mesma pasta pai sobem mais um nível", () => {
  const d = tabDescriptions([f("/a/x/lib/util.ts"), f("/a/y/lib/util.ts")]);
  assert.equal(d.get("/a/x/lib/util.ts"), "…/x/lib");
  assert.equal(d.get("/a/y/lib/util.ts"), "…/y/lib");
});

test("Windows e comparação sem diferenciar caixa no nome", () => {
  const d = tabDescriptions([f("C:\\p\\a\\README.md"), f("C:\\p\\b\\readme.md")]);
  assert.equal(d.get("C:\\p\\a\\README.md"), "…/a");
  assert.equal(d.get("C:\\p\\b\\readme.md"), "…/b");
});

test("preview substitui a aba de preview limpa no mesmo lugar", () => {
  const files = [f("/a.ts"), f("/b.ts", { preview: true }), f("/c.ts")];
  const next = openTabInList(files, f("/d.ts", { preview: true }));
  assert.deepEqual(next.map((x) => x.path), ["/a.ts", "/d.ts", "/c.ts"]);
  // preview suja não é substituída
  const dirty = [f("/a.ts"), f("/b.ts", { preview: true, dirty: true })];
  assert.deepEqual(openTabInList(dirty, f("/d.ts", { preview: true })).map((x) => x.path), ["/a.ts", "/b.ts", "/d.ts"]);
  // abertura normal sempre acrescenta
  assert.deepEqual(openTabInList(files, f("/e.ts")).map((x) => x.path), ["/a.ts", "/b.ts", "/c.ts", "/e.ts"]);
});

test("fixar move para o bloco inicial e tira do preview; desafixar vai logo após o bloco", () => {
  const files = [f("/a.ts", { pinned: true }), f("/b.ts"), f("/c.ts", { preview: true })];
  const pinned = setTabPinned(files, "/c.ts", true);
  assert.deepEqual(pinned.map((x) => x.path), ["/a.ts", "/c.ts", "/b.ts"]);
  assert.equal(pinned[1].pinned, true);
  assert.equal(pinned[1].preview, undefined);
  const unpinned = setTabPinned(pinned, "/a.ts", false);
  assert.deepEqual(unpinned.map((x) => x.path), ["/c.ts", "/a.ts", "/b.ts"]);
  assert.equal(unpinned[1].pinned, undefined);
});

test("fechar em lote preserva abas fixadas", () => {
  const files = [f("/p.ts", { pinned: true }), f("/a.ts"), f("/b.ts"), f("/c.ts")];
  const paths = (x: OpenFile[]) => x.map((y) => y.path);
  assert.deepEqual(paths(tabsKeptAfterClose(files, "/b.ts", "others")), ["/p.ts", "/b.ts"]);
  assert.deepEqual(paths(tabsKeptAfterClose(files, "/b.ts", "left")), ["/p.ts", "/b.ts", "/c.ts"]);
  assert.deepEqual(paths(tabsKeptAfterClose(files, "/b.ts", "right")), ["/p.ts", "/a.ts", "/b.ts"]);
  assert.deepEqual(paths(tabsKeptAfterClose(files, null, "all")), ["/p.ts"]);
});
