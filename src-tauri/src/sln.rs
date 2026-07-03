//! `.sln` parsing for the Solution Explorer (roadmap csharp-ide-parity, Fase D).
//!
//! Classic solution format only (the one `dotnet new sln`/VS emit and the shadow
//! generator in `razor/exec.rs` renders): `Project("{TYPE-GUID}") = "Name",
//! "rel\path.csproj", "{PROJ-GUID}"` lines. Solution FOLDERS (entries whose
//! path has no project extension) are skipped — V1 is a flat project list.

use std::path::Path;

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlnProject {
    pub name: String,
    /// Absolute path to the project file.
    pub csproj_path: String,
}

/// Parses `sln_path` and returns its projects with ABSOLUTE project paths.
#[tauri::command]
pub fn sln_parse(sln_path: String) -> Result<Vec<SlnProject>, String> {
    let text = std::fs::read_to_string(&sln_path).map_err(|e| e.to_string())?;
    let base = Path::new(&sln_path).parent().unwrap_or(Path::new("."));
    Ok(parse_sln_text(&text, base))
}

pub(crate) fn parse_sln_text(text: &str, base: &Path) -> Vec<SlnProject> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("Project(") {
            continue;
        }
        // Right side of `=`: `"Name", "rel\path", "{guid}"`.
        let Some((_, rhs)) = trimmed.split_once('=') else { continue };
        let parts: Vec<&str> = rhs
            .split(',')
            .map(|p| p.trim().trim_matches('"'))
            .collect();
        if parts.len() < 2 {
            continue;
        }
        let name = parts[0].to_string();
        let rel = parts[1];
        // Solution folders repeat the name as "path" with no extension — skip
        // anything that isn't a project file.
        let is_project = [".csproj", ".vbproj", ".fsproj"]
            .iter()
            .any(|ext| rel.to_lowercase().ends_with(ext));
        if !is_project {
            continue;
        }
        // Solutions always use `\` separators; make them OS-correct.
        let os_rel = rel.replace('\\', std::path::MAIN_SEPARATOR_STR);
        let abs = if Path::new(&os_rel).is_absolute() {
            os_rel
        } else {
            base.join(os_rel).to_string_lossy().to_string()
        };
        out.push(SlnProject { name, csproj_path: abs });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLN: &str = r#"
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "App.Web", "src\App.Web\App.Web.csproj", "{1111}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Solution Items", "Solution Items", "{2222}"
EndProject
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "App.Tests", "tests\App.Tests\App.Tests.csproj", "{3333}"
EndProject
Global
EndGlobal
"#;

    #[test]
    fn parses_projects_and_skips_solution_folders() {
        let base = if cfg!(windows) { Path::new("C:\\sln") } else { Path::new("/sln") };
        let projects = parse_sln_text(SLN, base);
        assert_eq!(projects.len(), 2, "solution folder must be skipped");
        assert_eq!(projects[0].name, "App.Web");
        assert!(projects[0].csproj_path.ends_with("App.Web.csproj"));
        assert!(
            projects[0].csproj_path.replace('\\', "/").contains("sln/src/App.Web"),
            "relative path resolved against the sln dir: {}",
            projects[0].csproj_path
        );
        assert_eq!(projects[1].name, "App.Tests");
    }

    #[test]
    fn roundtrips_the_shadow_generator_output() {
        // The sln our own broker writes (razor/exec.rs render_solution) parses.
        let sln_dir = if cfg!(windows) { Path::new("C:\\ws\\shadow") } else { Path::new("/ws/shadow") };
        let text = crate::razor::exec::render_solution(
            sln_dir,
            &[
                ("UserProject", Path::new(if cfg!(windows) { "C:\\ws\\App\\App.csproj" } else { "/ws/App/App.csproj" })),
                ("ShadowRazor", Path::new(if cfg!(windows) { "C:\\ws\\shadow\\ShadowRazor.csproj" } else { "/ws/shadow/ShadowRazor.csproj" })),
            ],
        );
        let projects = parse_sln_text(&text, sln_dir);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].name, "UserProject");
        assert!(projects[1].csproj_path.ends_with("ShadowRazor.csproj"));
    }
}
