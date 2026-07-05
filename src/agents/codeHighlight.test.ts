import assert from "node:assert/strict";
import test from "node:test";
import { highlightCode, normalizeLang } from "./codeHighlight.ts";

test("normaliza rótulos de fence para linguagens do catálogo", () => {
  // Ids e aliases nativos do Shiki passam direto.
  assert.equal(normalizeLang("csharp"), "csharp");
  assert.equal(normalizeLang("cs"), "cs");
  assert.equal(normalizeLang("ts"), "ts");
  // Aliases próprios do editor (Razor/C#) são mapeados.
  assert.equal(normalizeLang("c#"), "csharp");
  assert.equal(normalizeLang("cshtml"), "razor");
  assert.equal(normalizeLang("aspnetcorerazor"), "razor");
  // Caixa e espaços não importam.
  assert.equal(normalizeLang("  CSharp  "), "csharp");
  // Sem grammar ⇒ null (bloco renderiza plano).
  assert.equal(normalizeLang("linguagem-inventada"), null);
  assert.equal(normalizeLang(""), null);
  assert.equal(normalizeLang(null), null);
});

test("realça C# com as cores do tema Dark+ e escapa o conteúdo", async () => {
  const html = await highlightCode(
    'public static void LogIn(HttpContext ctx) { var x = "<b>"; }',
    "csharp",
  );
  assert.ok(html, "deveria produzir HTML realçado");
  // Tokens coloridos (spans com style) e o wrapper do Shiki.
  assert.match(html!, /<pre class="shiki/);
  assert.match(html!, /<span style="color:#/);
  // O conteúdo do código é escapado — nada de HTML cru do bloco vazando.
  assert.doesNotMatch(html!, /<b>/);
});

test("linguagem desconhecida e blocos gigantes degradam para null", async () => {
  assert.equal(await highlightCode("qualquer coisa", "nada-disso"), null);
  assert.equal(await highlightCode("x".repeat(30_000), "csharp"), null);
});
