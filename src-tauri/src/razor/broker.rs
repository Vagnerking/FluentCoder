//! Projection broker — composition layer (ADR 0002, brick 5).
//!
//! Ties the pure modules together into a **plan** for serving one user project's
//! `.cshtml` files via projection:
//!   - [`derive`](super::derive) gives the TFM + framework references;
//!   - [`shadow`](super::shadow) renders the shadow `.csproj`;
//!   - [`projection_gen`](super::projection_gen) locates the projected `.g.cs`
//!     and the build command that emits it.
//!
//! `plan()` is pure (no IO): it computes paths, the shadow project content, and
//! the commands to run. The execution layer (running `dotnet`, copying the
//! `.g.cs` into the shadow, launching Roslyn over the shadow solution, parsing
//! `#line` into a [`RazorSourceMap`](super::sourcemap::RazorSourceMap), and
//! forwarding/​remapping LSP) consumes this plan. Validated end-to-end manually by
//! `tools/razor-lsp-probe/spike-b1c.mjs`.

use std::path::{Path, PathBuf};

use super::derive::DerivedRefs;
use super::projection_gen::{emit_command, generated_file_name, generated_path_for, GenContext};
use super::shadow::{render_shadow_csproj, ShadowSpec};

/// Inputs for planning the broker for one user project.
pub struct BrokerInputs<'a> {
    /// Where the broker may create its shadow project (e.g. the workspace root).
    pub workspace_dir: &'a Path,
    /// Directory containing the user `.csproj`.
    pub user_project_dir: &'a Path,
    /// Full path to the user `.csproj`.
    pub user_csproj_path: &'a Path,
    /// TFM + framework refs derived from the user project.
    pub derived: &'a DerivedRefs,
    /// Build configuration (usually "Debug").
    pub config: &'a str,
    /// Optional root namespace to match the user project.
    pub root_namespace: Option<&'a str>,
    /// `.cshtml` paths relative to `user_project_dir` (e.g. `Views/Home/Index.cshtml`).
    pub cshtml_rels: &'a [PathBuf],
}

/// One projected file: where the SDK emits it and where it lives in the shadow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionFile {
    pub cshtml_rel: PathBuf,
    /// Where the SDK build emits the `.g.cs` (default obj layout).
    pub emitted_gcs: PathBuf,
    /// Where the broker places it inside the shadow project (auto-compiled).
    pub shadow_gcs: PathBuf,
}

/// The static plan the execution layer runs.
#[derive(Debug, Clone)]
pub struct BrokerPlan {
    pub shadow_dir: PathBuf,
    pub shadow_csproj_path: PathBuf,
    pub shadow_csproj_content: String,
    /// The user `.csproj` (the shadow references it; the solution opens both).
    pub user_csproj_path: PathBuf,
    /// Solution that ties user + shadow projects into one Roslyn workspace.
    pub solution_path: PathBuf,
    /// `dotnet build` command that emits the projections.
    pub emit_command: (String, Vec<String>),
    /// cwd to run `emit_command` in (the user project dir) — required so `dotnet`
    /// resolves the right SDK via any `global.json`.
    pub emit_cwd: PathBuf,
    pub projections: Vec<ProjectionFile>,
}

/// Compute the broker plan. Pure — no filesystem or process IO.
pub fn plan(inputs: &BrokerInputs) -> BrokerPlan {
    let shadow_dir = inputs.workspace_dir.join(".fluent-razor").join("shadow");
    let shadow_csproj_path = shadow_dir.join("ShadowRazor.csproj");

    // MSBuild accepts an absolute ProjectReference path — avoids brittle relative
    // path math from the shadow dir to an arbitrary user project location.
    let user_csproj = inputs.user_csproj_path.to_string_lossy().to_string();
    let fw_refs: Vec<&str> = inputs
        .derived
        .framework_references
        .iter()
        .map(String::as_str)
        .collect();
    let spec = ShadowSpec {
        target_framework: &inputs.derived.tfm,
        user_csproj_rel: &user_csproj,
        framework_references: &fw_refs,
        root_namespace: inputs.root_namespace,
    };
    let shadow_csproj_content = render_shadow_csproj(&spec);

    let ctx = GenContext {
        config: inputs.config,
        tfm: &inputs.derived.tfm,
    };
    let projected_root = shadow_dir.join("projected");
    let projections = inputs
        .cshtml_rels
        .iter()
        .map(|rel| {
            let emitted_gcs = generated_path_for(inputs.user_project_dir, rel, &ctx);
            let file = rel
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut shadow_gcs = projected_root.clone();
            if let Some(parent) = rel.parent() {
                if !parent.as_os_str().is_empty() {
                    shadow_gcs.push(parent);
                }
            }
            shadow_gcs.push(generated_file_name(&file));
            ProjectionFile {
                cshtml_rel: rel.clone(),
                emitted_gcs,
                shadow_gcs,
            }
        })
        .collect();

    let solution_path = shadow_dir.join("RazorShadow.sln");
    BrokerPlan {
        shadow_dir,
        shadow_csproj_path,
        shadow_csproj_content,
        user_csproj_path: inputs.user_csproj_path.to_path_buf(),
        solution_path,
        emit_command: emit_command(inputs.user_csproj_path, inputs.config),
        emit_cwd: inputs.user_project_dir.to_path_buf(),
        projections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn derived() -> DerivedRefs {
        DerivedRefs {
            tfm: "net8.0".to_string(),
            framework_references: vec!["Microsoft.AspNetCore.App".to_string()],
        }
    }

    fn plan_for() -> BrokerPlan {
        let rels = vec![PathBuf::from("Views/Home/Index.cshtml")];
        let d = derived();
        plan(&BrokerInputs {
            workspace_dir: Path::new("C:/ws"),
            user_project_dir: Path::new("C:/ws/App"),
            user_csproj_path: Path::new("C:/ws/App/App.csproj"),
            derived: &d,
            config: "Debug",
            root_namespace: Some("App"),
            cshtml_rels: &rels,
        })
    }

    #[test]
    fn shadow_csproj_references_user_and_framework() {
        let p = plan_for();
        assert!(p.shadow_csproj_content.contains("Sdk=\"Microsoft.NET.Sdk\""));
        assert!(p
            .shadow_csproj_content
            .contains("<ProjectReference Include=\"C:/ws/App/App.csproj\" />"));
        assert!(p
            .shadow_csproj_content
            .contains("<FrameworkReference Include=\"Microsoft.AspNetCore.App\" />"));
        assert!(p.shadow_csproj_content.contains("<TargetFramework>net8.0</TargetFramework>"));
    }

    #[test]
    fn shadow_dir_and_csproj_paths() {
        let p = plan_for();
        let dir = p.shadow_dir.to_string_lossy().replace('\\', "/");
        assert!(dir.ends_with("ws/.fluent-razor/shadow"), "got {dir}");
        let cs = p.shadow_csproj_path.to_string_lossy().replace('\\', "/");
        assert!(cs.ends_with("shadow/ShadowRazor.csproj"), "got {cs}");
    }

    #[test]
    fn projection_paths_emitted_and_shadow() {
        let p = plan_for();
        assert_eq!(p.projections.len(), 1);
        let pf = &p.projections[0];
        let emitted = pf.emitted_gcs.to_string_lossy().replace('\\', "/");
        assert!(
            emitted.ends_with(
                "App/obj/Debug/net8.0/generated/Microsoft.CodeAnalysis.Razor.Compiler/Microsoft.NET.Sdk.Razor.SourceGenerators.RazorSourceGenerator/Views/Home/Index_cshtml.g.cs"
            ),
            "got {emitted}"
        );
        let shadow = pf.shadow_gcs.to_string_lossy().replace('\\', "/");
        assert!(
            shadow.ends_with("shadow/projected/Views/Home/Index_cshtml.g.cs"),
            "got {shadow}"
        );
    }

    #[test]
    fn emit_command_targets_user_csproj_with_config_and_cwd() {
        let p = plan_for();
        let (prog, args) = &p.emit_command;
        assert_eq!(prog, "dotnet");
        assert!(args.iter().any(|a| a.contains("App.csproj")));
        assert!(args.iter().any(|a| a == "-p:EmitCompilerGeneratedFiles=true"));
        // config propagated so the build emits into the obj/<config> tree we read
        let ci = args.iter().position(|a| a == "-c").expect("-c present");
        assert_eq!(args[ci + 1], "Debug");
        // cwd is the user project dir (for global.json SDK resolution)
        assert_eq!(p.emit_cwd, std::path::Path::new("C:/ws/App"));
    }
}
