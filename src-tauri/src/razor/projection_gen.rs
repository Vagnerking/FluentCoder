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
//! ## Robustness
//! - The broker PINS the generator output root via
//!   `-p:CompilerGeneratedFilesOutputPath=<dir>` ([`emit_command_with_output`]) and
//!   reads the projection from that same dir ([`generated_path_for_output`]). This
//!   makes the broker independent of a project's custom
//!   `BaseIntermediateOutputPath`/`IntermediateOutputPath`/default `obj` layout,
//!   which would otherwise misplace the `.g.cs` and mark the projection missing.
//!   The legacy `obj`-layout helpers remain for callers that don't pin the path.
//! - **Multi-targeting:** the caller must choose the active TFM (`GenContext.tfm`)
//!   and pass `-f <tfm>`; reading an arbitrary `generated/<tfm>` is wrong.
//! - Build returns non-zero when the user's C# has errors, but the generator
//!   still emits — the execution layer reads the projection anyway and only reports
//!   a degraded status if the file is genuinely missing.

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
pub fn generated_file_name(cshtml_file_name: &str) -> String {
    format!("{}.g.cs", cshtml_file_name.replace('.', "_"))
}

/// Append `<GENERATOR_DIR>/<rel-dir>/<file>.g.cs` for `cshtml_rel` onto `base`.
/// Shared by the obj-layout and pinned-output helpers.
fn push_generator_relative(mut p: PathBuf, cshtml_rel: &Path) -> PathBuf {
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

/// Deterministic path of the emitted `.g.cs` for `cshtml_rel` under the DEFAULT
/// `obj/<Config>/<Tfm>/generated` layout. Pure: no IO. Use
/// [`generated_path_for_output`] when the broker pins
/// `CompilerGeneratedFilesOutputPath` (the robust path).
pub fn generated_path_for(project_dir: &Path, cshtml_rel: &Path, ctx: &GenContext) -> PathBuf {
    let mut p = project_dir.join("obj");
    p.push(ctx.config);
    p.push(ctx.tfm);
    p.push("generated");
    push_generator_relative(p, cshtml_rel)
}

/// Deterministic path of the emitted `.g.cs` for `cshtml_rel` when the broker
/// pinned the generator output root to `output_root` (via
/// `-p:CompilerGeneratedFilesOutputPath=<output_root>`, see
/// [`emit_command_with_output`]). The SDK writes
/// `<output_root>/<GENERATOR_DIR>/<rel>` — no `obj/<config>/<tfm>` prefix — so this
/// is independent of the project's intermediate-output customizations. Pure: no IO.
pub fn generated_path_for_output(output_root: &Path, cshtml_rel: &Path) -> PathBuf {
    push_generator_relative(output_root.to_path_buf(), cshtml_rel)
}

/// Build the `dotnet` command (program + args) that emits generator output for
/// `project_path` in `config`. Returns `("dotnet", [..])`. `-c <config>` must
/// match the `config` used by [`generated_path_for`] or the emitted files land in
/// a different `obj/<config>` tree. Executing it (with cwd = project dir, for
/// `global.json` SDK selection) is brick 5.
pub fn emit_command(project_path: &Path, config: &str) -> (String, Vec<String>) {
    emit_command_inner(project_path, config, None, None)
}

/// [`emit_command`] that PINS the generator output root to `output_root` via
/// `-p:CompilerGeneratedFilesOutputPath=<output_root>`, and the active TFM via
/// `-f <tfm>` (a multi-target project would otherwise build EVERY TFM, with the
/// last one clobbering the pinned output). Pair with
/// [`generated_path_for_output`] to read the `.g.cs` from the same place. This is
/// the robust path: it makes the broker independent of the project's
/// `obj`/intermediate-output layout.
pub fn emit_command_with_output(
    project_path: &Path,
    config: &str,
    output_root: &Path,
    tfm: Option<&str>,
) -> (String, Vec<String>) {
    emit_command_inner(project_path, config, Some(output_root), tfm)
}

fn emit_command_inner(
    project_path: &Path,
    config: &str,
    output_root: Option<&Path>,
    tfm: Option<&str>,
) -> (String, Vec<String>) {
    let mut args = vec![
        "build".to_string(),
        project_path.to_string_lossy().to_string(),
        "-c".to_string(),
        config.to_string(),
        "-p:EmitCompilerGeneratedFiles=true".to_string(),
    ];
    if let Some(tfm) = tfm {
        args.push("-f".to_string());
        args.push(tfm.to_string());
    }
    if let Some(root) = output_root {
        // Absolute path so the emit lands in the broker-controlled dir regardless of
        // the project's BaseIntermediateOutputPath/IntermediateOutputPath.
        args.push(format!(
            "-p:CompilerGeneratedFilesOutputPath={}",
            root.to_string_lossy()
        ));
    }
    args.extend([
        // Only the user project itself: without this, MSBuild builds every
        // ProjectReference transitively — O(solution) work (minutes in a
        // monorepo) to emit ONE generator output. Reference DLLs may then be
        // stale/missing; the compile can error, but the generator still emits,
        // which is all this command is for.
        "-p:BuildProjectReferences=false".to_string(),
        // Skip the per-build restore check (~0.4s). If assets are stale/removed
        // mid-session this emit degrades — tolerated, since the broker treats a
        // non-zero emit as a missing projection, not a crash.
        "--no-restore".to_string(),
        // keep it quiet + don't fail the broker on the user's own C# errors:
        // the generator still emits its output even when the compile fails.
        "-v:quiet".to_string(),
        "-nologo".to_string(),
    ]);
    ("dotnet".to_string(), args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> GenContext<'static> {
        GenContext {
            config: "Debug",
            tfm: "net8.0",
        }
    }

    #[test]
    fn generated_file_name_replaces_dot() {
        assert_eq!(generated_file_name("Index.cshtml"), "Index_cshtml.g.cs");
        assert_eq!(
            generated_file_name("_ViewImports.cshtml"),
            "_ViewImports_cshtml.g.cs"
        );
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
        let (prog, args) = emit_command(Path::new("C:/proj/App/App.csproj"), "Release");
        assert_eq!(prog, "dotnet");
        assert_eq!(args[0], "build");
        assert!(args
            .iter()
            .any(|a| a == "-p:EmitCompilerGeneratedFiles=true"));
        assert!(args.iter().any(|a| a.contains("App.csproj")));
        // config must be passed so the emitted obj/<config> tree matches generated_path_for
        let ci = args.iter().position(|a| a == "-c").expect("-c present");
        assert_eq!(args[ci + 1], "Release");
        // The plain command does NOT pin the output path.
        assert!(!args
            .iter()
            .any(|a| a.starts_with("-p:CompilerGeneratedFilesOutputPath=")));
    }

    #[test]
    fn emit_command_with_output_pins_path_and_reader_matches() {
        let out = Path::new("C:/shadow/gen");
        let (_, args) = emit_command_with_output(
            Path::new("C:/proj/App/App.csproj"),
            "Debug",
            out,
            Some("net8.0"),
        );
        assert!(args
            .iter()
            .any(|a| a == "-p:CompilerGeneratedFilesOutputPath=C:/shadow/gen"
                || a == "-p:CompilerGeneratedFilesOutputPath=C:\\shadow\\gen"));
        // Scoped to ONE project and ONE TFM — never the whole graph.
        assert!(args.iter().any(|a| a == "-p:BuildProjectReferences=false"));
        let fi = args.iter().position(|a| a == "-f").expect("-f present");
        assert_eq!(args[fi + 1], "net8.0");
        // The reader derives the same place under the pinned root (no obj/<cfg>/<tfm>).
        let read = generated_path_for_output(out, Path::new("Views/Home/Index.cshtml"));
        let s = read.to_string_lossy().replace('\\', "/");
        assert!(
            s.ends_with("shadow/gen/Microsoft.CodeAnalysis.Razor.Compiler/Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator/Views/Home/Index_cshtml.g.cs"),
            "got: {s}"
        );
        assert!(
            !s.contains("/obj/"),
            "pinned output must not use the obj layout: {s}"
        );
    }
}
