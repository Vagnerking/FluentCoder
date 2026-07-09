use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// A single run/debug configuration, persisted in `.project/run.json`.
///
/// `command` is a shell command line executed by the integrated terminal in
/// `cwd` (defaults to the project root when empty). `kind` distinguishes
/// user-defined entries from auto-detected suggestions in the UI.
#[derive(Serialize, Deserialize, Clone)]
pub struct RunConfig {
    /// Display name, e.g. "dev" or "cargo run".
    pub name: String,
    /// Shell command line to execute, e.g. "npm run dev".
    pub command: String,
    /// Working directory relative to the project root, or empty for the root.
    #[serde(default)]
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Default)]
struct RunFile {
    #[serde(default)]
    configurations: Vec<RunConfig>,
}

/// Path to the persisted run config file for a project root.
fn run_file_path(root: &str) -> PathBuf {
    Path::new(root).join(".project").join("run.json")
}

/// Reads the saved run configurations for `root`. Returns an empty list when the
/// file doesn't exist yet (first use) — not an error.
#[tauri::command]
pub fn run_configs_load(root: String) -> Result<Vec<RunConfig>, String> {
    let path = run_file_path(&root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: RunFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(parsed.configurations)
}

/// Persists `configs` to `.project/run.json`, creating the folder if needed.
#[tauri::command]
pub fn run_configs_save(root: String, configs: Vec<RunConfig>) -> Result<(), String> {
    let path = run_file_path(&root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = RunFile {
        configurations: configs,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Inspects the project and suggests run configurations the user can add with
/// one click: npm/pnpm/yarn scripts from package.json, `cargo run` when a
/// Cargo.toml is present, and `dotnet run --project …` for each RUNNABLE `.csproj`
/// (executable or web/worker SDK — not libraries). Suggestions are never persisted
/// until the user adds them, so they always reflect the current project.
#[tauri::command]
pub fn run_configs_detect(root: String) -> Result<Vec<RunConfig>, String> {
    let root_path = Path::new(&root);
    let pkg_json = fs::read_to_string(root_path.join("package.json")).ok();
    let runner = detect_node_runner(root_path);
    let has_cargo = root_path.join("Cargo.toml").exists();
    let dotnet = detect_runnable_csprojs(root_path);
    Ok(detect_configs(pkg_json.as_deref(), runner, has_cargo, &dotnet))
}

/// A runnable .NET project: its name and path relative to the workspace root
/// (forward-slashed), used to build a `dotnet run --project <rel>` suggestion.
#[derive(Clone)]
pub(crate) struct RunnableCsproj {
    pub name: String,
    pub rel_path: String,
}

/// True when a `.csproj` body describes a RUNNABLE project (an app, not a
/// library): `<OutputType>Exe</OutputType>` (any casing), or a Web/Worker SDK
/// (`Microsoft.NET.Sdk.Web` / `.Worker`). A plain `Microsoft.NET.Sdk` with no
/// `OutputType` is a library and yields no run suggestion.
pub(crate) fn csproj_is_runnable(body: &str) -> bool {
    let lower = body.to_lowercase();
    if lower.contains("<outputtype>exe</outputtype>") {
        return true;
    }
    // Sdk attribute on the <Project> element, e.g. Sdk="Microsoft.NET.Sdk.Web".
    lower.contains("microsoft.net.sdk.web") || lower.contains("microsoft.net.sdk.worker")
}

/// Scans the workspace (root + one level of subfolders — the usual `src/`,
/// `<Layer>/` layout) for runnable `.csproj`s. Shallow on purpose: deep scans are
/// slow and `bin`/`obj` would pollute results.
fn detect_runnable_csprojs(root: &Path) -> Vec<RunnableCsproj> {
    let mut out = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Skip noise dirs; keep it to one level deep.
            if p.is_dir() && !matches!(name.as_ref(), "bin" | "obj" | "node_modules" | ".git" | ".project") {
                dirs.push(p);
            }
        }
    }
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("csproj") {
                continue;
            }
            let Ok(body) = fs::read_to_string(&p) else { continue };
            if !csproj_is_runnable(&body) {
                continue;
            }
            let rel = p.strip_prefix(root).unwrap_or(&p);
            out.push(RunnableCsproj {
                name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                rel_path: rel.to_string_lossy().replace('\\', "/"),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Pure detection shared by the local and remote (SSH) detectors: builds run
/// suggestions from a `package.json` body (if any), the chosen package runner,
/// whether a `Cargo.toml` is present, and the runnable `.csproj`s found.
pub(crate) fn detect_configs(
    pkg_json: Option<&str>,
    runner: &str,
    has_cargo: bool,
    dotnet: &[RunnableCsproj],
) -> Vec<RunConfig> {
    let mut detected: Vec<RunConfig> = Vec::new();

    // package.json → one entry per script.
    if let Some(raw) = pkg_json {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) {
                for name in scripts.keys() {
                    detected.push(RunConfig {
                        name: format!("{runner}: {name}"),
                        command: format!("{runner} run {name}"),
                        cwd: String::new(),
                    });
                }
            }
        }
    }

    // Cargo.toml → cargo run.
    if has_cargo {
        detected.push(RunConfig {
            name: "cargo run".to_string(),
            command: "cargo run".to_string(),
            cwd: String::new(),
        });
    }

    // Runnable .csproj → dotnet run --project <rel>.
    for proj in dotnet {
        detected.push(RunConfig {
            name: format!("dotnet: {}", proj.name),
            command: format!("dotnet run --project \"{}\"", proj.rel_path),
            cwd: String::new(),
        });
    }

    detected
}

/// Parses the run config file body (`.project/run.json`); empty/blank → no entries.
pub(crate) fn parse_run_file(raw: &str) -> Result<Vec<RunConfig>, String> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: RunFile = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    Ok(parsed.configurations)
}

/// Serializes run configs to the `.project/run.json` body (shared with SSH save).
pub(crate) fn serialize_run_file(configs: Vec<RunConfig>) -> Result<String, String> {
    let file = RunFile {
        configurations: configs,
    };
    serde_json::to_string_pretty(&file).map_err(|e| e.to_string())
}

/// Picks the package manager based on the lockfile present, defaulting to npm.
fn detect_node_runner(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csproj_exe_is_runnable() {
        let body = r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>"#;
        assert!(csproj_is_runnable(body));
    }

    #[test]
    fn csproj_web_and_worker_sdk_are_runnable() {
        assert!(csproj_is_runnable(r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#));
        assert!(csproj_is_runnable(r#"<Project Sdk="Microsoft.NET.Sdk.Worker"></Project>"#));
    }

    #[test]
    fn csproj_library_is_not_runnable() {
        // Plain SDK, no OutputType → library, no run suggestion.
        let body = r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>"#;
        assert!(!csproj_is_runnable(body));
    }

    #[test]
    fn csproj_runnable_is_case_insensitive() {
        assert!(csproj_is_runnable(r#"<OUTPUTTYPE>EXE</OUTPUTTYPE>"#));
    }

    #[test]
    fn detect_configs_adds_dotnet_run_per_runnable_project() {
        let dotnet = vec![
            RunnableCsproj { name: "Api".into(), rel_path: "src/Api/Api.csproj".into() },
            RunnableCsproj { name: "Worker".into(), rel_path: "Worker/Worker.csproj".into() },
        ];
        let cfgs = detect_configs(None, "npm", false, &dotnet);
        let cmds: Vec<_> = cfgs.iter().map(|c| c.command.as_str()).collect();
        assert!(cmds.contains(&"dotnet run --project \"src/Api/Api.csproj\""));
        assert!(cmds.contains(&"dotnet run --project \"Worker/Worker.csproj\""));
        // Names are prefixed so the UI groups them.
        assert!(cfgs.iter().any(|c| c.name == "dotnet: Api"));
    }

    #[test]
    fn detect_configs_without_dotnet_is_unchanged() {
        // npm scripts + cargo still work with no .NET projects.
        let pkg = r#"{"scripts":{"dev":"vite","build":"tsc"}}"#;
        let cfgs = detect_configs(Some(pkg), "npm", true, &[]);
        assert!(cfgs.iter().any(|c| c.command == "npm run dev"));
        assert!(cfgs.iter().any(|c| c.command == "cargo run"));
        assert!(!cfgs.iter().any(|c| c.command.starts_with("dotnet run")));
    }
}
