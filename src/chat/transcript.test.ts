import assert from "node:assert/strict";
import test from "node:test";
import {
  diffStats,
  diffTexts,
  formatUsage,
  interleaveTranscript,
  mergeUsage,
  settleToolCalls,
  toolIcon,
  unifiedDiffToTexts,
  upsertToolCall,
} from "./transcript.ts";

test("upsert cria, ancora no texto e mescla atualizações parciais", () => {
  let calls = upsertToolCall(undefined, { id: "t1", kind: "execute", title: "Rodar", detail: "ls" }, 10);
  assert.deepEqual(calls, [
    { id: "t1", kind: "execute", title: "Rodar", status: "in_progress", detail: "ls", textOffset: 10 },
  ]);
  calls = upsertToolCall(calls, { id: "t1", status: "completed", output: "a b" }, 99);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "completed");
  assert.equal(calls[0].output, "a b");
  assert.equal(calls[0].detail, "ls", "campo ausente preserva o anterior");
  assert.equal(calls[0].textOffset, 10, "offset é o do início da chamada");
  // Status desconhecido é ignorado.
  calls = upsertToolCall(calls, { id: "t1", status: "weird" as never }, 0);
  assert.equal(calls[0].status, "completed");
});

test("ao fim do turno, chamadas abertas são encerradas", () => {
  const calls = [
    { id: "a", status: "in_progress" as const, textOffset: 0 },
    { id: "b", status: "completed" as const, textOffset: 0 },
  ];
  assert.deepEqual(settleToolCalls(calls, "error")!.map((c) => c.status), ["failed", "completed"]);
  assert.deepEqual(settleToolCalls(calls, "done")!.map((c) => c.status), ["completed", "completed"]);
});

test("intercala texto e grupos de ferramentas na ordem do stream", () => {
  const segments = interleaveTranscript("Vou ler.Pronto!", [
    { id: "r1", textOffset: 8 },
    { id: "r2", textOffset: 8 },
    { id: "r0", textOffset: 0 },
  ]);
  assert.deepEqual(
    segments.map((segment) =>
      segment.type === "text" ? `T:${segment.text}` : `C:${segment.calls.map((c) => c.id).join(",")}`,
    ),
    ["C:r0", "T:Vou ler.", "C:r1,r2", "T:Pronto!"],
  );
  assert.deepEqual(interleaveTranscript("", undefined), []);
  // Offset além do texto (texto ainda não chegou) cai no fim.
  assert.equal(interleaveTranscript("ab", [{ id: "x", textOffset: 50 }]).at(-1)?.type, "tools");
});

test("reconstrói os dois lados de um diff unificado", () => {
  const diff = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "@@ -10,1 +10,2 @@",
    " fim",
    "+novo",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(unifiedDiffToTexts(diff), {
    oldText: "const a = 1;\nconst b = 2;\n⋯\nfim",
    newText: "const a = 1;\nconst b = 3;\n⋯\nfim\nnovo",
  });
  assert.deepEqual(diffStats({ path: "x", unified: diff }), { added: 2, removed: 1 });
  assert.deepEqual(diffTexts({ path: "x", oldText: "a", newText: "b" }), { oldText: "a", newText: "b" });
  assert.deepEqual(diffTexts({ path: "x", newText: "só novo" }), { oldText: "", newText: "só novo" });
});

test("consumo: mescla por campo e formata em pt-BR", () => {
  const usage = mergeUsage({ inputTokens: 10 }, { outputTokens: 5, costUsd: 0.0421, contextUsed: 50_000, contextWindow: 200_000 });
  assert.equal(
    formatUsage({ ...usage, inputTokens: 1234 }),
    "1.234 tokens de entrada · 5 de saída · US$ 0,0421 · 25% do contexto",
  );
  assert.equal(formatUsage(undefined), null);
  assert.equal(formatUsage({}), null);
});

test("ícone pelo tipo da ferramenta", () => {
  assert.equal(toolIcon("execute"), "toolExecute");
  assert.equal(toolIcon(undefined), "toolOther");
});
