import assert from "node:assert/strict";
import test from "node:test";
import {
  addAttachment,
  assemblePrompt,
  attachmentLabel,
  fenceLanguage,
  formatFileBlock,
  formatProblemsBlock,
  formatTerminalBlock,
  presetAttachments,
  type ChatAttachment,
} from "./context.ts";

test("sem anexos a mensagem vai crua (nenhum scaffolding de app)", () => {
  assert.equal(assemblePrompt("oi", []), "oi");
  assert.equal(assemblePrompt("oi", ["  ", ""]), "oi");
});

test("blocos de contexto vêm antes da mensagem do usuário", () => {
  const prompt = assemblePrompt("Por que quebra?", ["CONTEXTO DO EDITOR\nArquivo em foco: `a.ts`", "SAÍDA DO TERMINAL\nx"]);
  assert.equal(
    prompt,
    "CONTEXTO DO EDITOR\nArquivo em foco: `a.ts`\n\nSAÍDA DO TERMINAL\nx\n\nMENSAGEM DO USUÁRIO\nPor que quebra?",
  );
});

test("arquivo anexado usa caminho relativo, fence com linguagem e corte", () => {
  const block = formatFileBlock("C:\\repo", "C:\\repo\\src\\main.rs", "fn main() {}");
  assert.equal(block, "ARQUIVO ANEXADO: `src/main.rs`\n```rust\nfn main() {}\n```");
  const huge = formatFileBlock("/w", "/w/a.txt", "x".repeat(20_000));
  assert.ok(huge.includes("…(truncado em 12.000 caracteres)"));
  assert.equal(fenceLanguage("Index.cshtml"), "razor");
  assert.equal(fenceLanguage("Makefile"), "");
});

test("problemas: erros primeiro, caminho relativo e contagem", () => {
  const block = formatProblemsBlock("/w", [
    { path: "/w/b.ts", name: "b.ts", severity: "warning", message: "não usado", line: 3, column: 1 },
    { path: "/w/a.ts", name: "a.ts", severity: "error", message: "tipo errado", line: 10, column: 5 },
  ]);
  const lines = block.split("\n");
  assert.equal(lines[0], "PROBLEMAS DO WORKSPACE (1 erro(s), 1 outro(s))");
  assert.equal(lines[1], "- `a.ts:10:5` [erro] tipo errado");
  assert.equal(lines[2], "- `b.ts:3:1` [aviso] não usado");
  assert.ok(formatProblemsBlock("/w", []).includes("Nenhum erro"));
});

test("terminal: fence com a cauda e aviso quando vazio", () => {
  assert.ok(formatTerminalBlock("  \n").includes("ainda não produziu saída"));
  const block = formatTerminalBlock("x".repeat(9000) + "FIM");
  assert.ok(block.startsWith("SAÍDA DO TERMINAL (mais recente)\n```\n…"));
  assert.ok(block.endsWith("FIM\n```"));
});

test("chips: rótulo legível e sem duplicata", () => {
  const selection: ChatAttachment = {
    id: "1",
    kind: "selection",
    context: { path: "/w/a.ts", name: "a.ts", selectionText: "x", startLine: 2, endLine: 4 },
  };
  assert.equal(attachmentLabel(selection), "a.ts:2-4");
  assert.equal(attachmentLabel({ id: "2", kind: "workspace" }), "@workspace");
  let list: ChatAttachment[] = [];
  list = addAttachment(list, { id: "3", kind: "file", path: "/w/a.ts", name: "a.ts" });
  list = addAttachment(list, { id: "4", kind: "file", path: "/w/a.ts", name: "a.ts" });
  list = addAttachment(list, { id: "5", kind: "problems" });
  list = addAttachment(list, { id: "6", kind: "problems" });
  assert.equal(list.length, 2);
});

test("presets do agente viram anexos resolvidos no envio", () => {
  let n = 0;
  const id = () => `p${n++}`;
  const editor = { path: "/w/a.ts", name: "a.ts" };
  const attachments = presetAttachments(["graph", "problems", "selection"], editor, id);
  assert.deepEqual(
    attachments.map((a) => a.kind),
    ["graph", "problems"], // sem seleção ativa, o preset de seleção é ignorado
  );
  assert.deepEqual(presetAttachments(["graph"], null, id), []);
});
