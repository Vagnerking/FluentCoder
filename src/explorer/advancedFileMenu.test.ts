import assert from "node:assert/strict";
import test from "node:test";
import { buildAdvancedFileMenuItems } from "./advancedFileMenu.ts";

const baseCtx = {
  path: "C:/repo/src/a.ts",
  x: 10,
  y: 20,
  isGitRepo: true,
  compareSelection: null,
};

function byId(items: ReturnType<typeof buildAdvancedFileMenuItems>, id: string) {
  const it = items.find((i) => i.id === id);
  assert.ok(it, `expected item ${id}`);
  return it!;
}

test("Open to the Side is present but disabled (no split editor yet)", () => {
  const items = buildAdvancedFileMenuItems(baseCtx, {});
  const item = byId(items, "explorer.openToSide");
  assert.equal(item.enabled, false);
  assert.equal(item.accelerator, "Ctrl+Enter");
  assert.equal(item.run, undefined);
});

test("Open With is enabled and fires the handler with path + coords", () => {
  let got: [string, number, number] | null = null;
  const items = buildAdvancedFileMenuItems(baseCtx, {
    onOpenWith: (p, x, y) => (got = [p, x, y]),
  });
  const item = byId(items, "explorer.openWith");
  assert.equal(item.enabled, true);
  item.run?.();
  assert.deepEqual(got, ["C:/repo/src/a.ts", 10, 20]);
});

test("git diff/compare/timeline items are disabled with a tooltip", () => {
  const items = buildAdvancedFileMenuItems(baseCtx, {});
  for (const id of [
    "explorer.git.openChanges",
    "explorer.git.selectForCompare",
    "explorer.git.compareWithSelected",
    "explorer.git.openTimeline",
  ]) {
    const item = byId(items, id);
    assert.equal(item.enabled, false, `${id} should be disabled`);
    assert.ok(item.title && item.title.length > 0, `${id} needs a tooltip`);
    assert.equal(item.run, undefined, `${id} must not fire`);
  }
});

test("File History is enabled only inside a git repo", () => {
  let opened: string | null = null;
  const handlers = { onFileHistory: (p: string) => (opened = p) };

  const enabled = byId(
    buildAdvancedFileMenuItems(baseCtx, handlers),
    "explorer.git.fileHistory"
  );
  assert.equal(enabled.enabled, true);
  enabled.run?.();
  assert.equal(opened, "C:/repo/src/a.ts");

  const disabled = byId(
    buildAdvancedFileMenuItems({ ...baseCtx, isGitRepo: false }, handlers),
    "explorer.git.fileHistory"
  );
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.run, undefined);
});

test("Compare with Selected reflects the memorized selection in its label", () => {
  const items = buildAdvancedFileMenuItems(
    { ...baseCtx, compareSelection: { path: "C:/repo/src/b.ts" } },
    {}
  );
  const item = byId(items, "explorer.git.compareWithSelected");
  assert.match(item.label, /b\.ts/);
});
