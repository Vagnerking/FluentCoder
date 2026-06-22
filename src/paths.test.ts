import assert from "node:assert/strict";
import test from "node:test";
import { pathForWorkspaceDisplay, samePath } from "./paths.ts";

test("shows a Windows project file relative to the workspace despite drive casing", () => {
  assert.equal(
    pathForWorkspaceDisplay(
      "c:\\Projects\\CodeEditor\\src\\App.tsx",
      "C:\\Projects\\CodeEditor"
    ),
    "src/App.tsx"
  );
});

test("shows an external Windows file with its full path", () => {
  assert.equal(
    pathForWorkspaceDisplay(
      "C:\\Projects\\Shared\\types.ts",
      "C:\\Projects\\CodeEditor"
    ),
    "C:\\Projects\\Shared\\types.ts"
  );
});

test("does not treat a sibling with the same prefix as part of the workspace", () => {
  assert.equal(
    pathForWorkspaceDisplay(
      "C:\\Projects\\CodeEditor-old\\src\\App.tsx",
      "C:\\Projects\\CodeEditor"
    ),
    "C:\\Projects\\CodeEditor-old\\src\\App.tsx"
  );
});

test("keeps POSIX path comparison case-sensitive", () => {
  assert.equal(
    pathForWorkspaceDisplay(
      "/home/user/codeeditor/src/App.tsx",
      "/home/user/CodeEditor"
    ),
    "/home/user/codeeditor/src/App.tsx"
  );
});

test("samePath treats Windows paths that differ only in drive casing as equal", () => {
  assert.equal(
    samePath(
      "C:\\Users\\Vagner\\Titulo.cs",
      "c:\\Users\\Vagner\\Titulo.cs"
    ),
    true
  );
});

test("samePath ignores separator differences on Windows", () => {
  assert.equal(
    samePath("C:\\Users\\Vagner\\Titulo.cs", "C:/Users/Vagner/Titulo.cs"),
    true
  );
});

test("samePath keeps different Windows files distinct", () => {
  assert.equal(
    samePath("C:\\Users\\Vagner\\Titulo.cs", "C:\\Users\\Vagner\\Outro.cs"),
    false
  );
});

test("samePath stays case-sensitive for POSIX paths", () => {
  assert.equal(
    samePath("/home/user/Titulo.cs", "/home/user/titulo.cs"),
    false
  );
});
