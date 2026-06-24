# Sidecar spike — Etapa 1 findings (live Razor projection)

Goal: prove the Razor source generator can re-emit the `.g.cs` from in-memory
`.cshtml` text fast enough for per-keystroke live validation (today's `dotnet
build` path is ~1s — measured 931-1010ms warm, too slow).

## Result: GO

Running `Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator` (from
`sdk/8.0.421/Sdks/Microsoft.NET.Sdk.Razor/source-generators/Microsoft.CodeAnalysis.Razor.Compiler.dll`)
via `CSharpGeneratorDriver` over the SampleMvc fixture:

- **COLD run: ~789 ms** (once per project — JIT + first TagHelper scan).
- **WARM runs (one .cshtml edited, driver reused via `ReplaceAdditionalText`):
  [25, 3, 4, 3, 3] ms → median 3 ms.** Per-keystroke is trivial.
- **Fidelity vs `dotnet build` golden:** `#line (l,c)-(l,c)` maps present and
  structurally identical; `RazorPage<TModel>` base class correct; `Model.City`/
  `TemperatureC`/`Kind` member accesses present; TagHelpers (`Head/Body/Anchor`)
  discovered from the Compilation references. Only diffs: `#pragma checksum`
  (PDB metadata the broker's sourcemap ignores) and the
  `RazorCompiledItemMetadataAttribute`/checksum-attr lines (cosmetic; gated by
  the `GenerateRazorMetadataSourceChecksumAttributes` global we omitted).

## Contract that makes it work (editorconfig ground-truth)

Globals: `RootNamespace`, `RazorLangVersion=8.0`, `UsingMicrosoftNETSdkWeb=true`,
`TargetFramework`/`TargetFrameworkIdentifier`/`TargetFrameworkVersion`, `ProjectDir`.
Per-file: `build_metadata.AdditionalFiles.TargetPath` = project-relative path with
`\`, **base64**. The 3 `.cshtml` (`Index`, `_ViewImports`, `_ViewStart`) fed as
`AdditionalText`. References: the `Microsoft.AspNetCore.App.Ref` + `NETCore.App.Ref`
ref packs (TagHelper discovery is free given these).

## Version pin (the gotcha)

The 8.0.421 Razor.Compiler.dll references **Microsoft.CodeAnalysis 4.9.0.0**;
pin the host Roslyn to **4.9.x** (we used 4.9.2) or the generator's types fail to
load (`ReflectionTypeLoadException`, 112 loader errors with 4.8). Do NOT host this
in the app's existing Roslyn LSP (5.0.0-1.252... — different band).
