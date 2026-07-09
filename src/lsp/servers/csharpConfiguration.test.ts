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

test("inlay-hint sections are NOT baked into the static table (they follow the toggle)", () => {
  // They must be resolved dynamically, not stored as constants — otherwise the
  // toggle could never turn them on live.
  const inlayKeys = Object.keys(CSHARP_CONFIGURATION).filter((k) =>
    k.startsWith("csharp|inlay_hints.")
  );
  assert.deepEqual(inlayKeys, []);
});

test("inlay-hint sections resolve to a boolean (default off), never null", () => {
  // Default (no localStorage in node) is OFF — but the section is KNOWN, so it
  // must answer `false`, not `null`. A `null` here would let Roslyn keep an
  // undefined default and desync from the toggle.
  const [enableTypes, suppressMatch] = resolveConfigurationSections({
    items: [
      { section: "csharp|inlay_hints.csharp_enable_inlay_hints_for_types" },
      {
        section:
          "csharp|inlay_hints.dotnet_suppress_inlay_hints_for_parameters_that_match_argument_name",
      },
    ],
  });
  assert.equal(enableTypes, false); // enable-section: off by default
  assert.equal(suppressMatch, true); // suppression: always on
});
