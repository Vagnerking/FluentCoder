import test from "node:test";
import assert from "node:assert/strict";
import { CORE_SETTINGS } from "./coreSettings.ts";
import { SETTING_CATEGORIES } from "./registry.ts";
import { buildSections, highlightRanges, matchesQuery, parseSettingsQuery } from "./settingsSearch.ts";

const none = () => false;

test("query: palavras e filtros @modified/@ext/@lang/@tag/@id", () => {
  const q = parseSettingsQuery("  fonte @modified @ext:Pub.Ext @lang:typescript @tag:acessibilidade @id:editor.tabSize ");
  assert.deepEqual(q, { words: ["fonte"], modified: true, ext: "pub.ext", lang: "typescript", tags: ["acessibilidade"], id: "editor.tabSize" });
});

test("busca por título, descrição, chave e rótulo do enum (todas as palavras)", () => {
  const find = (raw: string) => CORE_SETTINGS.filter((s) => matchesQuery(s, parseSettingsQuery(raw), none)).map((s) => s.key);
  assert.ok(find("minimapa").includes("editor.minimap.enabled"));
  assert.ok(find("editor.tabsize").includes("editor.tabSize"));
  assert.ok(find("após um intervalo").includes("files.autoSave"), "rótulo do enum");
  assert.deepEqual(find("tamanho fonte terminal"), ["terminal.integrated.fontSize"]);
  assert.ok(find("@lang:python").every((k) => CORE_SETTINGS.find((s) => s.key === k)!.scope === "language-overridable"));
  assert.deepEqual(
    CORE_SETTINGS.filter((s) => matchesQuery(s, parseSettingsQuery("@modified"), (k) => k === "editor.fontSize")).map((s) => s.key),
    ["editor.fontSize"],
  );
});

test("destaque mescla faixas sobrepostas e ignora caixa", () => {
  assert.deepEqual(highlightRanges("Tamanho da Fonte", ["fon", "onte"]), [[11, 16]]);
  assert.deepEqual(highlightRanges("abc abc", ["abc"]), [[0, 3], [4, 7]]);
  assert.deepEqual(highlightRanges("x", []), []);
});

test("toda setting do core cai numa categoria da árvore; seções seguem a ordem das categorias", () => {
  const ids = new Set(SETTING_CATEGORIES.map((c) => c.id));
  for (const s of CORE_SETTINGS) assert.ok(ids.has(s.category), s.key);
  const sections = buildSections(CORE_SETTINGS);
  assert.deepEqual(sections.map((s) => s.id), SETTING_CATEGORIES.map((c) => c.id));
  assert.equal(sections.reduce((n, s) => n + s.count, 0), CORE_SETTINGS.length);
  // Chaves únicas.
  assert.equal(new Set(CORE_SETTINGS.map((s) => s.key)).size, CORE_SETTINGS.length);
});
