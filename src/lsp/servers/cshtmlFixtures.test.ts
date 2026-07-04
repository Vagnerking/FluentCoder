/**
 * Real `.cshtml` FIXTURE conformance — the "testes mínimos que devem ser criados"
 * from the validation spec, as actual view files exercised end-to-end through the
 * virtual-HTML projection + markup linter.
 *
 * Each fixture is a realistic view (simple view, form + validation + anti-forgery,
 * layout + sections, typed partial, view component, Razor Page, area view, custom
 * tag helper, encoding/XSS). The invariant asserted for the CLEAN ones:
 *   1. the projection is length/newline-preserving (identity offsets), and
 *   2. it produces ZERO false markup/expression diagnostics — every Razor/C#
 *      construct in the file is understood, not mistaken for a tag or a dangling
 *      member.
 * The deliberately-broken fixture (`erro-markup.cshtml`) asserts the opposite: a
 * real markup error surfaces with a precise range, and nothing else does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildVirtualHtml } from "./cshtmlHtmlProjection.ts";
import { scanRazorMarkup, scanIncompleteRazorExpressions } from "../../lint/razorHtmlLint.ts";

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "cshtml");

function read(name: string): string {
  return readFileSync(join(FIX_DIR, name), "utf8");
}
function findings(src: string) {
  return [...scanRazorMarkup(src), ...scanIncompleteRazorExpressions(src)];
}

/** Fixtures that must project cleanly (no false diagnostics). */
const CLEAN = [
  "view-simples.cshtml",
  "form-validacao.cshtml",
  "layout.cshtml",
  "partial-tipada.cshtml",
  "viewcomponent.cshtml",
  "razor-page.cshtml",
  "area-view.cshtml",
  "tag-helper-custom.cshtml",
  "encoding-xss.cshtml",
];

for (const name of CLEAN) {
  test(`fixture ${name}: projeção preserva offsets (length + newlines)`, () => {
    const src = read(name);
    const { html } = buildVirtualHtml(src);
    assert.equal(html.length, src.length, "length preservado");
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n" || src[i] === "\r") assert.equal(html[i], src[i], `newline @${i}`);
    }
  });

  test(`fixture ${name}: zero diagnósticos falsos (markup + expressão)`, () => {
    const f = findings(read(name));
    assert.equal(
      f.length,
      0,
      `esperado 0 findings, obtido ${f.length}: ${f.map((x) => x.message).join(" | ")}`
    );
  });
}

test("fixture erro-markup.cshtml: flagra a </section> órfã com range preciso", () => {
  const src = read("erro-markup.cshtml");
  const f = scanRazorMarkup(src);
  assert.equal(f.length, 1, "exatamente um erro de markup");
  assert.equal(src.slice(f[0].start, f[0].end), "</section>", "range cobre a tag órfã");
  assert.match(f[0].message, /fechamento.*sem tag de abertura/i);
  // E nenhuma expressão Razor ao redor vira ruído.
  assert.equal(scanIncompleteRazorExpressions(src).length, 0, "sem falso 'expr incompleta'");
});

test("cobertura: todos os .cshtml de __fixtures__ estão referenciados no teste", () => {
  // Guard: um fixture novo no diretório precisa entrar em CLEAN ou ser o de erro,
  // senão passa despercebido sem cobertura.
  const onDisk = readdirSync(FIX_DIR).filter((f) => f.endsWith(".cshtml")).sort();
  const referenced = [...CLEAN, "erro-markup.cshtml"].sort();
  assert.deepEqual(onDisk, referenced, "todo fixture .cshtml deve estar coberto");
});
