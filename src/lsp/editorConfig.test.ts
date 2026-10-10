import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findNearestEditorConfig,
  hasEditorConfig,
  type FileEntry,
} from "./editorConfig.ts";

const files: FileEntry[] = [
  { name: ".editorconfig", path: "/repo/.editorconfig" },
  { name: ".editorconfig", path: "/repo/src/Api/.editorconfig" },
  { name: "Program.cs", path: "/repo/src/Api/Program.cs" },
  { name: "Other.cs", path: "/repo/src/Web/Other.cs" },
];

test("hasEditorConfig: true/false", () => {
  assert.equal(hasEditorConfig(files), true);
  assert.equal(hasEditorConfig([{ name: "a.cs", path: "/x/a.cs" }]), false);
});

test("findNearestEditorConfig: nearest ancestor wins", () => {
  // Program.cs is under src/Api → the src/Api config beats the root one.
  assert.equal(
    findNearestEditorConfig(files, "/repo/src/Api/Program.cs"),
    "/repo/src/Api/.editorconfig"
  );
});

test("findNearestEditorConfig: falls back to a higher config when no nested one applies", () => {
  // Other.cs is under src/Web → only the root config is an ancestor.
  assert.equal(
    findNearestEditorConfig(files, "/repo/src/Web/Other.cs"),
    "/repo/.editorconfig"
  );
});

test("findNearestEditorConfig: no active file → shallowest (root) config", () => {
  assert.equal(findNearestEditorConfig(files, null), "/repo/.editorconfig");
});

test("findNearestEditorConfig: null when project has none", () => {
  assert.equal(
    findNearestEditorConfig([{ name: "a.cs", path: "/x/a.cs" }], "/x/a.cs"),
    null
  );
});

test("findNearestEditorConfig: handles windows backslash paths", () => {
  const win: FileEntry[] = [
    { name: ".editorconfig", path: "C:\\repo\\.editorconfig" },
    { name: ".editorconfig", path: "C:\\repo\\src\\.editorconfig" },
  ];
  assert.equal(
    findNearestEditorConfig(win, "C:\\repo\\src\\App\\Foo.cs"),
    "C:\\repo\\src\\.editorconfig"
  );
});
