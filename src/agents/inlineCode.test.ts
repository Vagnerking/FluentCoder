import assert from "node:assert/strict";
import test from "node:test";
import { tokenizeInline, type InlineToken } from "./inlineCode.ts";

/** Só os tokens coloridos — pontuação/espaços (`plain`) ficam de fora. */
function kindsOf(tokens: InlineToken[]): string {
  return tokens
    .filter((token) => token.kind !== "plain")
    .map((token) => `${token.text}:${token.kind}`)
    .join(" ");
}

test("a concatenação dos tokens reproduz o trecho original", () => {
  const samples = [
    "DateTime.UtcNow.AddHours(settings.Web.CookieDurationInHours)",
    'user.ToJson(JsonFactory.DefaultSettings())',
    "try/catch",
    "X-Requested-With",
    "AddDays(-1)",
  ];
  for (const sample of samples) {
    const joined = tokenizeInline(sample)
      .map((token) => token.text)
      .join("");
    assert.equal(joined, sample);
  }
});

test("classifica fluxo de controle, palavras-chave e literais", () => {
  assert.equal(kindsOf(tokenizeInline("try/catch")), "try:control catch:control");
  assert.equal(kindsOf(tokenizeInline("null")), "null:keyword");
  assert.equal(
    kindsOf(tokenizeInline("new Exception")),
    "new:keyword Exception:type",
  );
});

test("chamadas ganham cor de função e PascalCase cor de tipo", () => {
  // `AddDays(` é chamada; `-1` vira número com sinal como pontuação.
  assert.equal(kindsOf(tokenizeInline("AddDays(-1)")), "AddDays:fn 1:num");
  const chain = tokenizeInline("DateTime.UtcNow.AddHours(x)");
  assert.equal(
    kindsOf(chain),
    "DateTime:type UtcNow:type AddHours:fn x:var",
  );
});

test("identificadores camelCase são variáveis; strings e números têm cor própria", () => {
  assert.equal(
    kindsOf(tokenizeInline('settings.Web ?? "padrao" + 42')),
    'settings:var Web:type "padrao":str 42:num',
  );
});

test("palavra-chave seguida de parêntese continua palavra-chave, não função", () => {
  assert.equal(
    kindsOf(tokenizeInline("if (user)")),
    "if:control user:var",
  );
});
