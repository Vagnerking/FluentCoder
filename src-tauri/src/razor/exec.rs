//! Broker execution — materialize a [`BrokerPlan`] on disk (ADR 0002, brick 5).
//!
//! Writes the shadow project, copies the emitted projected `.g.cs` into it, and
//! generates a 2-project solution (user + shadow) for Roslyn to `solution/open`.
//! Running `dotnet` (emit) and launching/forwarding Roslyn is the LSP-layer step
//! that consumes the materialized output; this module owns only the filesystem
//! materialization (and the solution text), which is what we can validate
//! deterministically here.

use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Component, Path, PathBuf};

use super::broker::BrokerPlan;

/// C# SDK-style project type GUID (used in the generated `.sln`).
const CSHARP_PROJECT_TYPE: &str = "9A19103F-16F7-4668-BE54-9A1E7A4F7556";

/// Materialize the plan: create the shadow project, copy projected `.g.cs`, and
/// write the solution. Idempotent (overwrites). Does NOT run `dotnet` or Roslyn.
pub fn materialize(plan: &BrokerPlan) -> io::Result<()> {
    fs::create_dir_all(&plan.shadow_dir)?;
    fs::write(&plan.shadow_csproj_path, &plan.shadow_csproj_content)?;

    for pf in &plan.projections {
        if pf.emitted_gcs.exists() {
            if let Some(parent) = pf.shadow_gcs.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&pf.emitted_gcs, &pf.shadow_gcs)?;
        } else if pf.shadow_gcs.exists() {
            // No fresh projection this run — remove any STALE copy so we never
            // serve outdated C# (Roslyn would otherwise analyze old generated code).
            fs::remove_file(&pf.shadow_gcs)?;
        }
    }

    let sln_dir = plan
        .solution_path
        .parent()
        .unwrap_or(&plan.shadow_dir)
        .to_path_buf();
    let sln = render_solution(
        &sln_dir,
        &[
            ("UserProject", &plan.user_csproj_path),
            ("ShadowRazor", &plan.shadow_csproj_path),
        ],
    );
    fs::write(&plan.solution_path, sln)?;
    Ok(())
}

/// Render a classic `.sln` referencing `projects` (name, abs `.csproj`) with
/// paths relative to `sln_dir` and deterministic GUIDs derived from the path.
pub fn render_solution(sln_dir: &Path, projects: &[(&str, &Path)]) -> String {
    let mut s = String::new();
    s.push('\n');
    s.push_str("Microsoft Visual Studio Solution File, Format Version 12.00\n");
    s.push_str("# Visual Studio Version 17\n");

    let guids: Vec<String> = projects.iter().map(|(_, p)| guid_for(p)).collect();
    for ((name, csproj), guid) in projects.iter().zip(&guids) {
        let rel = relative_path(sln_dir, csproj);
        let rel = rel.to_string_lossy().replace('/', "\\");
        s.push_str(&format!(
            "Project(\"{{{CSHARP_PROJECT_TYPE}}}\") = \"{name}\", \"{rel}\", \"{{{guid}}}\"\nEndProject\n"
        ));
    }
    s.push_str("Global\n");
    s.push_str("\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n");
    s.push_str("\t\tDebug|Any CPU = Debug|Any CPU\n");
    s.push_str("\t\tRelease|Any CPU = Release|Any CPU\n");
    s.push_str("\tEndGlobalSection\n");
    s.push_str("\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\n");
    for guid in &guids {
        for cfg in ["Debug", "Release"] {
            s.push_str(&format!(
                "\t\t{{{guid}}}.{cfg}|Any CPU.ActiveCfg = {cfg}|Any CPU\n\t\t{{{guid}}}.{cfg}|Any CPU.Build.0 = {cfg}|Any CPU\n"
            ));
        }
    }
    s.push_str("\tEndGlobalSection\n");
    s.push_str("EndGlobal\n");
    s
}

/// Deterministic GUID-formatted string from a path (distinct per path; not
/// cryptographic — just stable + unique enough for solution project ids).
fn guid_for(path: &Path) -> String {
    let mut h1 = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h1);
    let a = h1.finish();
    let mut h2 = std::collections::hash_map::DefaultHasher::new();
    0x9e3779b97f4a7c15u64.hash(&mut h2);
    path.hash(&mut h2);
    let b = h2.finish();
    format!(
        "{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
        (a >> 32) as u32,
        (a >> 16) as u16,
        a as u16,
        (b >> 48) as u16,
        b & 0xFFFF_FFFF_FFFF
    )
}

/// Relative path from `base` (a directory) to `target`. Falls back to the
/// absolute `target` when there is no shared root (e.g. different Windows drive).
fn relative_path(base: &Path, target: &Path) -> PathBuf {
    let b: Vec<Component> = base.components().collect();
    let t: Vec<Component> = target.components().collect();
    let mut i = 0;
    while i < b.len() && i < t.len() && b[i] == t[i] {
        i += 1;
    }
    if i == 0 {
        return target.to_path_buf(); // no common root → use absolute
    }
    let mut out = PathBuf::new();
    for _ in i..b.len() {
        out.push("..");
    }
    for c in &t[i..] {
        out.push(c.as_os_str());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::razor::broker::ProjectionFile;

    #[test]
    fn relative_path_siblings() {
        let r = relative_path(Path::new("C:/ws/.fluent-razor/shadow"), Path::new("C:/ws/App/App.csproj"));
        assert_eq!(r.to_string_lossy().replace('\\', "/"), "../../App/App.csproj");
    }

    #[test]
    fn relative_path_into_self() {
        let r = relative_path(Path::new("C:/ws/shadow"), Path::new("C:/ws/shadow/ShadowRazor.csproj"));
        assert_eq!(r.to_string_lossy().replace('\\', "/"), "ShadowRazor.csproj");
    }

    #[test]
    fn solution_has_both_projects_distinct_guids() {
        let sln_dir = Path::new("C:/ws/.fluent-razor/shadow");
        let sln = render_solution(
            sln_dir,
            &[
                ("UserProject", Path::new("C:/ws/App/App.csproj")),
                ("ShadowRazor", Path::new("C:/ws/.fluent-razor/shadow/ShadowRazor.csproj")),
            ],
        );
        assert!(sln.contains("Microsoft Visual Studio Solution File, Format Version 12.00"));
        // shadow is two levels under ws -> ..\..\App\App.csproj
        assert!(sln.contains("..\\..\\App\\App.csproj"), "sln:\n{sln}");
        assert!(sln.contains("ShadowRazor.csproj"));
        // two distinct project GUIDs
        let g_user = guid_for(Path::new("C:/ws/App/App.csproj"));
        let g_shadow = guid_for(Path::new("C:/ws/.fluent-razor/shadow/ShadowRazor.csproj"));
        assert_ne!(g_user, g_shadow);
        assert!(sln.contains(&g_user) && sln.contains(&g_shadow));
    }

    #[test]
    fn guid_is_stable_and_well_formed() {
        let p = Path::new("C:/x/y.csproj");
        assert_eq!(guid_for(p), guid_for(p)); // stable
        let g = guid_for(p);
        let parts: Vec<&str> = g.split('-').collect();
        assert_eq!(parts.iter().map(|s| s.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
        assert!(g.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[test]
    fn materialize_writes_shadow_copies_projection_and_solution() {
        let root = std::env::temp_dir().join("fluent_razor_exec_test");
        let _ = fs::remove_dir_all(&root);
        let ws = root.join("ws");
        let proj_dir = ws.join("App");
        fs::create_dir_all(&proj_dir).unwrap();
        let user_csproj = proj_dir.join("App.csproj");
        fs::write(&user_csproj, "<Project/>").unwrap();

        // a fake emitted .g.cs to copy
        let emitted = proj_dir.join("emitted").join("Index_cshtml.g.cs");
        fs::create_dir_all(emitted.parent().unwrap()).unwrap();
        fs::write(&emitted, "// generated").unwrap();

        let shadow_dir = ws.join(".fluent-razor").join("shadow");
        let plan = BrokerPlan {
            shadow_dir: shadow_dir.clone(),
            shadow_csproj_path: shadow_dir.join("ShadowRazor.csproj"),
            shadow_csproj_content: "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>".to_string(),
            user_csproj_path: user_csproj.clone(),
            solution_path: shadow_dir.join("RazorShadow.sln"),
            emit_command: ("dotnet".into(), vec![]),
            emit_cwd: proj_dir.clone(),
            projections: vec![ProjectionFile {
                cshtml_rel: PathBuf::from("Views/Home/Index.cshtml"),
                emitted_gcs: emitted.clone(),
                shadow_gcs: shadow_dir.join("projected").join("Views/Home/Index_cshtml.g.cs"),
            }],
        };

        materialize(&plan).unwrap();

        assert!(plan.shadow_csproj_path.exists());
        assert_eq!(
            fs::read_to_string(shadow_dir.join("projected").join("Views/Home/Index_cshtml.g.cs")).unwrap(),
            "// generated"
        );
        let sln = fs::read_to_string(&plan.solution_path).unwrap();
        assert!(sln.contains("ShadowRazor.csproj"));
        assert!(sln.contains("App.csproj"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn materialize_removes_stale_projection_when_emit_missing() {
        let root = std::env::temp_dir().join("fluent_razor_exec_stale_test");
        let _ = fs::remove_dir_all(&root);
        let shadow_dir = root.join(".fluent-razor").join("shadow");
        let shadow_gcs = shadow_dir.join("projected").join("Views/Index_cshtml.g.cs");
        fs::create_dir_all(shadow_gcs.parent().unwrap()).unwrap();
        fs::write(&shadow_gcs, "// STALE generated").unwrap(); // leftover from a prior run

        let plan = BrokerPlan {
            shadow_dir: shadow_dir.clone(),
            shadow_csproj_path: shadow_dir.join("ShadowRazor.csproj"),
            shadow_csproj_content: "<Project/>".to_string(),
            user_csproj_path: root.join("App").join("App.csproj"),
            solution_path: shadow_dir.join("RazorShadow.sln"),
            emit_command: ("dotnet".into(), vec![]),
            emit_cwd: root.clone(),
            projections: vec![ProjectionFile {
                cshtml_rel: PathBuf::from("Views/Index.cshtml"),
                emitted_gcs: root.join("does-not-exist.g.cs"), // emit produced nothing
                shadow_gcs: shadow_gcs.clone(),
            }],
        };
        fs::create_dir_all(plan.user_csproj_path.parent().unwrap()).unwrap();
        fs::write(&plan.user_csproj_path, "<Project/>").unwrap();

        materialize(&plan).unwrap();
        assert!(!shadow_gcs.exists(), "stale projection must be removed");

        let _ = fs::remove_dir_all(&root);
    }
    // (end-to-end against the real fixture lives in `runtime.rs`, which exercises
    // the full derive→plan→emit→materialize→source-map pipeline.)
}
