use crate::walk::is_skipped_dir;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// One matching line within a file, mirroring VSCode's search result rows.
#[derive(Serialize)]
pub struct SearchMatch {
    /// Absolute path of the file containing the match.
    path: String,
    /// File name for display (the result is grouped by file in the UI).
    name: String,
    /// 1-based line number of the match.
    line: usize,
    /// The full text of the matching line, trimmed of trailing newline.
    text: String,
}

/// Recursively searches `root` for lines containing `query` (case-insensitive),
/// skipping known-heavy directories and anything that doesn't look like text.
/// Caps results so a broad query can't flood the UI or hang the call.
#[tauri::command]
pub fn search_in_dir(root: String, query: String) -> Result<Vec<SearchMatch>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();
    let mut out: Vec<SearchMatch> = Vec::new();
    const MAX_RESULTS: usize = 500;

    walk(Path::new(&root), &needle, &mut out, MAX_RESULTS);
    Ok(out)
}

fn walk(dir: &Path, needle: &str, out: &mut Vec<SearchMatch>, max: usize) {
    if out.len() >= max {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // unreadable dir (perms, etc.) — skip silently
    };

    for entry in entries.flatten() {
        if out.len() >= max {
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
            walk(&path, needle, out, max);
        } else if file_type.is_file() {
            search_file(&path, needle, out, max);
        }
    }
}

fn search_file(path: &Path, needle: &str, out: &mut Vec<SearchMatch>, max: usize) {
    // read_to_string fails on binary/non-UTF-8 files — that's the filter we want.
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let path_str = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());

    for (i, line) in content.lines().enumerate() {
        if out.len() >= max {
            return;
        }
        if line.to_lowercase().contains(needle) {
            out.push(SearchMatch {
                path: path_str.clone(),
                name: name.clone(),
                line: i + 1,
                text: line.trim_end().chars().take(400).collect(),
            });
        }
    }
}
