import test from "node:test";
import assert from "node:assert/strict";
import { appendToJsoncArray, parseJsonc, parseJsoncObject, removeFromJsoncArray, replaceInJsoncArray, setJsoncValue } from "./jsonc.ts";

const SAMPLE = `// Configurações do usuário
{
  // fonte
  "editor.fontSize": 14,
  /* bloco */
  "editor.tabSize": 2,
  "[typescript]": {
    "editor.tabSize": 4,
  },
}
`;

test("parse aceita comentários e vírgula final", () => {
  const { value, errors } = parseJsonc(SAMPLE);
  assert.deepEqual(errors, []);
  assert.deepEqual(value, {
    "editor.fontSize": 14,
    "editor.tabSize": 2,
    "[typescript]": { "editor.tabSize": 4 },
  });
});

test("parse tolerante devolve erros sem lançar", () => {
  const { value, errors } = parseJsonc('{ "a": 1 "b": 2 }');
  assert.ok(errors.length > 0);
  assert.deepEqual(value, { a: 1, b: 2 });
  assert.deepEqual(parseJsoncObject(""), {});
  assert.deepEqual(parseJsoncObject("[1]"), {});
  assert.deepEqual(parseJsonc('{"s": "a\\nb\\u0041"}').value, { s: "a\nbA" });
});

test("trocar valor preserva comentários", () => {
  const out = setJsoncValue(SAMPLE, ["editor.fontSize"], 16);
  assert.ok(out.includes("// fonte"));
  assert.ok(out.includes("/* bloco */"));
  assert.ok(out.startsWith("// Configurações do usuário"));
  assert.equal(parseJsoncObject(out)["editor.fontSize"], 16);
  // Só a faixa do valor mudou.
  assert.equal(out, SAMPLE.replace('"editor.fontSize": 14', '"editor.fontSize": 16'));
});

test("inserir mantém vírgula final e indentação", () => {
  const out = setJsoncValue(SAMPLE, ["editor.wordWrap"], "on");
  assert.equal(parseJsoncObject(out)["editor.wordWrap"], "on");
  assert.ok(out.includes('\n  "editor.wordWrap": "on",\n}'));
  assert.deepEqual(parseJsonc(out).errors, []);
});

test("override de linguagem aninhado: troca, cria e remove", () => {
  let out = setJsoncValue(SAMPLE, ["[typescript]", "editor.tabSize"], 8);
  assert.deepEqual(parseJsoncObject(out)["[typescript]"], { "editor.tabSize": 8 });
  out = setJsoncValue(out, ["[python]", "editor.tabSize"], 4);
  assert.deepEqual(parseJsoncObject(out)["[python]"], { "editor.tabSize": 4 });
  assert.deepEqual(parseJsonc(out).errors, []);
  out = setJsoncValue(out, ["[typescript]", "editor.tabSize"], undefined);
  assert.deepEqual(parseJsoncObject(out)["[typescript]"], {});
  assert.deepEqual(parseJsonc(out).errors, []);
});

test("remover propriedade do meio, a última e a única", () => {
  const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
  assert.equal(setJsoncValue(text, ["b"], undefined), '{\n  "a": 1,\n  "c": 3\n}\n');
  assert.equal(setJsoncValue(text, ["c"], undefined), '{\n  "a": 1,\n  "b": 2\n}\n');
  assert.equal(setJsoncValue('{\n  "a": 1\n}', ["a"], undefined), "{\n}");
  assert.equal(setJsoncValue(text, ["zzz"], undefined), text);
  // Inline.
  assert.equal(setJsoncValue('{ "a": 1, "b": 2 }', ["a"], undefined), '{ "b": 2 }');
});

test("arquivo vazio ou só comentário vira objeto novo", () => {
  assert.equal(setJsoncValue("", ["editor.fontSize"], 12), '{\n  "editor.fontSize": 12\n}\n');
  const out = setJsoncValue("// nada\n", ["x"], true);
  assert.ok(out.startsWith("// nada"));
  assert.deepEqual(parseJsoncObject(out), { x: true });
});

test("objeto vazio e indentação com tab detectada", () => {
  assert.equal(setJsoncValue("{}", ["a"], 1), '{\n  "a": 1\n}');
  const tabbed = '{\n\t"a": 1\n}';
  assert.equal(setJsoncValue(tabbed, ["b"], { x: 1 }), '{\n\t"a": 1,\n\t"b": {\n\t\t"x": 1\n\t}\n}');
});

test("CRLF é preservado", () => {
  const out = setJsoncValue('{\r\n  "a": 1\r\n}\r\n', ["b"], 2);
  assert.equal(out, '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n');
});

test("round-trip: várias edições seguidas continuam JSONC válido", () => {
  let text = SAMPLE;
  for (let i = 0; i < 20; i++) {
    text = setJsoncValue(text, [`k${i % 5}`], i % 3 === 0 ? undefined : { n: i, list: [i, "x"] });
    assert.deepEqual(parseJsonc(text).errors, [], text);
  }
  assert.ok(text.includes("// fonte"));
});

test("listas (keybindings.json): acrescentar, trocar e remover preservando comentários", () => {
  let text = '// Atalhos\n[\n  // salvar\n  { "key": "ctrl+s", "command": "a" }\n]\n';
  text = appendToJsoncArray(text, { key: "ctrl+k", command: "b" });
  assert.deepEqual(parseJsonc(text).errors, []);
  assert.equal((parseJsonc(text).value as unknown[]).length, 2);
  assert.ok(text.includes("// salvar"));
  text = replaceInJsoncArray(text, 1, { key: "ctrl+j", command: "c" });
  assert.equal((parseJsonc(text).value as { command: string }[])[1].command, "c");
  text = removeFromJsoncArray(text, 0);
  assert.deepEqual(parseJsonc(text).value, [{ key: "ctrl+j", command: "c" }]);
  assert.ok(text.startsWith("// Atalhos"));
  assert.equal(appendToJsoncArray("", { a: 1 }), '[\n  {\n    "a": 1\n  }\n]\n');
  assert.deepEqual(parseJsonc(removeFromJsoncArray("[1]", 0)).value, []);
});
