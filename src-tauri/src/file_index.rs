//! Builds the flat list of project files that powers Quick Open (Ctrl+P).
//!
//! Unlike `search_in_dir`, this never reads file contents — it only walks the
//! tree and collects paths, so it stays fast even on large projects. The fuzzy
//! matching and ranking happen on the front end; the backend just produces the
//! index.

use crate::walk::is_skipped_dir;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// One file in the project index, as consumed by the Quick Open palette.
#[derive(Serialize)]
pub struct ProjectFile {
    /// Absolute path — what we hand back to the editor to open the file.
    path: String,
    /// File name, shown as the primary label (and matched with most weight).
    name: String,
    /// Path relative to `root`, normalized to `/`, shown dimmed next to the name.
    rel: String,
}

/// Safety cap so a pathological project (or an accidental scan of a huge tree)
/// can't produce a multi-hundred-MB payload or stall the UI.
const MAX_FILES: usize = 20_000;

/// Walks `root` and returns every regular file beneath it, skipping the heavy
/// directories in `walk::SKIP_DIRS`. Caps at `MAX_FILES`; if the cap is hit the
/// list is simply truncated (Quick Open's fuzzy filter still works on it).
#[tauri::command]
pub fn list_project_files(root: String) -> Result<Vec<ProjectFile>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("não é um diretório: {root}"));
    }

    let mut out: Vec<ProjectFile> = Vec::new();
    walk(root_path, root_path, &mut out);
    Ok(out)
}

/// Whether `root` (or a non-skipped subdir, bounded depth) contains a `.sln` or
/// `.csproj`. Used to decide whether to warm-start the C# Roslyn on folder open.
///
/// `async` + `spawn_blocking`: the directory walk runs on the blocking pool, NEVER
/// the main thread, so opening a large folder can't stall the UI. Early-exits on
/// the first match, so the common case (solution at the root) returns instantly.
#[tauri::command]
pub async fn has_dotnet_project(root: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || find_dotnet(Path::new(&root), 0))
        .await
        .map_err(|e| format!("has_dotnet_project join error: {e}"))
}

/// Depth-bounded search for a `.sln`/`.csproj`, files first (so a root-level
/// solution short-circuits before descending), skipping the heavy dirs.
fn find_dotnet(dir: &Path, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_file() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(".sln") || name.ends_with(".csproj") {
                return true;
            }
        } else if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            // Skip the shared heavy dirs AND build outputs (a project's `.csproj`
            // is never inside bin/obj). Skipping them only here keeps Quick
            // Open/search behavior unchanged (they still index bin/obj).
            if !is_skipped_dir(&name) && lower != "bin" && lower != "obj" {
                subdirs.push(entry.path());
            }
        }
    }
    subdirs.iter().any(|d| find_dotnet(d, depth + 1))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>) {
    if out.len() >= MAX_FILES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable dir (perms, etc.) — skip silently
    };

    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_skipped_dir(&name) {
                continue;
            }
            walk(root, &path, out);
        } else if file_type.is_file() {
            let path_str = path.to_string_lossy().to_string();
            let name = entry.file_name().to_string_lossy().to_string();
            // strip_prefix can fail only if `path` isn't under `root`, which it
            // always is here; fall back to the file name if it ever does.
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            out.push(ProjectFile {
                path: path_str,
                name,
                rel,
            });
        }
    }
}
