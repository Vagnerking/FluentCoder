import assert from "node:assert/strict";
import test from "node:test";
import { buildVirtualHtml, regionAt } from "./cshtmlHtmlProjection.ts";

/** Offset of the first occurrence of `needle` in `text`. */
function at(text: string, needle: string): number {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `fixture missing: ${needle}`);
  return i;
}

/** The blanked HTML text only (most buildVirtualHtml assertions are on this). */
function vh(src: string): string {
  return buildVirtualHtml(src).html;
}

test("buildVirtualHtml: preserves length exactly (only blanks, never inserts/deletes)", () => {
  const src = `@model Foo\n<div class="@x">@Name</div>\n@{ var a = 1; }`;
  const out = vh(src);
  assert.equal(out.length, src.length);
});

test("buildVirtualHtml: preserves newlines (CRLF and LF) so line/col stay identical", () => {
  const src = "@model Foo\r\n<div>\r\n@Name\r\n</div>";
  const out = vh(src);
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n" || src[i] === "\r") assert.equal(out[i], src[i]);
  }
});

test("buildVirtualHtml: leaves plain HTML untouched", () => {
  const src = `<div class="card"><span>hi</span></div>`;
  assert.equal(vh(src), src);
});

test("buildVirtualHtml: blanks @model / @{ } / @* *@ directives & blocks", () => {
  const src = `@model Foo\n@{ var a = 1; }\n@* note *@\n<p>ok</p>`;
  const out = vh(src);
  assert.ok(!out.includes("model"), "@model blanked");
  assert.ok(!out.includes("var a"), "@{ } blanked");
  assert.ok(!out.includes("note"), "@* *@ blanked");
  assert.ok(out.includes("<p>ok</p>"), "HTML kept");
});

test("buildVirtualHtml: blanks an @expr run but keeps the surrounding tags", () => {
  const src = `<li>@item.Name</li>`;
  assert.equal(vh(src), `<li>          </li>`);
});

test("buildVirtualHtml: blanks @(...) inside an attribute value, keeps the quotes & tag", () => {
  const src = `<div class="@(x ? "a" : "b")">x</div>`;
  const out = vh(src);
  assert.ok(out.startsWith(`<div class="`));
  assert.ok(out.includes(`">x</div>`));
  assert.ok(!out.includes("?"), "expression blanked");
});

test("buildVirtualHtml: nested braces in @{ } are fully consumed (depth-aware)", () => {
  const src = `@{ if (a) { b(); } }<p>after</p>`;
  const out = vh(src);
  assert.ok(out.trimStart().startsWith("<p>after</p>"), "block fully blanked");
});

test("buildVirtualHtml: @@ escape is blanked (not treated as a Razor transition)", () => {
  assert.equal(vh(`<p>a@@b</p>`), `<p>a  b</p>`);
});

test("buildVirtualHtml: <text> markers are blanked (not real HTML)", () => {
  const out = vh(`<text>hello</text>`);
  assert.ok(!out.includes("<text>"), "open marker blanked");
  assert.ok(!out.includes("</text>"), "close marker blanked");
  assert.ok(out.includes("hello"), "inner literal text kept");
});

test("buildVirtualHtml: an @ inside an HTML comment is left alone", () => {
  const src = `<!-- @Model.Foo -->`;
  assert.equal(vh(src), src);
});

test("buildVirtualHtml: a literal < in text is not treated as a tag", () => {
  const src = `<p>1 < 2</p>`;
  assert.equal(vh(src), src);
});

test("buildVirtualHtml: preserves unicode/emoji length (UTF-16 code units, == Monaco offsets)", () => {
  const src = `<p>café 🚀 @x</p>`;
  const out = vh(src);
  assert.equal(out.length, src.length);
  assert.ok(out.includes("café 🚀"));
  assert.ok(!out.includes("@x"));
});

test("buildVirtualHtml: astral char before a tag keeps tag offsets (UTF-16 invariant)", () => {
  const src = `@("🚀")<p>x</p>`;
  const out = vh(src);
  assert.equal(out.length, src.length, "length preserved in UTF-16 units");
  assert.ok(out.endsWith("<p>x</p>"), "the <p> tag survives at its offset");
  assert.ok(!out.includes("🚀"), "emoji inside @(...) is blanked");
});

test("buildVirtualHtml: astral char in HTML before @* *@ doesn't over-blank into the tag", () => {
  const src = `<p>🚀 @* x *@</p>`;
  const out = vh(src);
  assert.equal(out.length, src.length);
  assert.ok(out.includes("🚀"), "HTML emoji kept");
  assert.ok(out.endsWith("</p>"), "closing tag not eaten by the comment scan");
  assert.ok(!out.includes("x *@"), "@* *@ blanked");
});

test("buildVirtualHtml: astral char with <text> marker after it", () => {
  const src = `<p>🚀 <text>x</text></p>`;
  const out = vh(src);
  assert.equal(out.length, src.length);
  assert.ok(out.includes("🚀"));
  assert.ok(out.includes("x"), "literal inside <text> kept");
  assert.ok(!out.includes("<text>"));
  assert.ok(out.endsWith("</p>"));
});

test("buildVirtualHtml: astral char inside an attribute @(...) value", () => {
  const src = `<p class="@("🚀")"></p>`;
  const out = vh(src);
  assert.equal(out.length, src.length);
  assert.ok(out.startsWith(`<p class="`));
  assert.ok(out.endsWith(`"></p>`));
  assert.ok(!out.includes("🚀"));
});

test("buildVirtualHtml: mask length equals the source length (UTF-16)", () => {
  const src = `<div class="@x">@Name</div>`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(mask.length, src.length);
});

// --- regionAt now consults the MASK, not the blanked text ---

test("regionAt: a tag/attribute position is HTML, an @expr position is Razor", () => {
  const src = `<div class="x">@Name</div>`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, at(src, "div")), "html");
  assert.equal(regionAt(mask, at(src, "class")), "html");
  assert.equal(regionAt(mask, at(src, "Name")), "razor");
});

test("regionAt: caret just after typed HTML still classifies as HTML (left-bias)", () => {
  const src = `<di`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, src.length), "html");
});

test("regionAt: caret right after an @expr classifies as Razor", () => {
  const src = `@Mod`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, src.length), "razor");
});

test("regionAt: real HTML whitespace is HTML, not Razor (the `<div |` attribute spot)", () => {
  // Codex regression: a real space after a tag name is a prime attribute-completion
  // position. It must classify HTML even though blanked Razor is also a space.
  const src = `<div `;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, src.length), "html", "caret after the space → HTML");
  assert.equal(regionAt(mask, at(src, " ")), "html", "the space itself is HTML");
});

test("regionAt: a blanked Razor space is NOT HTML (distinguished from real whitespace)", () => {
  // `@Name ` — the chars under @Name are blanked (mask 0); the trailing real space
  // after the expression is mask 1 but the @Name run must read as Razor.
  const src = `@Name<p></p>`;
  const { mask } = buildVirtualHtml(src);
  // Offset inside the blanked @Name region:
  assert.equal(regionAt(mask, 2), "razor", "blanked Razor offset");
  // The <p> tag is HTML:
  assert.equal(regionAt(mask, at(src, "p")), "html");
});

test("regionAt: an @attr inside a tag is Razor; the tag name around it is HTML", () => {
  const src = `<div @attr class="x">`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, at(src, "div")), "html");
  assert.equal(regionAt(mask, at(src, "attr")), "razor", "@attr run is blanked → Razor");
  assert.equal(regionAt(mask, at(src, "class")), "html");
});
