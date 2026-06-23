import assert from "node:assert/strict";
import test from "node:test";
import {
  routeDiagnostics,
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
  type LspDiagnostic,
  type RemapFn,
} from "./razorProjectionRouting.ts";
import { canonicalFileUriKey } from "../uri.ts";

/**
 * Fake `generated→source` remap mirroring the MEASURED `spike-b1d` shape:
 *   - CS1061 diagnostic range  .g.cs (160,6)-(160,25) → .cshtml (15,14)-(15,33)
 *   - hover @Model.City range   .g.cs ( 85,6)-( 85,10) → .cshtml ( 7,11)-( 7,15)
 * Everything else is synthetic scaffolding → null (must be dropped).
 */
const remapToSource: RemapFn = async (line, character) => {
  const table: Record<string, { line: number; character: number }> = {
    "160,6": { line: 15, character: 14 },
    "160,25": { line: 15, character: 33 },
    "85,6": { line: 7, character: 11 },
    "85,10": { line: 7, character: 15 },
  };
  return table[`${line},${character}`] ?? null;
};

const CS1061: LspDiagnostic = {
  range: { start: { line: 160, character: 6 }, end: { line: 160, character: 25 } },
  severity: 1,
  code: "CS1061",
  message: "'WeatherModel' does not contain a definition for 'NonExistentProperty'",
};

test("routeDiagnostics remaps a .g.cs range to a 1-based .cshtml marker", async () => {
  const [m, ...rest] = await routeDiagnostics([CS1061], remapToSource);
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
  assert.deepEqual(await routeDiagnostics([synthetic], remapToSource), []);
});

test("routeDiagnostics keeps only the mappable ones in a mixed batch", async () => {
  const synthetic: LspDiagnostic = {
    range: { start: { line: 42, character: 0 }, end: { line: 42, character: 5 } },
    message: "noise",
  };
  const markers = await routeDiagnostics([synthetic, CS1061], remapToSource);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].code, "CS1061");
});

test("routeDiagnostics filters VS-custom tags, keeps standard ones", async () => {
  const withTags: LspDiagnostic = { ...CS1061, tags: [1, 2147483642, 2] };
  const [m] = await routeDiagnostics([withTags], remapToSource);
  assert.deepEqual((m as unknown as { tags?: number[] }).tags, [1, 2]);
});

test("remapRangeToMonaco returns null if either endpoint is synthetic", async () => {
  const half = { start: { line: 160, character: 6 }, end: { line: 999, character: 0 } };
  assert.equal(await remapRangeToMonaco(half, remapToSource), null);
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
    remapToSource,
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
    remapToSource,
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
    remapToSource,
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
    remapToSource,
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
