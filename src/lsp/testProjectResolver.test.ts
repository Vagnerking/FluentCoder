import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeTestProject,
  pickTestCsproj,
} from "./testProjectResolver.ts";

test("looksLikeTestProject: matches common test-project names", () => {
  assert.ok(looksLikeTestProject("C:/repo/App.Tests/App.Tests.csproj"));
  assert.ok(looksLikeTestProject("C:/repo/App.Test/App.Test.csproj"));
  assert.ok(looksLikeTestProject("/repo/tests/Unit/Unit.csproj"));
  assert.ok(looksLikeTestProject("/repo/test/Foo.csproj"));
  // Windows backslashes normalize.
  assert.ok(looksLikeTestProject("C:\\repo\\App.Tests\\App.Tests.csproj"));
});

test("looksLikeTestProject: rejects ordinary projects", () => {
  assert.ok(!looksLikeTestProject("C:/repo/App/App.csproj"));
  assert.ok(!looksLikeTestProject("/repo/src/Api/Api.csproj"));
  // "Latest.csproj" ends in "test"? No — it ends in "test" only as a substring
  // of a longer word; the regex requires the word boundary of `tests?.csproj`.
  assert.ok(!looksLikeTestProject("/repo/Greatest/Greatest.csproj"));
});

test("pickTestCsproj: prefers a test project over the first", () => {
  assert.equal(
    pickTestCsproj([
      "/repo/App/App.csproj",
      "/repo/App.Tests/App.Tests.csproj",
    ]),
    "/repo/App.Tests/App.Tests.csproj"
  );
});

test("pickTestCsproj: falls back to the first project when none look like tests", () => {
  assert.equal(
    pickTestCsproj(["/repo/App/App.csproj", "/repo/Lib/Lib.csproj"]),
    "/repo/App/App.csproj"
  );
});

test("pickTestCsproj: null when there are no projects", () => {
  assert.equal(pickTestCsproj([]), null);
});
