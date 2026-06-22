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
/// one click: npm/pnpm/yarn scripts from package.json, and `cargo run` when a
/// Cargo.toml is present. Suggestions are never persisted until the user adds
/// them, so they always reflect the current project.
#[tauri::command]
pub fn run_configs_detect(root: String) -> Result<Vec<RunConfig>, String> {
    let root_path = Path::new(&root);
    let pkg_json = fs::read_to_string(root_path.join("package.json")).ok();
    let runner = detect_node_runner(root_path);
    let has_cargo = root_path.join("Cargo.toml").exists();
    Ok(detect_configs(pkg_json.as_deref(), runner, has_cargo))
}

/// Pure detection shared by the local and remote (SSH) detectors: builds run
/// suggestions from a `package.json` body (if any), the chosen package runner,
/// and whether a `Cargo.toml` is present.
pub(crate) fn detect_configs(
    pkg_json: Option<&str>,
    runner: &str,
    has_cargo: bool,
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
