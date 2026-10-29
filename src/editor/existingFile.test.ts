import assert from "node:assert/strict";
import test from "node:test";
import { findExistingFile } from "./existingFile.ts";

test("an alias reuses the stored path and dirty buffer, not freshly read disk content", async () => {
  const dirty = { path: "/Volumes/Project/Main.cs", content: "unsaved edit", dirty: true };
  const found = await findExistingFile([dirty], "/Volumes/project/main.cs", async (path, candidates) => {
    assert.equal(path, "/Volumes/project/main.cs");
    assert.deepEqual(candidates, [dirty.path]);
    return 0;
  });
  assert.equal(found, dirty);
  assert.equal(found.content, "unsaved edit");
});

test("case-sensitive volume files remain separate when filesystem identity differs", async () => {
  assert.equal(await findExistingFile([{ path: "/work/Main.cs" }], "/work/main.cs", async () => null), undefined);
});

test("filesystem evidence overrides a lexical case-folding convention", async () => {
  assert.equal(await findExistingFile([{ path: "C:/work/Main.cs" }], "C:/work/main.cs", async () => null), undefined);
});

test("remote paths are compared without a local filesystem resolver", async () => {
  const file = { path: "/srv/Main.cs" };
  assert.equal(await findExistingFile([file], "/srv/Main.cs"), file);
  assert.equal(await findExistingFile([file], "/srv/main.cs"), undefined);
});

test("unavailable metadata and invalid resolver indices never merge unrelated buffers", async () => {
  const files = [{ path: "/work/Main.cs" }];
  assert.equal(await findExistingFile(files, "/work/other.cs", async () => { throw new Error("missing"); }), undefined);
  for (const index of [-1, 0.5, 99]) {
    assert.equal(await findExistingFile(files, "/work/other.cs", async () => index), undefined);
  }
});
