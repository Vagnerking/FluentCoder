use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};

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

fn validate_child_path(
    workspace_root: &str,
    parent: &str,
    name: &str,
) -> Result<PathBuf, String> {
    if name != name.trim() {
        return Err("O nome não pode começar ou terminar com espaço.".into());
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("Informe um nome.".into());
    }
    if name == "." || name == ".." {
        return Err("Use um nome diferente de ponto ou ponto duplo.".into());
    }
    if name.ends_with('.') {
        return Err("O nome não pode terminar com ponto.".into());
    }
    if name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c)) {
        return Err("O nome contém caracteres inválidos.".into());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("Esse nome é reservado pelo Windows.".into());
    }
    if Path::new(name).components().any(|part| {
        !matches!(part, Component::Normal(_))
    }) {
        return Err("Informe somente o nome, sem caminho.".into());
    }

    let root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Não foi possível validar o workspace: {e}"))?;
    let parent = fs::canonicalize(parent)
        .map_err(|e| format!("Não foi possível acessar a pasta de destino: {e}"))?;
    if !parent.starts_with(&root) {
        return Err("A pasta de destino está fora do workspace.".into());
    }
    if !parent.is_dir() {
        return Err("O destino selecionado não é uma pasta.".into());
    }
    Ok(parent.join(name))
}

fn entry_for(path: PathBuf, is_dir: bool) -> Result<DirEntry, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "O nome criado não pôde ser exibido.".to_string())?
        .to_string();
    Ok(DirEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
    })
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

/// Reads a file's raw bytes and returns them as a base64 `data:` URL.
///
/// Used by the image preview ("Open With… ▸ Preview de Imagem", ISSUE-70): the
/// WebView can't load arbitrary local paths without the asset protocol, so we
/// inline the bytes. `mime` is inferred from the extension; unknown types fall
/// back to `application/octet-stream` (the browser still renders common images).
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    let mime = mime_for_path(&path);
    Ok(format!("data:{};base64,{}", mime, base64_encode(&bytes)))
}

/// Best-effort MIME type from a file extension (image types we preview).
fn mime_for_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Minimal standard-base64 encoder (avoids pulling in a crate for one use).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Writes `contents` to `path`, creating parent directories if needed.
#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, contents).map_err(|e| format!("Falha ao salvar '{path}': {e}"))
}

/// Creates an empty file without ever overwriting an existing path.
#[tauri::command]
pub fn create_file(
    workspace_root: String,
    parent: String,
    name: String,
) -> Result<DirEntry, String> {
    let path = validate_child_path(&workspace_root, &parent, &name)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("Não foi possível criar o arquivo: {e}"))?;
    entry_for(path, false)
}

/// Creates exactly one folder level and rejects collisions.
#[tauri::command]
pub fn create_folder(
    workspace_root: String,
    parent: String,
    name: String,
) -> Result<DirEntry, String> {
    let path = validate_child_path(&workspace_root, &parent, &name)?;
    fs::create_dir(&path).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
    entry_for(path, true)
}

#[cfg(test)]
mod tests {
    use super::{create_file, create_folder};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn workspace() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("code-editor-explorer-{id}"));
        fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn creates_file_without_overwriting() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let created = create_file(root_text.clone(), root_text.clone(), "novo.txt".into()).unwrap();
        assert_eq!(created.name, "novo.txt");
        assert!(!created.is_dir);
        assert!(create_file(root_text.clone(), root_text, "novo.txt".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_single_folder_and_rejects_paths() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let created =
            create_folder(root_text.clone(), root_text.clone(), "src".into()).unwrap();
        assert!(created.is_dir);
        assert!(create_folder(root_text.clone(), root_text, "../fora".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_windows_reserved_or_invalid_names() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        for name in ["CON", "aux.txt", "nome.", "nome ", "a/b"] {
            assert!(
                create_file(root_text.clone(), root_text.clone(), name.into()).is_err(),
                "{name} deveria ser rejeitado"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
