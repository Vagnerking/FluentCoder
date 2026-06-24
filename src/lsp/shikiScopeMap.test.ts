import assert from "node:assert/strict";
import test from "node:test";
import { mapScopes, isMemberProperty } from "./shikiScopeMap.ts";

// A scope stack ends with the deepest (most specific) scope, which wins.
const stack = (...s: string[]) => s;

test("mapScopes: C# expression keywords (nameof/typeof/is/as) map to keyword, not operator", () => {
  // The bug: `keyword.operator.expression.nameof.cs` fell into `keyword.operator`
  // → `operator`; VS Code colors these as keywords (purple).
  assert.equal(mapScopes(stack("source.cs", "keyword.operator.expression.nameof.cs")), "keyword");
  assert.equal(mapScopes(stack("source.cs", "keyword.operator.expression.typeof.cs")), "keyword");
  assert.equal(mapScopes(stack("source.cs", "keyword.operator.expression.pattern.is.cs")), "keyword");
  assert.equal(mapScopes(stack("source.cs", "keyword.operator.expression.as.cs")), "keyword");
});

test("mapScopes: real operators still map to operator", () => {
  assert.equal(mapScopes(stack("source.cs", "keyword.operator.arithmetic.cs")), "operator");
  assert.equal(mapScopes(stack("source.cs", "keyword.operator.assignment.cs")), "operator");
});

test("mapScopes: control keywords map to controlKeyword", () => {
  assert.equal(mapScopes(stack("source.cs", "keyword.control.flow.cs")), "controlKeyword");
  assert.equal(mapScopes(stack("keyword.control.cshtml")), "controlKeyword");
});

test("mapScopes: common scopes map to their Monaco types", () => {
  assert.equal(mapScopes(stack("string.quoted.double.cs")), "string");
  assert.equal(mapScopes(stack("comment.line.double-slash.cs")), "comment");
  assert.equal(mapScopes(stack("constant.numeric.decimal.cs")), "number");
  assert.equal(mapScopes(stack("entity.name.type.class.cs")), "type");
  assert.equal(mapScopes(stack("entity.name.function.cs")), "function");
  assert.equal(mapScopes(stack("entity.name.tag.html")), "tag");
});

test("mapScopes: deepest scope wins over an outer scope", () => {
  // outer source.cs would be unmatched; the deep keyword scope decides.
  assert.equal(mapScopes(stack("text.aspnetcorerazor", "source.cs", "keyword.control.cs")), "controlKeyword");
});

test("mapScopes: unknown scope yields empty (default foreground)", () => {
  assert.equal(mapScopes(stack("meta.expression.implicit.cshtml", "source.cs")), "");
  assert.equal(mapScopes([]), "");
});

test("isMemberProperty: matches a .-chain member, not a leading object", () => {
  assert.equal(isMemberProperty(stack("source.cs", "variable.other.object.property.cs")), true);
  assert.equal(isMemberProperty(stack("source.cs", "variable.other.object.cs")), false);
  assert.equal(isMemberProperty(stack("source.cs", "variable.other.readwrite.cs")), false);
});
