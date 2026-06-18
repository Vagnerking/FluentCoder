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
