import { test } from "node:test";
import assert from "node:assert/strict";
import { scanRazorMarkup } from "./razorHtmlLint.ts";

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
