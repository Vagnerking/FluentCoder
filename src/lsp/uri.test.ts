import assert from "node:assert/strict";
import test from "node:test";
import { toFileUri } from "./uri.ts";

test("converts a normal Windows path to a file URI", () => {
  assert.equal(
    toFileUri("C:\\workspace\\README.md"),
    "file:///C:/workspace/README.md"
  );
});

test("removes the Windows extended-length prefix before creating a file URI", () => {
  assert.equal(
    toFileUri("\\\\?\\C:\\workspace\\README 2.md"),
    "file:///C:/workspace/README%202.md"
  );
});

test("converts an extended UNC path without treating the server as a URI marker", () => {
  assert.equal(
    toFileUri("\\\\?\\UNC\\server\\share\\README.md"),
    "file://server/share/README.md"
  );
});
