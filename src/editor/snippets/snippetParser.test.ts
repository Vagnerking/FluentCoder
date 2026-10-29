import assert from "node:assert/strict";
import test from "node:test";
import { fileVariables, parseSnippet, readSnippetFile, resolveSnippetVariables, snippetPreview, timeVariables } from "./snippetParser.ts";

test("parser: tabstops, placeholders aninhados, escolhas, variáveis e escapes", () => {
  const nodes = parseSnippet("for (${1:i} = 0; $1 < ${2:${3:n}}; $1++) {\n\t$0\n} ${4|let,const,var|} $TM_FILENAME ${CURRENT_YEAR:2000} ${TM_FILENAME/(.*)\\..+$/$1/} \\$x \\}");
  const kinds = nodes.filter((n) => n.kind !== "text").map((n) => n.kind);
  assert.deepEqual(kinds, ["placeholder", "tabstop", "placeholder", "tabstop", "tabstop", "choice", "variable", "variable", "variable"]);
  const nested = nodes.find((n) => n.kind === "placeholder" && n.index === 2);
  assert.ok(nested && nested.kind === "placeholder" && nested.children[0].kind === "placeholder");
  const choice = nodes.find((n) => n.kind === "choice");
  assert.deepEqual(choice && choice.kind === "choice" && choice.options, ["let", "const", "var"]);
  const transform = nodes.find((n) => n.kind === "variable" && n.transform);
  assert.ok(transform && transform.kind === "variable" && transform.transform!.startsWith("/(.*)"));
  assert.ok(snippetPreview(nodes).endsWith("$x }"));
});

test("parser tolerante: sintaxe quebrada vira texto", () => {
  assert.equal(snippetPreview(parseSnippet("custa $ 10 e ${abc")), "custa $ 10 e ${abc");
  assert.equal(snippetPreview(parseSnippet("${1:sem fim")), "${1:sem fim");
});

test("prévia: placeholder → texto, escolha → 1ª opção, variável → valor", () => {
  const vars = { TM_FILENAME: "main.rs" };
  assert.equal(snippetPreview(parseSnippet("fn ${1:main}() // $TM_FILENAME ${2|a,b|}"), vars), "fn main() // main.rs a");
});

test("variáveis do app resolvidas e escapadas; as do Monaco ficam", () => {
  const out = resolveSnippetVariables("// $TM_FILENAME ${WORKSPACE_NAME} ${TM_SELECTED_TEXT} ${CLIPBOARD} ${UNKNOWN:x} \\$TM_FILENAME ${TM_FILENAME/a/b/}", { TM_FILENAME: "a$b}.ts", WORKSPACE_NAME: "proj" });
  assert.equal(out, "// a\\$b\\}.ts proj ${TM_SELECTED_TEXT} ${CLIPBOARD} ${UNKNOWN:x} \\$TM_FILENAME ${TM_FILENAME/a/b/}");
  const f = fileVariables("/home/u/proj/src/lib.rs", "/home/u/proj");
  assert.deepEqual([f.TM_FILENAME, f.TM_FILENAME_BASE, f.TM_DIRECTORY, f.RELATIVE_FILEPATH, f.WORKSPACE_NAME], ["lib.rs", "lib", "/home/u/proj/src", "src/lib.rs", "proj"]);
  const w = fileVariables("C:\\p\\a\\b.cs", "C:\\p");
  assert.equal(w.RELATIVE_FILEPATH, "a\\b.cs");
  const t = timeVariables(new Date(2026, 9, 5, 7, 8, 9));
  assert.equal(t.CURRENT_YEAR, "2026");
  assert.equal(t.CURRENT_MONTH, "10");
  assert.equal(t.CURRENT_DATE, "05");
  assert.equal(t.CURRENT_HOUR, "07");
  assert.equal(t.CURRENT_YEAR_SHORT, "26");
});

test("arquivo de snippets: prefixo string/array, corpo array, scope do .code-snippets", () => {
  const defs = readSnippetFile(
    {
      "Print to console": { prefix: ["log", "clg"], body: ["console.log('$1');", "$2"], description: "Log output" },
      Bad: { body: "x" },
      Scoped: { prefix: "sc", body: "y", scope: "javascript, typescript" },
    },
    { source: "Workspace" },
  );
  assert.equal(defs.length, 2);
  assert.deepEqual(defs[0].prefixes, ["log", "clg"]);
  assert.equal(defs[0].body, "console.log('$1');\n$2");
  assert.deepEqual(defs[1].scopes, ["javascript", "typescript"]);
  assert.deepEqual(readSnippetFile({ a: { prefix: "a", body: "b" } }, { language: "rust", source: "x" })[0].scopes, ["rust"]);
});
