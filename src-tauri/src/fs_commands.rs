use serde::Serialize;
use std::fs;
use std::path::Path;

/// A single entry (file or directory) inside a folder, as shown in the explorer.
#[derive(Serialize)]
pub struct DirEntry {
    /// Display name, e.g. "main.rs".
    name: String,
    /// Absolute path, used as a stable id and to open/read the entry.
    path: String,
    /// Whether this entry is a directory (so the UI can render a chevron).
    is_dir: bool,
}

/// Lists the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Children are read lazily:
/// the explorer calls this again when a folder is expanded.
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("Falha ao ler '{path}': {e}"))?;

    let mut entries: Vec<DirEntry> = Vec::new();
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        let path = item.path().to_string_lossy().to_string();
        entries.push(DirEntry {
            name,
            path,
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        // Directories before files, then by lowercased name.
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Reads a text file and returns its contents.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))
}

/// Writes `contents` to `path`, creating parent directories if needed.
#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| format!("Falha ao salvar '{path}': {e}"))
}
