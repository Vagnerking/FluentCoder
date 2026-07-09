import { test } from "node:test";
import assert from "node:assert/strict";
import { MVC_TAG_HELPER_DATA } from "./tagHelperData.ts";

test("tag helper data has the core asp-* global attributes", () => {
  const names = MVC_TAG_HELPER_DATA.globalAttributes.map((a) => a.name);
  for (const need of ["asp-for", "asp-action", "asp-controller", "asp-page", "asp-route-", "asp-validation-for", "asp-append-version"]) {
    assert.ok(names.includes(need), `missing global attribute ${need}`);
  }
});

test("tag helper data declares <partial>, <environment>, <cache> tags", () => {
  const tags = MVC_TAG_HELPER_DATA.tags.map((t) => t.name);
  assert.deepEqual(tags.sort(), ["cache", "environment", "partial"]);
  const partial = MVC_TAG_HELPER_DATA.tags.find((t) => t.name === "partial")!;
  assert.ok(partial.attributes.some((a) => a.name === "name"));
  assert.ok(partial.attributes.some((a) => a.name === "model"));
});

test("all entries carry a description (surfaced on hover/completion)", () => {
  for (const a of MVC_TAG_HELPER_DATA.globalAttributes) assert.ok(a.description, a.name);
  for (const t of MVC_TAG_HELPER_DATA.tags) {
    assert.ok(t.description, t.name);
    for (const a of t.attributes) assert.ok(a.description, `${t.name}.${a.name}`);
  }
});
