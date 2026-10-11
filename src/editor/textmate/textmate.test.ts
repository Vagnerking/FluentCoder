import assert from "node:assert/strict";
import test from "node:test";
import { checkGrammar, regexRisk, timedRegex } from "./redos.ts";
import { convertLanguageConfiguration } from "./languageConfig.ts";
import { buildLanguageResolver, collectLanguageContributions, externalIncludes } from "./contributedLanguages.ts";
import { languageForFile, setContributedLanguageResolver } from "../../language.ts";
import { compileTokenColors, matchScopes, styleToken } from "../../theme/tmScopes.ts";

test("ReDoS: padrões clássicos recusados, gramáticas comuns aceitas", () => {
  for (const bad of ["(a+)+", "(\\w*)*b", "(?:.+){2,}", "([a-z]+)*$", "(x|x)*", "(?:\\s+)+;"]) assert.ok(regexRisk(bad), bad);
  for (const ok of ["\\b(if|else|while)\\b", "\"(?:[^\"\\\\]|\\\\.)*\"", "(?:\\s*,\\s*\\w+)*", "[a-zA-Z_]\\w*", "^\\s*(#)\\s*(include)", "(\\d+)(\\.\\d+)?"]) assert.equal(regexRisk(ok), null, ok);
  assert.ok(regexRisk("a".repeat(20_000)));
});

test("ReDoS: gramática percorrida inteira (repositório, capturas, injeções)", () => {
  const g = {
    scopeName: "source.demo",
    patterns: [{ include: "#str" }, { match: "\\bkw\\b", name: "keyword.demo" }],
    repository: {
      str: { begin: "(\")", end: "\\1", patterns: [{ match: "(a+)+", name: "bad" }] },
      cap: { match: "x", captures: { "1": { patterns: [{ match: "(\\w*)*" }] } } },
    },
    injections: { "L:string": { patterns: [{ match: "ok" }] } },
  };
  const r = checkGrammar(g);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2, r.problems.join("\n"));
  assert.ok(r.patterns.some((p) => p.where.endsWith(".end") && p.backrefs), "end com \\1 não é compilado isolado");
  assert.equal(checkGrammar({ patterns: [] }).ok, false, "sem scopeName");
});

test("ReDoS: regex do JS com orçamento de tempo", () => {
  assert.ok(timedRegex("^\\s*//").regex);
  assert.equal(timedRegex("(a+)+$").regex, null);
  assert.equal(timedRegex("([").regex, null);
  assert.ok(timedRegex({ pattern: "^\\s*end\\b", flags: "i" }).regex!.flags.includes("i"));
  // Relógio falso: estoura o orçamento → descartada.
  let t = 0;
  assert.match(timedRegex("^x", "", 25, () => (t += 30)).problem!, /lenta/);
});

test("language-configuration → Monaco (regex validadas, ações de Enter)", () => {
  const warns: string[] = [];
  const c = convertLanguageConfiguration(
    {
      comments: { lineComment: "#", blockComment: ["/*", "*/"] },
      brackets: [["{", "}"], ["[", "]"], ["bad"]],
      autoClosingPairs: [{ open: "\"", close: "\"", notIn: ["string", "evil"] }, ["(", ")"]],
      surroundingPairs: [["'", "'"]],
      folding: { markers: { start: "^\\s*#region", end: "^\\s*#endregion" }, offSide: true },
      wordPattern: "(-?\\d*\\.\\d\\w*)|([^\\s]+)",
      indentationRules: { increaseIndentPattern: "^.*\\{\\s*$", decreaseIndentPattern: "(a+)+" },
      onEnterRules: [{ beforeText: "^\\s*//.*", action: { indent: "none", appendText: "// " } }, { beforeText: "x", action: { indent: "weird" } }],
    },
    (m) => warns.push(m),
  );
  assert.deepEqual(c.comments, { lineComment: "#", blockComment: ["/*", "*/"] });
  assert.equal(c.brackets!.length, 2);
  assert.deepEqual(c.autoClosingPairs![0], { open: "\"", close: "\"", notIn: ["string"] });
  assert.ok(c.folding!.markers!.start.test("  #region x"));
  assert.equal(c.folding!.offSide, true);
  assert.ok(c.wordPattern!.flags.includes("g"));
  assert.equal(c.indentationRules, undefined, "regra com regex perigosa descartada inteira");
  assert.ok(warns.some((w) => /decreaseIndentPattern/.test(w)));
  assert.equal(c.onEnterRules!.length, 1);
  assert.deepEqual(c.onEnterRules![0].action, { indentAction: 0, appendText: "// " });
});

const prismaLike = {
  id: "prisma.prisma",
  manifest: {
    contributes: {
      languages: [{ id: "prisma", extensions: [".prisma"], aliases: ["Prisma"], configuration: "./language-configuration.json" }],
      grammars: [
        { language: "prisma", scopeName: "source.prisma", path: "./syntaxes/prisma.tmLanguage.json", embeddedLanguages: { "meta.embedded.sql": "sql" } },
        { scopeName: "markdown.prisma.codeblock", path: "./syntaxes/md.json", injectTo: ["text.html.markdown", "source.cs"] },
        { language: "csharp", scopeName: "source.cs.alt", path: "./cs.json" },
      ],
    },
  },
};
const tomlLike = { id: "tamasfe.even-better-toml", manifest: { contributes: { languages: [{ id: "toml", extensions: [".toml"], filenames: ["Cargo.lock", "Pipfile"] }, { id: "csharp", extensions: [".cs"] }] } } };

test("linguagens/gramáticas contribuídas: precedência do pipeline nativo", () => {
  const r = collectLanguageContributions([prismaLike, tomlLike]);
  assert.deepEqual(r.languages.map((l) => l.id).sort(), ["prisma", "toml"]);
  assert.equal(r.languages.find((l) => l.id === "prisma")!.configuration, "language-configuration.json");
  assert.deepEqual(r.grammars.map((g) => g.scopeName), ["source.prisma", "markdown.prisma.codeblock"], "gramática de csharp ignorada");
  assert.deepEqual(r.grammars[1].injectTo, ["text.html.markdown"], "injeção em source.cs ignorada");
  assert.equal(r.grammars[0].path, "syntaxes/prisma.tmLanguage.json");
  assert.ok(r.skipped.some((s) => /csharp/.test(s)));
  const resolve = buildLanguageResolver(r.languages);
  assert.equal(resolve("schema.prisma"), "prisma");
  assert.equal(resolve("Cargo.lock"), "toml");
  assert.equal(resolve("x.cs"), undefined);
});

test("language.ts: contribuída vence o fallback nativo, nunca C#/Razor/TS", () => {
  const r = collectLanguageContributions([prismaLike, tomlLike, { id: "x.y", manifest: { contributes: { languages: [{ id: "mytsx", extensions: [".tsx"] }] } } }]);
  setContributedLanguageResolver(buildLanguageResolver(r.languages));
  try {
    assert.equal(languageForFile("a.toml"), "toml", "antes era o fallback `ini`");
    assert.equal(languageForFile("schema.prisma"), "prisma");
    assert.equal(languageForFile("Program.cs"), "csharp");
    assert.equal(languageForFile("App.tsx"), "typescriptreact", "TS/JS mantêm o pipeline do app");
    assert.equal(languageForFile("x.unknown"), "plaintext");
  } finally {
    setContributedLanguageResolver(null);
  }
  assert.equal(languageForFile("a.toml"), "ini");
});

test("includes externos para pré-carga", () => {
  assert.deepEqual(externalIncludes({ patterns: [{ include: "#x" }, { include: "$self" }, { include: "source.sql" }, { include: "text.html.markdown#fenced" }] }).sort(), ["source.sql", "text.html.markdown"]);
});

test("gramática real no Oniguruma: tokens e cores do tema (registro ponta a ponta)", async () => {
  const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
  const e = await createOnigurumaEngine(import("shiki/wasm"));
  const { Registry, INITIAL } = await import("@shikijs/vscode-textmate");
  const grammar = {
    scopeName: "source.demo",
    patterns: [
      { match: "\\b(model|enum)\\b", name: "keyword.other.demo" },
      { begin: "\"", end: "\"", name: "string.quoted.double.demo" },
      { match: "//.*$", name: "comment.line.demo" },
    ],
  };
  assert.ok(checkGrammar(grammar).ok);
  for (const p of checkGrammar(grammar).patterns) e.createScanner([p.source]);
  const reg = new Registry({
    onigLib: { createOnigScanner: (p: string[]) => e.createScanner(p), createOnigString: (s: string) => e.createString(s) } as never,
    loadGrammar: (s: string) => (s === "source.demo" ? (grammar as never) : null),
  });
  const g = reg.loadGrammar("source.demo")!;
  const line = 'model User "x" // fim';
  const r = g.tokenizeLine(line, INITIAL, 50);
  assert.equal(r.stoppedEarly, false);
  const rules = compileTokenColors([
    { scope: "keyword", settings: { foreground: "#ff79c6" } },
    { scope: "string", settings: { foreground: "#f1fa8c" } },
    { scope: "comment", settings: { foreground: "#6272a4", fontStyle: "italic" } },
  ]);
  const styled = r.tokens.map((t) => [line.slice(t.startIndex, t.endIndex), styleToken(matchScopes(rules, t.scopes), "#f8f8f2")]);
  assert.deepEqual(styled.find(([s]) => s === "model")![1], "tm.ff79c6");
  assert.deepEqual(styled.find(([s]) => s.includes("x"))![1], "tm.f1fa8c");
  assert.deepEqual(styled.find(([s]) => s.startsWith("//"))![1], "tm.6272a4.i");
});
