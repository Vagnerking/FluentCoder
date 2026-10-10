import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileUriToPath,
  toSymbolHits,
  rankSymbolHits,
  symbolKindLabel,
  SYMBOL_KIND,
  type LspSymbolInformation,
} from "./workspaceSymbols.ts";

test("fileUriToPath: decodes windows drive and percent-encoding", () => {
  assert.equal(fileUriToPath("file:///c:/proj/Foo.cs"), "c:/proj/Foo.cs");
  assert.equal(
    fileUriToPath("file:///c:/my%20proj/Bar.cs"),
    "c:/my proj/Bar.cs"
  );
});

test("fileUriToPath: posix path keeps its leading slash", () => {
  assert.equal(fileUriToPath("file:///home/u/App.cs"), "/home/u/App.cs");
});

test("fileUriToPath: rejects non-file uris", () => {
  assert.equal(fileUriToPath("untitled:foo"), null);
  assert.equal(fileUriToPath(undefined), null);
});

test("toSymbolHits: 0-based LSP → 1-based Monaco, drops locationless entries", () => {
  const input: LspSymbolInformation[] = [
    {
      name: "Foo",
      kind: SYMBOL_KIND.Class,
      containerName: "App.Models",
      location: {
        uri: "file:///c:/proj/Foo.cs",
        range: { start: { line: 9, character: 4 }, end: { line: 9, character: 7 } },
      },
    },
    { name: "NoLocation", kind: SYMBOL_KIND.Method }, // dropped
    { name: "", location: { uri: "file:///c:/x.cs" } }, // dropped (no name)
  ];
  const hits = toSymbolHits(input);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    name: "Foo",
    containerName: "App.Models",
    kind: SYMBOL_KIND.Class,
    path: "c:/proj/Foo.cs",
    line: 10,
    column: 5,
  });
});

test("toSymbolHits: missing range defaults to line/col 1", () => {
  const hits = toSymbolHits([
    { name: "X", location: { uri: "file:///c:/x.cs" } },
  ]);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[0].column, 1);
});

function hit(name: string, path = "c:/x.cs") {
  return { name, containerName: "", kind: 0, path, line: 1, column: 1 };
}

test("rankSymbolHits: exact > prefix > substring, shorter-first, then stable", () => {
  const hits = [
    hit("UserServiceHelper"), // prefix (len 17)
    hit("User"), // exact
    hit("UserService"), // prefix (len 11) — beats the longer prefix
    hit("MyUserThing"), // substring (len 11)
    hit("AbcUser"), // substring (len 7) — beats the longer substring
  ];
  const ranked = rankSymbolHits("user", hits);
  assert.deepEqual(
    ranked.map((h) => h.name),
    ["User", "UserService", "UserServiceHelper", "AbcUser", "MyUserThing"]
  );
});

test("rankSymbolHits: same length keeps Roslyn's incoming order", () => {
  // Both substring, both length 8 → stable by index.
  const ranked = rankSymbolHits("x", [hit("aaxaaaaa"), hit("bbxbbbbb")]);
  assert.deepEqual(ranked.map((h) => h.name), ["aaxaaaaa", "bbxbbbbb"]);
});

test("rankSymbolHits: empty query preserves order and caps at limit", () => {
  const hits = [hit("A"), hit("B"), hit("C")];
  const ranked = rankSymbolHits("", hits, 2);
  assert.deepEqual(ranked.map((h) => h.name), ["A", "B"]);
});

test("rankSymbolHits: keeps a Roslyn camel-hump match that has no literal substring", () => {
  // "usvc" isn't a literal substring of "UserService", but Roslyn returned it —
  // we must not drop it, just rank it last.
  const ranked = rankSymbolHits("usvc", [hit("UserService")]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, "UserService");
});

test("symbolKindLabel: covers the common .NET kinds", () => {
  assert.equal(symbolKindLabel(SYMBOL_KIND.Class), "class");
  assert.equal(symbolKindLabel(SYMBOL_KIND.Interface), "interface");
  assert.equal(symbolKindLabel(SYMBOL_KIND.Enum), "enum");
  assert.equal(symbolKindLabel(SYMBOL_KIND.Method), "method");
  assert.equal(symbolKindLabel(SYMBOL_KIND.Property), "property");
  assert.equal(symbolKindLabel(undefined), "symbol");
});
