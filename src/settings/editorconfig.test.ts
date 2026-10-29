import test from "node:test";
import assert from "node:assert/strict";
import { compileGlob, editorConfigOverrides, parseEditorConfig, resolveEditorConfig, sectionMatches } from "./editorconfig.ts";

test("parse: preâmbulo root, seções, comentários e valores sem caixa", () => {
  const p = parseEditorConfig("# topo\nroot = TRUE\n\n[*.cs]\nindent_style = Space ; comentário\nindent_size=4\n");
  assert.equal(p.root, true);
  assert.equal(p.sections[0].glob, "*.cs");
  assert.deepEqual(p.sections[0].props, { indent_style: "space", indent_size: "4" });
});

test("glob da spec: *, **, ?, [..], [!..], {a,b}, {n..m}", () => {
  assert.ok(compileGlob("*.cs")("a.cs"));
  assert.ok(!compileGlob("*.cs")("src/a.cs"), "* não cruza /");
  assert.ok(compileGlob("**/*.cs")("src/deep/a.cs"));
  assert.ok(compileGlob("a?.ts")("ab.ts"));
  assert.ok(compileGlob("[ab].js")("b.js"));
  assert.ok(!compileGlob("[!ab].js")("a.js"));
  assert.ok(compileGlob("*.{js,ts}")("x.ts"));
  assert.ok(!compileGlob("*.{js,ts}")("x.cs"));
  assert.ok(compileGlob("file{1..3}.txt")("file2.txt"));
  assert.ok(!compileGlob("file{1..3}.txt")("file7.txt"));
  assert.ok(compileGlob("{package.json,.travis.yml}")("package.json"));
});

test("seção sem / casa em qualquer nível; com / é relativa ao .editorconfig", () => {
  assert.ok(sectionMatches("*.cs", "/p", "/p/src/a.cs"));
  assert.ok(sectionMatches("*.cs", "/p", "/p/a.cs"));
  assert.ok(sectionMatches("src/*.cs", "/p", "/p/src/a.cs"));
  assert.ok(!sectionMatches("src/*.cs", "/p", "/p/other/src/a.cs"));
  assert.ok(sectionMatches("/lib/**", "/p", "/p/lib/x/y.js"));
  assert.ok(!sectionMatches("*", "/p", "/other/a.cs"));
  assert.ok(sectionMatches("*.cs", "C:\\proj", "C:\\proj\\src\\a.cs"));
});

test("resolução: o mais próximo e a seção posterior vencem; unset remove; derivações", () => {
  const chain = [
    { dir: "/p", content: "root = true\n[*]\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\n[*.cs]\nindent_size = 4\n" },
    { dir: "/p/legacy", content: "[*]\nindent_style = tab\ninsert_final_newline = unset\nend_of_line = crlf\nmax_line_length = 120\n" },
  ];
  const cs = resolveEditorConfig(chain, "/p/src/a.cs");
  assert.equal(cs.indent_size, "4");
  assert.equal(cs.tab_width, "4", "tab_width deriva de indent_size");
  const legacy = resolveEditorConfig(chain, "/p/legacy/a.ts");
  assert.equal(legacy.indent_style, "tab");
  assert.equal(legacy.insert_final_newline, undefined);
  const o = editorConfigOverrides(legacy);
  assert.equal(o.insertSpaces, false);
  assert.equal(o.tabSize, 2);
  assert.equal(o.eol, "\r\n");
  assert.equal(o.ruler, 120);
  assert.equal(o.insertFinalNewline, undefined);
  const tabOnly = editorConfigOverrides(resolveEditorConfig([{ dir: "/q", content: "[*]\nindent_style = tab\ntab_width = 8\n" }], "/q/a.go"));
  assert.equal(tabOnly.tabSize, 8);
  assert.equal(tabOnly.indentSize, 8, "indent_size = tab usa tab_width");
});

test("charset e trim viram overrides do salvamento", () => {
  const o = editorConfigOverrides({ charset: "utf-8-bom", trim_trailing_whitespace: "true", insert_final_newline: "false" });
  assert.deepEqual(o.encoding, { id: "UTF-8", bom: true });
  assert.equal(o.trimTrailingWhitespace, true);
  assert.equal(o.insertFinalNewline, false);
});
