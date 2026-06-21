import assert from "node:assert/strict";
import test from "node:test";
import {
  CSHARP_CONFIGURATION,
  resolveConfigurationSections,
} from "./csharpConfiguration.ts";

test("answers the compiler-diagnostics scope that gates open-file errors", () => {
  // This is the section whose missing answer left semantic errors unreported.
  const [value] = resolveConfigurationSections({
    items: [
      { section: "csharp|background_analysis.dotnet_compiler_diagnostics_scope" },
    ],
  });
  assert.equal(value, "openFiles");
});

test("returns one value per item, in request order", () => {
  const values = resolveConfigurationSections({
    items: [
      { section: "csharp|background_analysis.dotnet_analyzer_diagnostics_scope" },
      { section: "csharp|symbol_search.dotnet_search_reference_assemblies" },
    ],
  });
  assert.deepEqual(values, ["openFiles", true]);
});

test("resolves an unknown section to null so Roslyn keeps its default", () => {
  const [value] = resolveConfigurationSections({
    items: [{ section: "csharp|made_up.dotnet_not_a_real_option" }],
  });
  assert.equal(value, null);
});

test("a missing section resolves to null without throwing", () => {
  const values = resolveConfigurationSections({ items: [{}] });
  assert.deepEqual(values, [null]);
});

test("empty items yields an empty array (length always matches)", () => {
  assert.deepEqual(resolveConfigurationSections({ items: [] }), []);
});

test("both diagnostics scopes are configured to openFiles", () => {
  assert.equal(
    CSHARP_CONFIGURATION[
      "csharp|background_analysis.dotnet_compiler_diagnostics_scope"
    ],
    "openFiles"
  );
  assert.equal(
    CSHARP_CONFIGURATION[
      "csharp|background_analysis.dotnet_analyzer_diagnostics_scope"
    ],
    "openFiles"
  );
});
