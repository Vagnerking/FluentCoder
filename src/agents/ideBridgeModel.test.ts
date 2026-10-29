import assert from "node:assert/strict";
import test from "node:test";
import {
  diffAcceptedResult,
  diffRejectedResult,
  filesToIdeTabs,
  findTextRange,
  isDiskPath,
  markerSeverityToIde,
  markersToDiagnostics,
  normalizeEol,
  parseOpenDiffArgs,
  saveDocumentResult,
  toIdeSelection,
} from "./ideBridgeModel.ts";

test("seleção do Monaco (1-based) vira 0-based no protocolo", () => {
  const sel = toIdeSelection("/w/a.ts", "const answer = 42;", {
    startLineNumber: 10,
    startColumn: 1,
    endLineNumber: 10,
    endColumn: 19,
  });
  assert.deepEqual(sel, {
    text: "const answer = 42;",
    filePath: "/w/a.ts",
    selection: {
      start: { line: 9, character: 0 },
      end: { line: 9, character: 18 },
      isEmpty: false,
    },
  });
});

test("cursor sem seleção é isEmpty", () => {
  const sel = toIdeSelection("/w/a.ts", "", {
    startLineNumber: 3,
    startColumn: 5,
    endLineNumber: 3,
    endColumn: 5,
  });
  assert.equal(sel.selection.isEmpty, true);
  assert.deepEqual(sel.selection.start, { line: 2, character: 4 });
});

test("severidade do Monaco mapeia para os nomes do protocolo", () => {
  assert.equal(markerSeverityToIde(8), "Error");
  assert.equal(markerSeverityToIde(4), "Warning");
  assert.equal(markerSeverityToIde(2), "Information");
  assert.equal(markerSeverityToIde(1), "Hint");
});

test("markers são agrupados por arquivo com faixas 0-based", () => {
  const out = markersToDiagnostics([
    {
      path: "/w/a.ts",
      uri: "file:///w/a.ts",
      message: "'x' is declared but never used",
      severity: 4,
      startLineNumber: 10,
      startColumn: 7,
      endLineNumber: 10,
      endColumn: 13,
      source: "ts",
    },
    {
      path: "/w/b.cs",
      uri: "file:///w/b.cs",
      message: "CS0103",
      severity: 8,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
      owner: "csharp",
    },
    {
      path: "/w/a.ts",
      uri: "file:///w/a.ts",
      message: "outro",
      severity: 8,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].uri, "file:///w/a.ts");
  assert.equal(out[0].diagnostics.length, 2);
  assert.deepEqual(out[0].diagnostics[0], {
    message: "'x' is declared but never used",
    severity: "Warning",
    range: { start: { line: 9, character: 6 }, end: { line: 9, character: 12 } },
    source: "ts",
  });
  // Sem `source`, cai no owner do marker.
  assert.equal(out[1].diagnostics[0].source, "csharp");
  assert.equal(out[0].diagnostics[1].source, undefined);
});

test("abas: só arquivos em disco, sem duplicatas, com a ativa marcada", () => {
  const tabs = filesToIdeTabs(
    [
      { path: "/w/a.ts", name: "a.ts", dirty: true },
      { path: "/w/a.ts", name: "a.ts", dirty: true },
      { path: "untitled:Untitled-1", name: "Untitled-1", dirty: true },
      { path: "fluentcoder://graph", name: "Grafo", dirty: false },
      { path: "C:\\w\\b.cs", name: "b.cs", dirty: false },
    ],
    "C:\\w\\b.cs",
    (p) => `file://${p}`,
    () => "plaintext"
  );
  assert.deepEqual(
    tabs.map((t) => [t.label, t.isActive, t.isDirty]),
    [
      ["a.ts", false, true],
      ["b.cs", true, false],
    ]
  );
});

test("isDiskPath distingue caminhos reais de abas sintéticas", () => {
  assert.equal(isDiskPath("/home/x.ts"), true);
  assert.equal(isDiskPath("C:/x.ts"), true);
  assert.equal(isDiskPath("untitled:Sem título"), false);
  assert.equal(isDiskPath("fluentcoder://graph"), false);
});

test("normalizeEol converte CRLF/CR para LF", () => {
  assert.equal(normalizeEol("a\r\nb\rc\n"), "a\nb\nc\n");
});

test("findTextRange localiza startText…endText em 1-based", () => {
  const content = "linha 1\nfunction foo() {\n  return 1;\n}\n";
  assert.deepEqual(findTextRange(content, "function foo", "}"), {
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 4,
    endColumn: 2,
  });
  assert.deepEqual(findTextRange(content, "return 1;"), {
    startLineNumber: 3,
    startColumn: 3,
    endLineNumber: 3,
    endColumn: 12,
  });
  assert.equal(findTextRange(content, "inexistente"), null);
  assert.equal(findTextRange(content), null);
});

test("resultados de diff seguem o protocolo do CLI", () => {
  assert.deepEqual(diffRejectedResult(), {
    content: [{ type: "text", text: "DIFF_REJECTED" }],
  });
  const ok = diffAcceptedResult("novo\n");
  assert.equal(ok.content[0].text, "FILE_SAVED");
  assert.equal(ok.content[1].text, "novo\n");
});

test("saveDocumentResult serializa sucesso e falha", () => {
  assert.deepEqual(JSON.parse(saveDocumentResult("/w/a.ts", true).content[0].text), {
    success: true,
    filePath: "/w/a.ts",
    saved: true,
    message: "Document saved successfully",
  });
  const fail = JSON.parse(saveDocumentResult("/w/a.ts", false, "disco cheio").content[0].text);
  assert.equal(fail.success, false);
  assert.equal(fail.message, "disco cheio");
});

test("parseOpenDiffArgs valida e normaliza os argumentos", () => {
  assert.deepEqual(
    parseOpenDiffArgs({
      old_file_path: "/w/a.ts",
      new_file_path: "/w/a.ts",
      new_file_contents: "x\r\ny",
      tab_name: "✻ [Claude Code] a.ts ⧉",
    }),
    {
      oldPath: "/w/a.ts",
      newPath: "/w/a.ts",
      newContents: "x\ny",
      tabName: "✻ [Claude Code] a.ts ⧉",
    }
  );
  assert.equal(parseOpenDiffArgs({ new_file_path: "/w/a.ts" }), null);
  assert.equal(parseOpenDiffArgs({ new_file_path: "/w/a.ts", new_file_contents: "" })?.tabName, "a.ts");
});
