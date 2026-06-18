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
    let file = RunFile { configurations: configs };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

/// Inspects the project and suggests run configurations the user can add with
/// one click: npm/pnpm/yarn scripts from package.json, and `cargo run` when a
/// Cargo.toml is present. Suggestions are never persisted until the user adds
/// them, so they always reflect the current project.
#[tauri::command]
pub fn run_configs_detect(root: String) -> Result<Vec<RunConfig>, String> {
    let mut detected: Vec<RunConfig> = Vec::new();
    let root_path = Path::new(&root);

    // package.json → one entry per script.
    let pkg_path = root_path.join("package.json");
    if let Ok(raw) = fs::read_to_string(&pkg_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            let runner = detect_node_runner(root_path);
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
    if root_path.join("Cargo.toml").exists() {
        detected.push(RunConfig {
            name: "cargo run".to_string(),
            command: "cargo run".to_string(),
            cwd: String::new(),
        });
    }

    Ok(detected)
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
