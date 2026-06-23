//! Projection generation for the broker (ADR 0002), brick 4.
//!
//! Produces the Razor-projected C# (`.g.cs`) for a `.cshtml` using the REAL
//! Razor source generator, so the projection matches the compiler exactly
//! (base class, TagHelpers, `_ViewImports` merge, enhanced `#line` maps).
//!
//! ## Strategy
//! **V1 (here): on-save via the SDK.** Run
//! `dotnet build <user.csproj> -p:EmitCompilerGeneratedFiles=true`, which makes
//! Roslyn write each generator's output under
//! `obj/<Config>/<Tfm>/generated/...`. We then read the file for the target
//! `.cshtml`. Correct and zero new .NET code, but build-latency (~seconds) →
//! suitable for regenerate-on-save, not per-keystroke.
//!
//! **Future (fast path):** a small in-process .NET sidecar hosting the Razor
//! source generator incrementally, returning the `.g.cs` text directly. The rest
//! of the broker (source map, shadow, remap) is agnostic to which path produced
//! the text.
//!
//! This module owns the **deterministic location** of the emitted file (pure,
//! unit-tested) and the **build command** construction; executing it is wired in
//! brick 5 via the app's process layer.
//!
//! ## V1 limitations (handled in brick 5, the execution layer)
//! - `generated_path_for` assumes the **default** `obj` layout. Custom
//!   `BaseIntermediateOutputPath`/`IntermediateOutputPath`, or an existing custom
//!   `CompilerGeneratedFilesOutputPath`, are not detected. Brick 5 will instead
//!   pass `-p:CompilerGeneratedFilesOutputPath=<broker-temp>` so the broker
//!   controls the output root rather than guessing `obj`.
//! - **Multi-targeting:** the caller must choose the active TFM (`GenContext.tfm`)
//!   and pass `-f <tfm>`; reading an arbitrary `generated/<tfm>` is wrong.
//! - Build returns non-zero when the user's C# has errors, but the generator
//!   still emits — brick 5 must read the projection anyway and only report a
//!   degraded status if the file is genuinely missing.

use std::path::{Path, PathBuf};

/// The Razor source generator's output sub-path under `obj/<Config>/<Tfm>/generated`.
/// Matches what the SDK emits (observed: `Microsoft.CodeAnalysis.Razor.Compiler`
/// assembly, `...RazorSourceGenerators.RazorSourceGenerator` type).
const GENERATOR_DIR: &str =
    "Microsoft.CodeAnalysis.Razor.Compiler/Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator";

/// Build configuration / TFM for locating generator output.
pub struct GenContext<'a> {
    pub config: &'a str, // e.g. "Debug"
    pub tfm: &'a str,    // e.g. "net8.0"
}

/// The generated C# filename for a `.cshtml` file name: the Razor SDK replaces
/// `.` with `_` and appends `.g.cs` (e.g. `Index.cshtml` -> `Index_cshtml.g.cs`,
/// `_ViewImports.cshtml` -> `_ViewImports_cshtml.g.cs`).
fn generated_file_name(cshtml_file_name: &str) -> String {
    format!("{}.g.cs", cshtml_file_name.replace('.', "_"))
}

/// Deterministic path of the emitted `.g.cs` for `cshtml_rel` (a path relative to
/// the project directory, e.g. `Views/Home/Index.cshtml`). Pure: no IO.
pub fn generated_path_for(
    project_dir: &Path,
    cshtml_rel: &Path,
    ctx: &GenContext,
) -> PathBuf {
    let mut p = project_dir.join("obj");
    p.push(ctx.config);
    p.push(ctx.tfm);
    p.push("generated");
    // GENERATOR_DIR contains a '/', push each segment so it's OS-correct.
    for seg in GENERATOR_DIR.split('/') {
        p.push(seg);
    }
    if let Some(parent) = cshtml_rel.parent() {
        // skip an empty parent (root-level .cshtml) so no stray separator is added
        if !parent.as_os_str().is_empty() {
            p.push(parent);
        }
    }
    let file = cshtml_rel
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    p.push(generated_file_name(&file));
    p
}

/// Build the `dotnet` command (program + args) that emits generator output for
/// `project_path`. Returns `("dotnet", [..])`. Executing it is brick 5.
pub fn emit_command(project_path: &Path) -> (String, Vec<String>) {
    (
        "dotnet".to_string(),
        vec![
            "build".to_string(),
            project_path.to_string_lossy().to_string(),
            "-p:EmitCompilerGeneratedFiles=true".to_string(),
            // keep it quiet + don't fail the broker on the user's own C# errors:
            // the generator still emits its output even when the compile fails.
            "-v:quiet".to_string(),
            "-nologo".to_string(),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> GenContext<'static> {
        GenContext { config: "Debug", tfm: "net8.0" }
    }

    #[test]
    fn generated_file_name_replaces_dot() {
        assert_eq!(generated_file_name("Index.cshtml"), "Index_cshtml.g.cs");
        assert_eq!(generated_file_name("_ViewImports.cshtml"), "_ViewImports_cshtml.g.cs");
    }

    #[test]
    fn generated_path_matches_sdk_layout() {
        // Mirrors the real emitted path captured from the SDK build of SampleMvc.
        let p = generated_path_for(
            Path::new("C:/proj/App"),
            Path::new("Views/Home/Index.cshtml"),
            &ctx(),
        );
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(
            s.ends_with(
                "App/obj/Debug/net8.0/generated/Microsoft.CodeAnalysis.Razor.Compiler/Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator/Views/Home/Index_cshtml.g.cs"
            ),
            "got: {s}"
        );
    }

    #[test]
    fn generated_path_for_root_level_cshtml() {
        let p = generated_path_for(Path::new("/app"), Path::new("Foo.cshtml"), &ctx());
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(
            s.ends_with("SourceGenerators.RazorSourceGenerator/Foo_cshtml.g.cs"),
            "got: {s}"
        );
        // no stray empty dir segment for a root-level file
        assert!(!s.contains(".RazorSourceGenerator//"), "got: {s}");
    }

    #[test]
    fn emit_command_requests_generated_files() {
        let (prog, args) = emit_command(Path::new("C:/proj/App/App.csproj"));
        assert_eq!(prog, "dotnet");
        assert_eq!(args[0], "build");
        assert!(args.iter().any(|a| a == "-p:EmitCompilerGeneratedFiles=true"));
        assert!(args.iter().any(|a| a.contains("App.csproj")));
    }
}
