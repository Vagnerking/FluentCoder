import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EDITOR_OPTIONS } from "./editorOptions.ts";

// PR #108: o balão de hover abria EMBAIXO do símbolo (default `above: false`),
// cobrindo a linha seguinte — o texto que o usuário ia clicar. Estes testes
// travam as duas metades do fix contra regressão.

test("hover abre acima da linha (hover.above), como o VS Code", () => {
  assert.equal(
    EDITOR_OPTIONS.hover?.above,
    true,
    "hover.above deve ser true — com o default (false) o balão cobre a linha seguinte"
  );
});

test("styles.css desloca o balão de hover pra cima (folga da linha do símbolo)", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const rule = /\.monaco-resizable-hover\s*\{[^}]*transform:\s*translateY\(\s*(-\d+(?:\.\d+)?)px\s*\)/.exec(
    css
  );
  assert.ok(
    rule,
    ".monaco-resizable-hover deve ter transform: translateY(-Npx) — margin não funciona (o content widget do Monaco absorve no recálculo do top)"
  );
  assert.ok(
    Number(rule[1]) < 0,
    `o translateY deve ser negativo (subir o balão); veio ${rule[1]}px`
  );
});

// Opções conquistadas por bugs anteriores — não podem voltar ao default.
test("opções do editor que não podem regredir ao default do Monaco", () => {
  assert.equal(
    EDITOR_OPTIONS.wordBasedSuggestions,
    "off",
    "word-based suggestions poluíam o autocomplete do .cshtml (itens `abc` antes do Roslyn)"
  );
  assert.equal(
    EDITOR_OPTIONS["semanticHighlighting.enabled"],
    false,
    "o engine nativo de semantic tokens deixa o C# sem cor na stack @codingame (ver editorOptions.ts)"
  );
  assert.equal(EDITOR_OPTIONS.suggestLineHeight, 22, "linhas do suggest sobrepunham com altura menor");
});
