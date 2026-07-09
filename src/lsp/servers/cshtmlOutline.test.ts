import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCshtmlOutline } from "./cshtmlOutline.ts";

test("parses line directives (@model, @page, @using, @inject)", () => {
  const src = `@page
@model App.Models.WeatherModel
@using App.Helpers
@inject IService svc
<h1>Oi</h1>`;
  const { symbols } = parseCshtmlOutline(src);
  const byKind = Object.fromEntries(symbols.map((s) => [s.kind, s.name]));
  assert.equal(byKind.page, "@page");
  assert.equal(byKind.model, "@model App.Models.WeatherModel");
  assert.equal(byKind.using, "@using App.Helpers");
  assert.equal(byKind.inject, "@inject IService svc");
});

test("parses @section with name and a foldable body", () => {
  const src = `<div></div>
@section Scripts {
  <script>x</script>
}
`;
  const { symbols, folds } = parseCshtmlOutline(src);
  const section = symbols.find((s) => s.kind === "section");
  assert.equal(section?.name, "@section Scripts");
  assert.equal(section?.line, 1);
  assert.equal(section?.endLine, 3);
  assert.ok(folds.some((f) => f.startLine === 1 && f.endLine === 3 && f.kind === "region"));
});

test("parses @functions and @code blocks", () => {
  const src = `@functions {
  int X() => 1;
}
@code {
  int Y;
}`;
  const { symbols } = parseCshtmlOutline(src);
  assert.ok(symbols.some((s) => s.kind === "functions" && s.name === "@functions"));
  assert.ok(symbols.some((s) => s.kind === "code" && s.name === "@code"));
});

test("parses @{ } code block with brace matching (nested braces ok)", () => {
  const src = `@{
  var x = new { A = 1 };
  if (x.A == 1) { }
}`;
  const { symbols, folds } = parseCshtmlOutline(src);
  const block = symbols.find((s) => s.kind === "codeBlock");
  assert.equal(block?.line, 0);
  assert.equal(block?.endLine, 3); // closes at the final }
  assert.ok(folds.some((f) => f.startLine === 0 && f.endLine === 3));
});

test("brace matching ignores braces in strings and comments", () => {
  const src = `@{
  var s = "a { b }";
  // } not a close
  var t = 1;
}`;
  const { symbols } = parseCshtmlOutline(src);
  const block = symbols.find((s) => s.kind === "codeBlock");
  assert.equal(block?.endLine, 4); // the real closing }, not the one in the string/comment
});

test("@* comment *@ multi-line yields a comment fold", () => {
  const src = `@*
  comentário
  de várias linhas
*@`;
  const { folds } = parseCshtmlOutline(src);
  assert.ok(folds.some((f) => f.kind === "comment" && f.startLine === 0 && f.endLine === 3));
});

test("single-line constructs produce no folds", () => {
  const { folds } = parseCshtmlOutline(`@{ var x = 1; }\n<p>@x</p>`);
  assert.deepEqual(folds, []);
});

test("keyword needs a word boundary — @modelData is not @model", () => {
  const { symbols } = parseCshtmlOutline(`<p>@modelData.Foo</p>\n@codeStuff { }`);
  assert.equal(symbols.length, 0);
});

test("@@ escape (literal @) is not a directive", () => {
  const { symbols } = parseCshtmlOutline(`<p>email@@model.com</p>`);
  assert.equal(symbols.length, 0);
});

test("real directive still parses next to escaped @@ and identifiers", () => {
  const src = `<p>a@@b</p>\n@model Foo.Bar\n<span>@modeling</span>`;
  const { symbols } = parseCshtmlOutline(src);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].kind, "model");
  assert.equal(symbols[0].name, "@model Foo.Bar");
});
