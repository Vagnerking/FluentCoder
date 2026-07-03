import { test } from "node:test";
import assert from "node:assert/strict";
import { scanRazorMarkup, scanIncompleteRazorExpressions } from "./razorHtmlLint.ts";

test("incomplete: @Model. (trailing dot) is flagged on the dot", () => {
  const src = "<p>@Model.</p>";
  const r = scanIncompleteRazorExpressions(src);
  assert.equal(r.length, 1);
  assert.match(r[0].message, /incompleta/i);
  assert.equal(src.slice(r[0].start, r[0].end), "."); // range = the trailing dot
});

test("incomplete: @Model.City (complete member) is clean", () => {
  assert.equal(scanIncompleteRazorExpressions("<p>@Model.City</p>").length, 0);
});

test("incomplete: nested @Model.A. (trailing dot after a member) is flagged", () => {
  assert.equal(scanIncompleteRazorExpressions("@Model.A. ").length, 1);
});

test("incomplete: multiple exprs, none trailing-dot, is clean", () => {
  assert.equal(scanIncompleteRazorExpressions("<h1>@greeting, @Model.City</h1>").length, 0);
});

test("incomplete: @{ code. } block is NOT flagged (Roslyn owns C# blocks)", () => {
  assert.equal(scanIncompleteRazorExpressions("@{ var x = a. }").length, 0);
});

test("incomplete: @(expr.) parenthesized is NOT flagged here", () => {
  assert.equal(scanIncompleteRazorExpressions("@(Model.)").length, 0);
});

test("incomplete: @@ escape and @* *@ comment are ignored", () => {
  assert.equal(scanIncompleteRazorExpressions("a@@b @* x. *@").length, 0);
});

test("incomplete: trailing dot at end-of-buffer is flagged", () => {
  assert.equal(scanIncompleteRazorExpressions("<p>@Model.").length, 1);
});

test("incomplete: email literal (Razor's @-exception) is NOT flagged", () => {
  // `@` preceded by a text char is literal, not a transition.
  assert.equal(scanIncompleteRazorExpressions("<p>Contato: suporte@example.com.</p>").length, 0);
  assert.equal(scanIncompleteRazorExpressions("foo@bar.").length, 0);
});

test("incomplete: @Model. at start of a line/after whitespace IS flagged", () => {
  // A real transition (preceded by whitespace) still flags.
  assert.equal(scanIncompleteRazorExpressions("texto @Model.").length, 1);
});

test("incomplete: @: makes the rest of the line literal — trailing dot NOT flagged", () => {
  // `@:` is a line-markup transition: everything after it (including `@Model.`)
  // is literal markup, so the dangling dot must not be reported.
  assert.equal(scanIncompleteRazorExpressions("@: @Model.").length, 0);
  assert.equal(scanIncompleteRazorExpressions("<p>@: texto @Model. fim</p>").length, 0);
});

test("incomplete: @: only consumes its own line — next line still scanned", () => {
  // The literal-markup escape ends at the newline; a `@Model.` on the FOLLOWING
  // line is a real implicit expression again.
  assert.equal(scanIncompleteRazorExpressions("@: literal @Model.\n@Model.").length, 1);
});

test("flags a stray closing tag (typo'd </dabbr>)", () => {
  const r = scanRazorMarkup('<abbr title="Phone">P:</dabbr>');
  assert.equal(r.length, 1);
  assert.match(r[0].message, /<\/dabbr>/);
});

test("a well-formed tag pair is clean", () => {
  assert.equal(scanRazorMarkup("<abbr>P:</abbr>").length, 0);
});

test("void and self-closing tags don't need a close", () => {
  assert.equal(scanRazorMarkup("<br /><img src=x><hr>text").length, 0);
});

test("Razor regions are skipped (no false positives from @ blocks)", () => {
  const src = '@{ var x = "</fake>"; }\n@Model.Foo\n<p>@ViewData["T"]</p>';
  assert.equal(scanRazorMarkup(src).length, 0);
});

test("lenient about optional-close elements (no error for unbalanced <li>)", () => {
  // The outer <ul> closes; intermediate <li> without explicit close is tolerated.
  assert.equal(scanRazorMarkup("<ul><li>a<li>b</ul>").length, 0);
});

test("reports the offset range of the stray tag", () => {
  const src = "<div>x</span></div>";
  const r = scanRazorMarkup(src);
  assert.equal(r.length, 1);
  assert.equal(src.slice(r[0].start, r[0].end), "</span>");
});

// --- unified scanner (delegates Razor regions to buildVirtualHtml) ---

test("generics in an @if body are not phantom tags (List<string> bug)", () => {
  // The old local scanner didn't understand keyword blocks: `<string>` read as an
  // open tag and the later real close tags all became "stray".
  const src = "@if (ok) {\n  List<string> xs = new();\n  <p>x</p>\n}\n<div></div>";
  assert.equal(scanRazorMarkup(src).length, 0);
});

test("a stray close INSIDE an @if markup body is still flagged", () => {
  const src = "@if (ok) { <p>x</p></span> }";
  const r = scanRazorMarkup(src);
  assert.equal(r.length, 1);
  assert.equal(src.slice(r[0].start, r[0].end), "</span>");
});

test("a `}` inside a C# string in @{ } does not desync the tag scan", () => {
  // Quote-awareness comes from the projection now; the old naive depth counter
  // ended the block at the `}` inside the string and mis-parsed what followed.
  const src = '@{ var s = "}"; }\n<div><p>a</p></div>';
  assert.equal(scanRazorMarkup(src).length, 0);
});

test("@model directive arguments never produce markup findings", () => {
  const src = "@model List<MyApp.Models.Item>\n<p>x</p>";
  assert.equal(scanRazorMarkup(src).length, 0);
});

test("an email @ in text does not swallow following markup", () => {
  const src = "<p>contato@empresa.com</p><div></div>";
  assert.equal(scanRazorMarkup(src).length, 0);
});
