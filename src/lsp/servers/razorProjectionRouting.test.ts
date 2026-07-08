import assert from "node:assert/strict";
import test from "node:test";
import {
  routeDiagnostics,
  pickWorkspaceSymbolForMetadata,
  routeDefinition,
  remapRangeToMonaco,
  lspRangeToMonaco,
  lspSeverityToMonaco,
  asLocationArray,
  monacoPosToGenerated,
  dirname,
  relativize,
  isAncestorDir,
  pickProjectForCshtml,
  isPhantomSelfAmbiguity,
  type LspDiagnostic,
  type RemapFn,
  type RemapRangesFn,
} from "./razorProjectionRouting.ts";
import { canonicalFileUriKey } from "../uri.ts";

/**
 * Fake `generated→source` remap mirroring the MEASURED `spike-b1d` shape:
 *   - CS1061 diagnostic range  .g.cs (160,6)-(160,25) → .cshtml (15,14)-(15,33)
 *   - hover @Model.City range   .g.cs ( 85,6)-( 85,10) → .cshtml ( 7,11)-( 7,15)
 * Everything else is synthetic scaffolding → null (must be dropped).
 */
const POS_TABLE: Record<string, { line: number; character: number }> = {
  "160,6": { line: 15, character: 14 },
  "160,25": { line: 15, character: 33 },
  "85,6": { line: 7, character: 11 },
  "85,10": { line: 7, character: 15 },
};

/** Batch (range) form of the fake — the shape routing consumes now (1 IPC/N ranges). */
const remapRanges: RemapRangesFn = async (ranges) =>
  ranges.map((r) => {
    const start = POS_TABLE[`${r.start.line},${r.start.character}`] ?? null;
    const end = POS_TABLE[`${r.end.line},${r.end.character}`] ?? null;
    return start && end ? { start, end } : null;
  });

const CS1061: LspDiagnostic = {
  range: { start: { line: 160, character: 6 }, end: { line: 160, character: 25 } },
  severity: 1,
  code: "CS1061",
  message: "'WeatherModel' does not contain a definition for 'NonExistentProperty'",
};

test("routeDiagnostics remaps a .g.cs range to a 1-based .cshtml marker", async () => {
  const [m, ...rest] = await routeDiagnostics([CS1061], remapRanges);
  assert.equal(rest.length, 0);
  // .cshtml 0-based (15,14)-(15,33) → Monaco 1-based (16,15)-(16,34)
  assert.deepEqual(
    { sl: m.startLineNumber, sc: m.startColumn, el: m.endLineNumber, ec: m.endColumn },
    { sl: 16, sc: 15, el: 16, ec: 34 }
  );
  assert.equal(m.severity, 8); // Error
  assert.equal(m.code, "CS1061");
  assert.equal(m.message, CS1061.message);
});

test("routeDiagnostics DROPS an unmappable (synthetic) diagnostic", async () => {
  const synthetic: LspDiagnostic = {
    range: { start: { line: 42, character: 0 }, end: { line: 42, character: 5 } },
    message: "scaffolding noise",
  };
  assert.deepEqual(await routeDiagnostics([synthetic], remapRanges), []);
});

test("routeDiagnostics keeps only the mappable ones in a mixed batch", async () => {
  const synthetic: LspDiagnostic = {
    range: { start: { line: 42, character: 0 }, end: { line: 42, character: 5 } },
    message: "noise",
  };
  const markers = await routeDiagnostics([synthetic, CS1061], remapRanges);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].code, "CS1061");
});

// --- phantom self-ambiguity (CS0229) from the duplicated Razor page class ---

const PHANTOM_CS0229: LspDiagnostic = {
  // remappable range so it would otherwise become a marker
  range: { start: { line: 160, character: 6 }, end: { line: 160, character: 25 } },
  severity: 1,
  code: "CS0229",
  message:
    "Ambiguity between 'Views_AlteracaoVencimento__Grid.Url' and 'Views_AlteracaoVencimento__Grid.Url'",
};

test("isPhantomSelfAmbiguity: true when CS0229 names the SAME symbol twice", () => {
  assert.equal(isPhantomSelfAmbiguity(PHANTOM_CS0229), true);
});

test("isPhantomSelfAmbiguity: false for a REAL ambiguity (two different symbols)", () => {
  const real: LspDiagnostic = {
    ...PHANTOM_CS0229,
    message: "Ambiguity between 'A.Foo' and 'B.Foo'",
  };
  assert.equal(isPhantomSelfAmbiguity(real), false);
});

test("isPhantomSelfAmbiguity: false for any non-CS0229 code", () => {
  assert.equal(isPhantomSelfAmbiguity({ ...PHANTOM_CS0229, code: "CS1061" }), false);
  assert.equal(isPhantomSelfAmbiguity(CS1061), false);
});

test("isPhantomSelfAmbiguity: locale-agnostic (pt-BR 'Ambiguidade entre … e …')", () => {
  // The surrounding words are localized; only the quoted symbols are stable.
  const ptBrSelf: LspDiagnostic = {
    ...PHANTOM_CS0229,
    message: "Ambiguidade entre 'Views_X.Url' e 'Views_X.Url'",
  };
  assert.equal(isPhantomSelfAmbiguity(ptBrSelf), true);
  const ptBrReal: LspDiagnostic = {
    ...PHANTOM_CS0229,
    message: "Ambiguidade entre 'A.Foo' e 'B.Foo'",
  };
  assert.equal(isPhantomSelfAmbiguity(ptBrReal), false);
});

test("isPhantomSelfAmbiguity: false when the message lacks exactly two quoted symbols", () => {
  assert.equal(isPhantomSelfAmbiguity({ ...PHANTOM_CS0229, message: "no quotes here" }), false);
  assert.equal(isPhantomSelfAmbiguity({ ...PHANTOM_CS0229, message: "only 'one' symbol" }), false);
});

test("routeDiagnostics DROPS the phantom self-ambiguity CS0229", async () => {
  assert.deepEqual(await routeDiagnostics([PHANTOM_CS0229], remapRanges), []);
});

test("routeDiagnostics keeps a REAL CS0229 (distinct symbols)", async () => {
  const real: LspDiagnostic = {
    ...PHANTOM_CS0229,
    message: "Ambiguity between 'A.Foo' and 'B.Foo'",
  };
  const markers = await routeDiagnostics([real], remapRanges);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].code, "CS0229");
});

test("routeDiagnostics filters VS-custom tags, keeps standard ones", async () => {
  const withTags: LspDiagnostic = { ...CS1061, tags: [1, 2147483642, 2] };
  const [m] = await routeDiagnostics([withTags], remapRanges);
  assert.deepEqual((m as unknown as { tags?: number[] }).tags, [1, 2]);
});

test("remapRangeToMonaco returns null if either endpoint is synthetic", async () => {
  const half = { start: { line: 160, character: 6 }, end: { line: 999, character: 0 } };
  assert.equal(await remapRangeToMonaco(half, remapRanges), null);
});

test("lspSeverityToMonaco maps the LSP severity table to Monaco", () => {
  assert.equal(lspSeverityToMonaco(1), 8); // Error
  assert.equal(lspSeverityToMonaco(2), 4); // Warning
  assert.equal(lspSeverityToMonaco(3), 2); // Info
  assert.equal(lspSeverityToMonaco(4), 1); // Hint
  assert.equal(lspSeverityToMonaco(undefined), 8); // default Error
});

test("lspRangeToMonaco converts 0-based → 1-based without remapping", () => {
  assert.deepEqual(lspRangeToMonaco({ start: { line: 5, character: 18 }, end: { line: 5, character: 22 } }), {
    startLineNumber: 6,
    startColumn: 19,
    endLineNumber: 6,
    endColumn: 23,
  });
});

const cshtmlUri = "file:///c:/proj/Views/Home/Index.cshtml";
const projectedUri = "file:///C:/shadow/projected/Views_Home_Index.g.cs";
const projectedUriKey = canonicalFileUriKey(projectedUri);

test("routeDefinition passes a real .cs target through (1-based, uri kept)", async () => {
  const target = {
    uri: "file:///c:/proj/Models/WeatherModel.cs",
    range: { start: { line: 5, character: 18 }, end: { line: 5, character: 22 } },
  };
  const out = await routeDefinition([target], {
    projectedUriKey,
    cshtmlUri,
    remapRanges,
    uriKey: canonicalFileUriKey,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].uri, target.uri);
  assert.deepEqual(out[0].range, { startLineNumber: 6, startColumn: 19, endLineNumber: 6, endColumn: 23 });
});

test("routeDefinition rewrites a projected-.g.cs target back to the .cshtml", async () => {
  const target = {
    uri: projectedUri, // same file, different drive case → canonical key still matches
    range: { start: { line: 85, character: 6 }, end: { line: 85, character: 10 } },
  };
  const out = await routeDefinition([target], {
    projectedUriKey,
    cshtmlUri,
    remapRanges,
    uriKey: canonicalFileUriKey,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].uri, cshtmlUri);
  assert.deepEqual(out[0].range, { startLineNumber: 8, startColumn: 12, endLineNumber: 8, endColumn: 16 });
});

test("routeDefinition drops an unmappable projected target and foreign .g.cs", async () => {
  const synthetic = {
    uri: projectedUri,
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
  };
  const foreign = {
    uri: "file:///c:/shadow/projected/Other.g.cs",
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
  };
  const out = await routeDefinition([synthetic, foreign], {
    projectedUriKey,
    cshtmlUri,
    remapRanges,
    uriKey: canonicalFileUriKey,
  });
  assert.deepEqual(out, []);
});

test("routeDefinition handles the LocationLink shape (targetUri/targetSelectionRange)", async () => {
  const link = {
    targetUri: "file:///c:/proj/Models/WeatherModel.cs",
    targetSelectionRange: { start: { line: 5, character: 18 }, end: { line: 5, character: 22 } },
  };
  const out = await routeDefinition(link, {
    projectedUriKey,
    cshtmlUri,
    remapRanges,
    uriKey: canonicalFileUriKey,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].uri, link.targetUri);
});

test("asLocationArray normalizes single / array / null", () => {
  assert.equal(asLocationArray(null).length, 0);
  assert.equal(asLocationArray({ uri: "x" }).length, 1);
  assert.equal(asLocationArray([{ uri: "a" }, { uri: "b" }]).length, 2);
});

test("monacoPosToGenerated converts 1-based Monaco → 0-based and forwards", async () => {
  const calls: Array<[number, number]> = [];
  const remap: RemapFn = async (line, character) => {
    calls.push([line, character]);
    return { line: 200, character: 4 };
  };
  const got = await monacoPosToGenerated(16, 15, remap);
  assert.deepEqual(calls, [[15, 14]]);
  assert.deepEqual(got, { line: 200, character: 4 });
});

test("dirname strips the last segment (Windows + POSIX)", () => {
  assert.equal(dirname("C:\\proj\\Views\\Index.cshtml"), "C:\\proj\\Views");
  assert.equal(dirname("/proj/Views/Index.cshtml"), "/proj/Views");
});

test("relativize yields the path under base, handling trailing separators", () => {
  assert.equal(relativize("C:\\proj", "C:\\proj\\Views\\Index.cshtml"), "Views\\Index.cshtml");
  assert.equal(relativize("C:\\proj\\", "C:\\proj\\Views\\Index.cshtml"), "Views\\Index.cshtml");
  assert.equal(relativize("/proj", "/proj/Views/Index.cshtml"), "Views/Index.cshtml");
});

test("isAncestorDir is case/separator-insensitive and rejects sibling-prefix traps", () => {
  assert.equal(isAncestorDir("C:\\proj", "c:/PROJ/Views/Index.cshtml"), true);
  assert.equal(isAncestorDir("/a/proj", "/a/proj/x.cshtml"), true);
  // "/a/proj" must NOT be considered an ancestor of "/a/project2/..."
  assert.equal(isAncestorDir("/a/proj", "/a/project2/x.cshtml"), false);
  assert.equal(isAncestorDir("/a/other", "/a/proj/x.cshtml"), false);
});

test("pickProjectForCshtml chooses the longest (most specific) containing project", () => {
  const csprojs = [
    "C:\\sln\\Outer.csproj",
    "C:\\sln\\Web\\Web.csproj",
    "C:\\sln\\Other\\Other.csproj",
  ];
  const got = pickProjectForCshtml(csprojs, "C:\\sln\\Web\\Views\\Home\\Index.cshtml");
  assert.deepEqual(got, { projectDir: "C:\\sln\\Web", csprojPath: "C:\\sln\\Web\\Web.csproj" });
});

test("pickProjectForCshtml returns null for a loose file and ignores non-csproj", () => {
  assert.equal(pickProjectForCshtml(["C:\\a\\A.csproj"], "C:\\b\\Index.cshtml"), null);
  assert.equal(pickProjectForCshtml(["C:\\a\\A.sln"], "C:\\a\\Index.cshtml"), null);
});

// --- routeWorkspaceEdit (code actions, Fase A2) ---

import { routeWorkspaceEdit, monacoSeverityToLsp } from "./razorProjectionRouting.ts";

test("routeWorkspaceEdit remaps projected edits strictly and passes real files through", async () => {
  const edit = {
    changes: {
      [projectedUri]: [
        { range: { start: { line: 160, character: 6 }, end: { line: 160, character: 25 } }, newText: "Fixed" },
      ],
      "file:///c:/proj/Models/WeatherModel.cs": [
        { range: { start: { line: 5, character: 18 }, end: { line: 5, character: 22 } }, newText: "City2" },
      ],
    },
  };
  const routed = await routeWorkspaceEdit(edit, {
    projectedUriKey,
    cshtmlUri,
    remapRangesStrict: remapRanges,
    uriKey: canonicalFileUriKey,
  });
  assert.ok(routed, "edit set must survive");
  assert.equal(routed.length, 2);
  const [proj, real] = routed;
  assert.equal(proj.uri, cshtmlUri, "projected edit lands on the .cshtml");
  assert.deepEqual(proj.range, { startLineNumber: 16, startColumn: 15, endLineNumber: 16, endColumn: 34 });
  assert.equal(proj.text, "Fixed");
  assert.equal(real.uri, "file:///c:/proj/Models/WeatherModel.cs");
  assert.deepEqual(real.range, { startLineNumber: 6, startColumn: 19, endLineNumber: 6, endColumn: 23 });
});

test("routeWorkspaceEdit drops the WHOLE action when a projected edit is synthetic", async () => {
  const edit = {
    changes: {
      [projectedUri]: [
        { range: { start: { line: 160, character: 6 }, end: { line: 160, character: 25 } }, newText: "ok" },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: "synthetic" },
      ],
    },
  };
  assert.equal(
    await routeWorkspaceEdit(edit, {
      projectedUriKey,
      cshtmlUri,
      remapRangesStrict: remapRanges,
      uriKey: canonicalFileUriKey,
    }),
    null,
    "partial application is never allowed"
  );
});

test("routeWorkspaceEdit rejects resource ops, foreign .g.cs and unknown shapes", async () => {
  const opts = { projectedUriKey, cshtmlUri, remapRangesStrict: remapRanges, uriKey: canonicalFileUriKey };
  assert.equal(await routeWorkspaceEdit({ documentChanges: [{ kind: "rename" }] }, opts), null);
  assert.equal(
    await routeWorkspaceEdit(
      { changes: { "file:///c:/shadow/projected/Other.g.cs": [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
      ] } },
      opts
    ),
    null
  );
  assert.equal(await routeWorkspaceEdit({ documentChanges: [{ edits: [] }] }, opts), null, "no textDocument.uri");
});

test("routeWorkspaceEdit handles documentChanges (TextDocumentEdit shape)", async () => {
  const edit = {
    documentChanges: [
      {
        textDocument: { uri: projectedUri, version: 3 },
        edits: [{ range: { start: { line: 85, character: 6 }, end: { line: 85, character: 10 } }, newText: "Town" }],
      },
    ],
  };
  const routed = await routeWorkspaceEdit(edit, {
    projectedUriKey,
    cshtmlUri,
    remapRangesStrict: remapRanges,
    uriKey: canonicalFileUriKey,
  });
  assert.ok(routed);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].uri, cshtmlUri);
  assert.equal(routed[0].text, "Town");
});

test("monacoSeverityToLsp inverts the severity table", () => {
  assert.equal(monacoSeverityToLsp(8), 1);
  assert.equal(monacoSeverityToLsp(4), 2);
  assert.equal(monacoSeverityToLsp(2), 3);
  assert.equal(monacoSeverityToLsp(1), 4);
});

// ── pickWorkspaceSymbolForMetadata (metadata → fonte real) ───────────────────

const wsLoc = (uri: string) => ({
  uri,
  range: { start: { line: 3, character: 10 }, end: { line: 3, character: 20 } },
});

test("workspace/symbol: membro escolhe o hit cujo container é o tipo do decompilado", () => {
  const picked = pickWorkspaceSymbolForMetadata(
    [
      { name: "Cpf", containerName: "Pessoa", location: wsLoc("file:///c:/r/Pessoa.cs") },
      { name: "Cpf", containerName: "ConsultaSerasaCrednet", location: wsLoc("file:///c:/r/Consulta.cs") },
    ],
    { word: "Cpf", containerHint: "ConsultaSerasaCrednet" }
  );
  assert.equal(picked?.location?.uri, "file:///c:/r/Consulta.cs");
});

test("workspace/symbol: tipo clicado usa namespace do decompilado para desambiguar", () => {
  const picked = pickWorkspaceSymbolForMetadata(
    [
      { name: "PathFactory", kind: 5, containerName: "Outro.Ns", location: wsLoc("file:///c:/r/a/PathFactory.cs") },
      { name: "PathFactory", kind: 5, containerName: "Ativus.Core.Factories", location: wsLoc("file:///c:/r/b/PathFactory.cs") },
    ],
    { word: "PathFactory", containerHint: "PathFactory", namespaceHint: "Ativus.Core.Factories" }
  );
  assert.equal(picked?.location?.uri, "file:///c:/r/b/PathFactory.cs");
});

test("workspace/symbol: métodos Roslyn com sufixo de assinatura contam como match", () => {
  const picked = pickWorkspaceSymbolForMetadata(
    [{ name: "ComponentPath(ComponentsEnum)", containerName: "PathFactory", location: wsLoc("file:///c:/r/PathFactory.cs") }],
    { word: "ComponentPath", containerHint: "PathFactory" }
  );
  assert.equal(picked?.location?.uri, "file:///c:/r/PathFactory.cs");
});

test("workspace/symbol: ambíguo sem evidência devolve null (mantém metadata)", () => {
  const picked = pickWorkspaceSymbolForMetadata(
    [
      { name: "Nome", containerName: "Cliente", location: wsLoc("file:///c:/r/Cliente.cs") },
      { name: "Nome", containerName: "Fornecedor", location: wsLoc("file:///c:/r/Fornecedor.cs") },
    ],
    { word: "Nome", containerHint: "ConsultaSerasaCrednet" }
  );
  assert.equal(picked, null);
});

test("workspace/symbol: hit único sem evidência ainda vale (inequívoco)", () => {
  const picked = pickWorkspaceSymbolForMetadata(
    [{ name: "DocumentoConsultaScr", containerName: "Ativus.Shared.Core.ValueObjects", location: wsLoc("file:///c:/r/Doc.cs") }],
    { word: "DocumentoConsultaScr", containerHint: "DocumentoConsultaScr" }
  );
  assert.equal(picked?.location?.uri, "file:///c:/r/Doc.cs");
});

test("workspace/symbol: descarta hits em .g.cs e MetadataAsSource", () => {
  const picked = pickWorkspaceSymbolForMetadata(
    [
      { name: "Cpf", containerName: "ConsultaSerasaCrednet", location: wsLoc("file:///c:/r/x.g.cs") },
      { name: "Cpf", containerName: "ConsultaSerasaCrednet", location: wsLoc("file:///c:/t/MetadataAsSource/y/Consulta.cs") },
    ],
    { word: "Cpf", containerHint: "ConsultaSerasaCrednet" }
  );
  assert.equal(picked, null);
});
