/**
 * `.cshtml`/`.razor` DIAGNOSTICS conformance — the "erros esperados" matrix from
 * the validation spec, at the markup-linter layer (the piece that marks mistakes
 * live, as you type; C# *compile* errors come from the Roslyn projection).
 *
 * Two live checks, both scanning the virtual-HTML projection so Razor/C# regions
 * are already blanked at identical offsets:
 *   - `scanRazorMarkup`      → stray closing tags (`</x>` with no open) with a
 *                              precise char range and a linha/coluna-friendly msg.
 *   - `scanIncompleteRazorExpressions` → a dangling `@Model.` (trailing dot).
 *
 * The other half of "erros esperados" is the ABSENCE of false positives: real
 * Razor syntax (generics, `@await`, email `@`, `@@` escape, keyword blocks) must
 * NOT be mistaken for a markup/expression error. Those negative cases are as
 * important as the positive ones — a linter that cries wolf is worse than none.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  scanRazorMarkup,
  scanIncompleteRazorExpressions,
  type RawMarker,
} from "./razorHtmlLint.ts";

/** All findings (both scans) for `src`. */
function findings(src: string): RawMarker[] {
  return [...scanRazorMarkup(src), ...scanIncompleteRazorExpressions(src)];
}
/** The substring a finding's range covers (proves the range is precise). */
function span(src: string, m: RawMarker): string {
  return src.slice(m.start, m.end);
}

// ─────────────────────────── erros de markup (positivos) ───────────────────────

test("erro: tag de fechamento sem abertura </dabbr> — range exato + mensagem", () => {
  const src = `<abbr title="Tel">P:</dabbr>`;
  const f = scanRazorMarkup(src);
  assert.equal(f.length, 1);
  assert.equal(span(src, f[0]), "</dabbr>", "range cobre a tag inteira");
  assert.match(f[0].message, /fechamento.*sem tag de abertura/i);
});

test("erro: </span> órfã no meio do documento", () => {
  const src = `<div>texto</span></div>`;
  const f = scanRazorMarkup(src);
  assert.equal(f.length, 1);
  assert.equal(span(src, f[0]), "</span>");
});

test("erro: fornece offsets utilizáveis para linha/coluna", () => {
  // O range é char-offset; o adapter converte para (linha, coluna) via
  // model.getPositionAt. Garantimos que os offsets são válidos e ordenados.
  const src = `<ul>\n  <li>a</li>\n</span>\n</ul>`;
  const f = scanRazorMarkup(src);
  assert.equal(f.length, 1);
  assert.ok(f[0].start >= 0 && f[0].end > f[0].start, "range ordenado e válido");
  assert.equal(span(src, f[0]), "</span>");
});

test("erro: expressão Razor incompleta @Model. — flagra o ponto final", () => {
  const src = `<p>@Model.</p>`;
  const f = scanIncompleteRazorExpressions(src);
  assert.equal(f.length, 1);
  assert.equal(span(src, f[0]), ".", "range = o ponto pendente");
  assert.match(f[0].message, /incompleta/i);
});

test("erro: @Model.A. (ponto após membro) também é incompleta", () => {
  const f = scanIncompleteRazorExpressions("@Model.A. ");
  assert.equal(f.length, 1);
});

test("erro: erros não são silenciosamente ignorados (há finding)", () => {
  // Critério de aceite: erro claro, não engolido.
  assert.ok(findings(`<div></p>`).length >= 1, "close mismatch produz finding");
});

// ─────────────────────────── AUSÊNCIA de falso positivo ───────────────────────

test("limpo: HTML bem-formado não gera finding", () => {
  assert.equal(findings(`<div class="a"><span>oi</span></div>`).length, 0);
});

test("limpo: tags de fechamento opcional (<li>, <p>) não geram erro", () => {
  assert.equal(scanRazorMarkup(`<ul><li>a<li>b</ul>`).length, 0);
  assert.equal(scanRazorMarkup(`<p>a<p>b`).length, 0);
});

test("limpo: void/self-closing não precisam de fechamento", () => {
  assert.equal(scanRazorMarkup(`<br /><img src="x"><hr>texto<input type="text" />`).length, 0);
});

test("limpo: @Model.City (membro completo) não é incompleto", () => {
  assert.equal(scanIncompleteRazorExpressions(`<p>@Model.City</p>`).length, 0);
});

test("limpo: generic method @Model.Get<int>() NÃO vira tag fantasma", () => {
  // A correção de generics na projeção: `<int>` some com o C#, então nem
  // scanRazorMarkup (tag) nem o resto veem `<int>` como abertura órfã.
  assert.equal(findings(`<p>@Model.Get<int>()</p><div></div>`).length, 0);
});

test("limpo: generic aninhado @svc.Get<Dictionary<string,int>>() limpo", () => {
  assert.equal(findings(`<p>@svc.Get<Dictionary<string,int>>()</p>`).length, 0);
});

test("limpo: @await Html.PartialAsync(...) não vaza como texto/tag", () => {
  assert.equal(findings(`<div>@await Html.PartialAsync("_X")</div>`).length, 0);
});

test("limpo: @await Component.InvokeAsync(...) limpo", () => {
  assert.equal(findings(`<aside>@await Component.InvokeAsync("Cart")</aside>`).length, 0);
});

test("limpo: List<string> dentro de @if não é tag órfã", () => {
  const src = `@if (ok) {\n  List<string> xs = new();\n  <p>x</p>\n}\n<div></div>`;
  assert.equal(findings(src).length, 0);
});

test("limpo: email teste@email.com. não é expressão incompleta", () => {
  assert.equal(scanIncompleteRazorExpressions(`<p>Contato: suporte@empresa.com.</p>`).length, 0);
});

test("limpo: escape @@ com ponto final (a@@b.) não é expressão incompleta", () => {
  // `@@` é sempre literal — `a@@b.` é o texto `a@b.`, sem membro Razor pendente.
  assert.equal(scanIncompleteRazorExpressions(`<p>a@@b.</p>`).length, 0);
});

test("limpo: @@ isolado seguido de @Model. real — só o real flagra", () => {
  assert.equal(scanIncompleteRazorExpressions(`<p>@@x @Model.</p>`).length, 1);
});

test("limpo: @{ code. } — ponto dentro de bloco C# é da alçada do Roslyn", () => {
  assert.equal(scanIncompleteRazorExpressions(`@{ var x = a. }`).length, 0);
});

test("limpo: @: torna o resto da linha literal — @Model. depois não flagra", () => {
  assert.equal(scanIncompleteRazorExpressions(`@: @Model.`).length, 0);
});

test("limpo: } dentro de string C# em @{ } não desincroniza a varredura de tags", () => {
  assert.equal(scanRazorMarkup(`@{ var s = "}"; }\n<div><p>a</p></div>`).length, 0);
});

test("limpo: partial/tag helpers não geram erro de markup", () => {
  assert.equal(findings(`<partial name="_X" model="Model.Item" />`).length, 0);
  assert.equal(findings(`<a asp-controller="Home" asp-action="Index">x</a>`).length, 0);
  assert.equal(findings(`<input asp-for="Nome" />`).length, 0);
});

test("limpo: @switch multi-linha com markup nos cases não gera erro", () => {
  const src = `@switch (k) {\n  case 1:\n    <p>a</p>\n    break;\n  default:\n    <b>d</b>\n    break;\n}`;
  assert.equal(findings(src).length, 0);
});
