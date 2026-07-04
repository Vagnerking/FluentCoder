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

test("buildVirtualHtml: a `)` inside a C# string in @(...) does NOT close early", () => {
  // `@(")")` — the `)` is inside the string literal; the block ends at the real `)`.
  const src = `@(")")<p>after</p>`;
  const out = vh(src);
  assert.ok(out.trimStart().startsWith("<p>after</p>"), `block fully blanked, got: ${out}`);
  assert.ok(!out.includes('"'), "the C# string was blanked, not leaked into HTML");
});

test("buildVirtualHtml: a `}` inside a C# string in @{ } does NOT close early", () => {
  const src = `@{ var s = "}"; }<p>after</p>`;
  const out = vh(src);
  assert.ok(out.trimStart().startsWith("<p>after</p>"), `block fully blanked, got: ${out}`);
  assert.ok(!out.includes("var s"), "C# blanked");
});

test("buildVirtualHtml: a close paren inside a verbatim string does NOT close early", () => {
  const src = `@(@")")<p>after</p>`;
  const out = vh(src);
  assert.ok(out.trimStart().startsWith("<p>after</p>"), `block fully blanked, got: ${out}`);
});

test("buildVirtualHtml: a `}` in a `//` comment inside @{ } does NOT close early", () => {
  const src = `@{ // }\n var x = 1; }<p>after</p>`;
  const out = vh(src);
  assert.ok(out.trimEnd().endsWith("<p>after</p>"), `block fully blanked, got: ${out}`);
  assert.ok(!out.includes("var x"), "C# blanked past the comment");
});

test("buildVirtualHtml: a `)` in a C# string inside an attribute @(...) does NOT close early", () => {
  const src = `<div class="@(")")">x</div>`;
  const out = vh(src);
  // The tag structure survives and the `)` in the string didn't end the expr early.
  assert.ok(out.startsWith(`<div class="`), `got: ${out}`);
  assert.ok(out.includes(`">x</div>`), `tag intact, got: ${out}`);
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

test("regionAt: caret just after typed HTML still classifies as HTML (left-char wins)", () => {
  const src = `<di`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, src.length), "html");
});

test("regionAt: caret right after an @expr classifies as Razor", () => {
  const src = `@Mod`;
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, src.length), "razor");
});

test("regionAt: caret after `@Model.` before `</p>` is Razor, not HTML (member completion)", () => {
  // THE BUG: `<p>@Model.|</p>` — the caret's NEXT char is the HTML `<` of `</p>`,
  // but the user is completing a C# member. Left char (`.`, blanked Razor) wins.
  const src = `<p>@Model.</p>`;
  const { mask } = buildVirtualHtml(src);
  const caret = src.indexOf("@Model.") + "@Model.".length; // right after the dot
  assert.equal(regionAt(mask, caret), "razor");
});

test("regionAt: caret after `@Model.` mid-expression (before `City`) is Razor", () => {
  const src = `<p>@Model.City</p>`;
  const { mask } = buildVirtualHtml(src);
  const caret = src.indexOf("@Model.") + "@Model.".length;
  assert.equal(regionAt(mask, caret), "razor");
});

test("regionAt: caret inside a lambda in an implicit expression is Razor (the `(x => x.` bug)", () => {
  // THE BUG: the implicit-expression scanner stopped at the FIRST space (inside the
  // parens, before `=>`), leaving the lambda tail classified as HTML → member
  // completion fell through to the HTML service. The `(...)` segment must be
  // consumed whole, spaces and all.
  const src = `@Model.FirstOrDefault(x => x.)`;
  const { mask } = buildVirtualHtml(src);
  const caret = src.indexOf("x.") + "x.".length; // right after the inner dot
  assert.equal(regionAt(mask, caret), "razor");
  // the whole expression is blanked (no HTML leaked from inside the parens)
  const out = buildVirtualHtml(src).html;
  assert.ok(!out.includes("FirstOrDefault"), `expr blanked, got: ${out}`);
});

test("regionAt: INCOMPLETE implicit expr with unclosed `(` only blanks its line", () => {
  // While typing `@Model.First(x => x.` the `(` is unclosed — the scan must NOT run
  // to EOF and blank the HTML below; it clamps to the line end.
  const src = `@Model.FirstOrDefault(x => x.\n<p>after</p>`;
  const out = buildVirtualHtml(src).html;
  assert.ok(out.trimStart().endsWith("<p>after</p>"), `HTML below survives, got: ${JSON.stringify(out)}`);
  const { mask } = buildVirtualHtml(src);
  const caret = src.indexOf("x.") + "x.".length;
  assert.equal(regionAt(mask, caret), "razor", "caret in the lambda is Razor");
});

test("buildVirtualHtml: indexer `@Model[0].` and chained calls stay Razor", () => {
  const src = `@Model.Where(x => x.A).Select(y => y.B)`;
  const out = buildVirtualHtml(src).html;
  assert.ok(!out.includes("Where") && !out.includes("Select"), `chained calls blanked, got: ${out}`);
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

// --- keyword statement blocks (@if/@foreach/…) with markup re-entry ---

test("buildVirtualHtml: @if blanks keyword+condition+braces but KEEPS the markup body", () => {
  const src = `@if (Model.Ok) {\n  <p>@Model.Name</p>\n}\n<span>after</span>`;
  const out = vh(src);
  assert.ok(!out.includes("if"), "keyword blanked");
  assert.ok(!out.includes("Model.Ok"), "condition blanked");
  assert.ok(!out.includes("{") && !out.includes("}"), "braces blanked");
  assert.ok(out.includes("<p>"), "markup inside the block KEPT");
  assert.ok(out.includes("</p>"), "close tag kept");
  assert.ok(!out.includes("Model.Name"), "@expr inside the markup blanked");
  assert.ok(out.includes("<span>after</span>"), "markup after the block kept");
});

test("buildVirtualHtml: @foreach keeps its <li> body as HTML", () => {
  const src = `<ul>@foreach (var i in Model.Items) { <li>@i.Name</li> }</ul>`;
  const out = vh(src);
  assert.ok(out.includes("<ul>") && out.includes("</ul>"));
  assert.ok(out.includes("<li>") && out.includes("</li>"), "li body re-entered as markup");
  assert.ok(!out.includes("foreach") && !out.includes("Model.Items"));
});

test("buildVirtualHtml: generics inside a code block are NOT phantom tags", () => {
  // The old scanner leaked `List<string>` into the HTML view — `<string>` read as
  // an open tag and every later close tag became "stray".
  const src = `@if (a) {\n  List<string> xs = new();\n  <p>x</p>\n}`;
  const out = vh(src);
  assert.ok(!out.includes("<string>"), "generic type argument blanked with the C#");
  assert.ok(out.includes("<p>x</p>"), "markup line kept");
});

test("buildVirtualHtml: @if/else if/else chain — all C# blanked, all markup kept", () => {
  const src = `@if (a) { <b>1</b> } else if (b) { <i>2</i> } else { <u>3</u> }`;
  const out = vh(src);
  assert.ok(!out.includes("else"), "else keywords blanked");
  assert.ok(out.includes("<b>1</b>") && out.includes("<i>2</i>") && out.includes("<u>3</u>"));
});

test("buildVirtualHtml: @try/catch/finally and @do/while chains", () => {
  const srcTry = `@try { <p>t</p> } catch (Exception ex) { <p>c</p> } finally { <p>f</p> }`;
  const outTry = vh(srcTry);
  assert.ok(!outTry.includes("catch") && !outTry.includes("finally") && !outTry.includes("Exception"));
  assert.ok(outTry.includes("<p>t</p>") && outTry.includes("<p>c</p>") && outTry.includes("<p>f</p>"));

  const srcDo = `@do { <p>x</p> } while (a < 3);<span>after</span>`;
  const outDo = vh(srcDo);
  assert.ok(!outDo.includes("while") && !outDo.includes("a < 3"), "while tail blanked");
  assert.ok(outDo.includes("<p>x</p>") && outDo.includes("<span>after</span>"));
});

test("buildVirtualHtml: @using STATEMENT (parens) is a block; @using IMPORT blanks the line", () => {
  const stmt = `@using (var s = Open()) { <p>x</p> }`;
  const outStmt = vh(stmt);
  assert.ok(outStmt.includes("<p>x</p>"), "statement body markup kept");
  assert.ok(!outStmt.includes("Open"), "statement condition blanked");

  const imp = `@using Foo.Bar.Baz\n<p>x</p>`;
  const outImp = vh(imp);
  assert.ok(!outImp.includes("Foo.Bar.Baz"), "import ARGUMENT blanked (whole line)");
  assert.ok(outImp.includes("<p>x</p>"));
});

test("buildVirtualHtml: @: inside a code block keeps the rest of the line as markup", () => {
  const src = `@if (a) {\n  @: plain <b>text</b> here\n}`;
  const out = vh(src);
  assert.ok(out.includes("plain") && out.includes("<b>text</b>"), "markup line kept");
});

// --- directive lines ---

test("buildVirtualHtml: directive ARGUMENTS are blanked (whole line), not just the word", () => {
  // The old scanner blanked only `@model`, leaking `Foo.Bar` as HTML text.
  const src = `@model Foo.Bar\n@inject IMyService Svc\n@addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers\n<p>x</p>`;
  const out = vh(src);
  assert.ok(!out.includes("Foo.Bar"), "@model argument blanked");
  assert.ok(!out.includes("IMyService") && !out.includes("Svc"), "@inject arguments blanked");
  assert.ok(!out.includes("TagHelpers"), "@addTagHelper argument blanked");
  assert.ok(out.includes("<p>x</p>"), "HTML after directives kept");
});

test("buildVirtualHtml: @functions block is fully blanked (pure C#)", () => {
  const src = `@functions {\n  public int X { get; set; }\n}\n<p>ok</p>`;
  const out = vh(src);
  assert.ok(!out.includes("public") && !out.includes("get;"), "members blanked");
  assert.ok(out.includes("<p>ok</p>"));
});

test("buildVirtualHtml: @section keeps its markup body as HTML", () => {
  const src = `@section Scripts {\n  <script src="x.js"></script>\n}\n<p>ok</p>`;
  const out = vh(src);
  assert.ok(!out.includes("section") && !out.includes("Scripts"), "header blanked");
  assert.ok(out.includes(`<script src="x.js"></script>`), "section body kept as HTML");
  assert.ok(out.includes("<p>ok</p>"), "content after the section kept");
});

// --- email / literal `@` ---

test("buildVirtualHtml: an email @ is literal text, not a Razor expression", () => {
  const src = `<p>contato@empresa.com</p>`;
  const out = vh(src);
  assert.equal(out, src, "email domain must NOT be blanked");
  const { mask } = buildVirtualHtml(src);
  assert.equal(regionAt(mask, at(src, "empresa")), "html");
});

test("buildVirtualHtml: email inside an attribute value is literal too", () => {
  const src = `<a href="mailto:a@b.com">m</a>`;
  assert.equal(vh(src), src);
});

test("buildVirtualHtml: @$\"...\" interpolated-verbatim string does not desync a block", () => {
  const src = `@{ var p = @$"C:\\x\\{name}"; }<p>after</p>`;
  const out = vh(src);
  assert.ok(out.trimStart().startsWith("<p>after</p>"), `block fully blanked, got: ${out}`);
});
