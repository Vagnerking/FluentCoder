import assert from "node:assert/strict";
import test from "node:test";
import { commitFileOpen, findExistingFile, resolveFileOpen } from "./existingFile.ts";
import { createLayout, patchFileEverywhere, serializeLayout } from "../editorGroups.ts";
import type { OpenFile } from "../types.ts";

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

test("concurrent alias reads commit one dirty buffer and focus its stored path in either order", async () => {
  const paths = ["/Volumes/Project/Main.cs", "/Volumes/project/main.cs"];
  // Both requests begin against an empty snapshot, before either read commits.
  const resolved = await Promise.all(paths.map((path) => resolveFileOpen([], path, async () => ({ identity: "unix:1:42", index: null }))));
  for (const order of [[0, 1], [1, 0]]) {
    let layout = createLayout({ id: "g0", files: [], activePath: null });
    const make = (index: number): OpenFile => ({ path: paths[index], localIdentity: resolved[index].identity, name: "Main.cs", content: "from disk", dirty: false, preview: true, pinned: true });
    layout = commitFileOpen(layout, make(order[0]), { observedPaths: resolved[order[0]].observedPaths });
    layout = patchFileEverywhere(layout, paths[order[0]], { content: "unsaved edit", dirty: true });
    layout = commitFileOpen(layout, make(order[1]), { permanent: true, observedPaths: resolved[order[1]].observedPaths });
    const group = layout.groups.g0;
    assert.equal(group.files.length, 1);
    assert.equal(group.files[0].path, paths[order[0]]);
    assert.equal(group.activePath, group.files[0].path);
    assert.equal(group.files[0].content, "unsaved edit");
    assert.equal(group.files[0].dirty, true);
    assert.equal(group.files[0].pinned, true);
    assert.equal(group.files[0].preview, undefined);
    assert.equal(JSON.stringify(serializeLayout(layout)).includes("unix:1:42"), false, "identity must not survive a session restart");
  }
});

test("distinct physical identities remain separate even when lexical case folding would match", () => {
  let layout = createLayout({ id: "g0", files: [], activePath: null });
  const make = (path: string, localIdentity: string): OpenFile => ({ path, localIdentity, name: "Main.cs", content: "", dirty: false });
  layout = commitFileOpen(layout, make("C:/work/Main.cs", "file:1"));
  layout = commitFileOpen(layout, make("C:/work/main.cs", "file:2"));
  assert.equal(layout.groups.g0.files.length, 2);
  assert.equal(layout.groups.g0.activePath, "C:/work/main.cs");
});

test("a fresh negative filesystem match defeats a cached identity reused after deletion", async () => {
  const old: OpenFile = { path: "/work/deleted.cs", localIdentity: "unix:1:42", name: "deleted.cs", content: "unsaved", dirty: true };
  const layout = createLayout({ id: "g0", files: [old], activePath: old.path });
  const target = await resolveFileOpen([old], "/work/new.cs", async () => ({ identity: "unix:1:42", index: null }));
  const next = commitFileOpen(layout, { path: "/work/new.cs", name: "new.cs", content: "new", dirty: false, localIdentity: target.identity }, { observedPaths: target.observedPaths });
  assert.equal(next.groups.g0.files.length, 2);
  assert.equal(next.groups.g0.files[0], old);
  assert.equal(next.groups.g0.activePath, "/work/new.cs");
});

test("a late explicit view choice preserves the current dirty buffer and other groups", () => {
  const file: OpenFile = { path: "/work/Main.cs", name: "Main.cs", localIdentity: "unix:1:42", content: "dirty", dirty: true, mode: "text" };
  const base = createLayout({ id: "g0", files: [file], activePath: file.path });
  const other = { id: "g1", files: [], activePath: null };
  const next = commitFileOpen({ ...base, groups: { ...base.groups, g1: other } }, {
    ...file, path: "/work/main.cs", content: "stale disk", dirty: false,
  }, { mode: "image", observedPaths: [] });
  assert.equal(next.groups.g0.files[0].mode, "image");
  assert.equal(next.groups.g0.files[0].content, "dirty");
  assert.equal(next.groups.g0.files[0].dirty, true);
  assert.equal(next.groups.g1, other);
});

test("remote files never use a local identity to merge different paths", () => {
  const remote = { folderId: "r", connId: "ssh-1", host: "host", user: "user", rootPath: "/srv" };
  const file: OpenFile = { path: "/srv/one.cs", name: "one.cs", localIdentity: "stale-local-id", content: "", dirty: false, workspaceRemote: remote };
  const base = createLayout({ id: "g0", files: [file], activePath: file.path });
  const next = commitFileOpen(base, { ...file, path: "/srv/two.cs", name: "two.cs" }, { observedPaths: [] });
  assert.equal(next.groups.g0.files.length, 2);
});
