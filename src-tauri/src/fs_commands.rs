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

fn validate_child_path(workspace_root: &str, parent: &str, name: &str) -> Result<PathBuf, String> {
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
    if name
        .chars()
        .any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
    {
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
    if Path::new(name)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
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

/// Canonicalizes `path` and confirms it stays under `workspace_root`.
/// Returns the canonical source path, rejecting directory traversal (`..`).
fn validate_existing_path(workspace_root: &str, path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Não foi possível validar o workspace: {e}"))?;
    let target =
        fs::canonicalize(path).map_err(|e| format!("Não foi possível acessar o item: {e}"))?;
    if !target.starts_with(&root) {
        return Err("O item está fora do workspace.".into());
    }
    Ok(target)
}

/// Given a desired path that may already exist, returns a non-colliding
/// alternative by appending " - Cópia", " - Cópia (2)", … before the
/// extension. Never overwrites an existing path.
fn resolve_collision(desired: &Path) -> PathBuf {
    if !desired.exists() {
        return desired.to_path_buf();
    }
    let parent = desired.parent().unwrap_or_else(|| Path::new("."));
    let stem = desired
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("item")
        .to_string();
    let ext = desired.extension().and_then(|e| e.to_str());
    let build = |suffix: &str| -> PathBuf {
        let name = match ext {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        parent.join(name)
    };
    let first = build(" - Cópia");
    if !first.exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = build(&format!(" - Cópia ({n})"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Recursively copies `src` (file or directory) to `dest` (full path).
fn copy_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir(dest).map_err(|e| format!("Não foi possível criar a pasta: {e}"))?;
        for item in fs::read_dir(src).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let child_dest = dest.join(item.file_name());
            copy_recursive(&item.path(), &child_dest)?;
        }
        Ok(())
    } else {
        fs::copy(src, dest)
            .map(|_| ())
            .map_err(|e| format!("Não foi possível copiar o arquivo: {e}"))
    }
}

fn entry_for(path: PathBuf, is_dir: bool) -> Result<DirEntry, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "O nome criado não pôde ser exibido.".to_string())?
        .to_string();
    Ok(DirEntry {
        name,
        path: path_for_frontend(&path),
        is_dir,
    })
}

/// Converts a native path to the stable form used by the frontend.
///
/// `fs::canonicalize` adds Windows' extended-length prefix (`\\?\`) even for
/// ordinary drive paths. That form is valid for filesystem calls, but feeding
/// it to Monaco's file-URI parser produces `file:////?/C:/...`, which is
/// rejected as a URI with no authority. Keep extended paths internally and
/// remove only the transport prefix when serializing entries to React.
fn path_for_frontend(path: &Path) -> String {
    let value = path.to_string_lossy();

    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }

    value.into_owned()
}

/// Compiles the explorer's `files.exclude` glob patterns into a matcher, or
/// `None` if the list is empty/all-invalid (so the caller skips filtering).
///
/// Patterns follow VS Code's `files.exclude` style — e.g. `**/bin`, `**/obj`,
/// `**/.git`, `**/*.user`. We test each entry by its NAME (the explorer reads one
/// directory at a time and has no workspace-relative path here), and `**/`-style
/// patterns match a bare name because `**` accepts zero path segments. Invalid
/// globs are skipped rather than failing the whole listing.
fn build_exclude_matcher(patterns: &[String]) -> Option<globset::GlobSet> {
    let mut builder = globset::GlobSetBuilder::new();
    let mut any = false;
    for p in patterns {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(glob) = globset::Glob::new(trimmed) {
            builder.add(glob);
            any = true;
        }
    }
    if !any {
        return None;
    }
    builder.build().ok()
}

/// Lists the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Children are read lazily:
/// the explorer calls this again when a folder is expanded.
///
/// `exclude` is the explorer's `files.exclude` glob list (VS Code-style); entries
/// whose name matches any pattern are hidden from the tree. The compilation is
/// per-call but cheap (a handful of patterns); the heavy walks (search, Quick
/// Open) use the separate `walk::SKIP_DIRS` list and are unaffected.
#[tauri::command]
pub fn read_dir(path: String, exclude: Option<Vec<String>>) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("Falha ao ler '{path}': {e}"))?;
    let matcher = exclude.as_deref().and_then(build_exclude_matcher);

    let mut entries: Vec<DirEntry> = Vec::new();
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        // Hide entries the user excluded (e.g. bin/obj on a C# project). We match
        // the entry NAME, since the explorer reads one directory at a time and has
        // no workspace-relative path here; `**/bin` matches a bare `bin` because
        // `**` accepts zero leading segments. For directories we also test
        // `name/` so a subtree pattern like `**/obj/**` hides the `obj` folder
        // itself (globset matches `obj/` but not bare `obj` for that pattern).
        if let Some(m) = &matcher {
            let excluded =
                m.is_match(&name) || (file_type.is_dir() && m.is_match(format!("{name}/")));
            if excluded {
                continue;
            }
        }
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
/// Upper bound for inlining a file as a base64 `data:` URL. Beyond this, the
/// memory + string overhead would freeze the WebView, so we refuse instead.
pub(crate) const MAX_PREVIEW_BYTES: u64 = 256 * 1024 * 1024;

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    if meta.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "Arquivo muito grande para pré-visualizar ({} MB).",
            meta.len() / 1_048_576
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    Ok(data_url(&path, &bytes))
}

/// Builds a `data:` URL (mime inferred from extension) from raw bytes. Shared by
/// the local image/media preview and the remote (SFTP) one in `ssh.rs`.
pub(crate) fn data_url(path: &str, bytes: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        mime_for_path(path),
        base64_encode(bytes)
    )
}

/// Best-effort MIME type from a file extension (image / video / audio we preview).
fn mime_for_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        // Images
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        // Video
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        // Audio
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "opus" => "audio/opus",
        _ => "application/octet-stream",
    }
}

/// Minimal standard-base64 encoder (avoids pulling in a crate for one use).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
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

/// Renames `path` to `new_name` within the same parent folder. Rejects a
/// collision (never overwrites) and revalidates both ends against the workspace.
#[tauri::command]
pub fn rename_path(
    workspace_root: String,
    path: String,
    new_name: String,
) -> Result<DirEntry, String> {
    let source = validate_existing_path(&workspace_root, &path)?;
    let is_dir = source.is_dir();
    let parent = source
        .parent()
        .ok_or_else(|| "O item não tem uma pasta-pai válida.".to_string())?;
    let parent_str = parent.to_string_lossy().to_string();
    let dest = validate_child_path(&workspace_root, &parent_str, &new_name)?;
    if dest == source {
        // Same name → nothing to do; report the unchanged entry.
        return entry_for(source, is_dir);
    }
    if dest.exists() {
        return Err("Já existe um item com esse nome.".into());
    }
    fs::rename(&source, &dest).map_err(|e| format!("Não foi possível renomear: {e}"))?;
    entry_for(dest, is_dir)
}

/// Sends `path` to the OS recycle bin (recoverable). Never deletes permanently.
#[tauri::command]
pub fn delete_to_trash(workspace_root: String, path: String) -> Result<(), String> {
    let target = validate_existing_path(&workspace_root, &path)?;
    trash::delete(&target).map_err(|e| format!("Não foi possível mover para a Lixeira: {e}"))
}

/// Copies `src` (file or directory, recursive) into `dest_parent`, resolving any
/// name collision without overwriting. Revalidates both ends in the workspace.
#[tauri::command]
pub fn copy_path(
    workspace_root: String,
    src: String,
    dest_parent: String,
) -> Result<DirEntry, String> {
    let source = validate_existing_path(&workspace_root, &src)?;
    let dest_parent = validate_existing_path(&workspace_root, &dest_parent)?;
    if !dest_parent.is_dir() {
        return Err("O destino selecionado não é uma pasta.".into());
    }
    let name = source
        .file_name()
        .ok_or_else(|| "O item de origem não tem nome.".to_string())?;
    let desired = dest_parent.join(name);
    let dest = resolve_collision(&desired);
    let is_dir = source.is_dir();
    copy_recursive(&source, &dest)?;
    entry_for(dest, is_dir)
}

/// Moves `src` (file or directory, recursive) into `dest_parent`, resolving any
/// name collision without overwriting. Falls back to copy+remove across volumes.
#[tauri::command]
pub fn move_path(
    workspace_root: String,
    src: String,
    dest_parent: String,
) -> Result<DirEntry, String> {
    let source = validate_existing_path(&workspace_root, &src)?;
    let dest_parent = validate_existing_path(&workspace_root, &dest_parent)?;
    if !dest_parent.is_dir() {
        return Err("O destino selecionado não é uma pasta.".into());
    }
    let name = source
        .file_name()
        .ok_or_else(|| "O item de origem não tem nome.".to_string())?;
    let desired = dest_parent.join(name);
    let dest = resolve_collision(&desired);
    let is_dir = source.is_dir();
    // Try a plain rename first; fall back to copy+remove on cross-volume moves.
    if fs::rename(&source, &dest).is_err() {
        copy_recursive(&source, &dest)?;
        if is_dir {
            fs::remove_dir_all(&source)
                .map_err(|e| format!("Não foi possível remover a origem: {e}"))?;
        } else {
            fs::remove_file(&source)
                .map_err(|e| format!("Não foi possível remover a origem: {e}"))?;
        }
    }
    entry_for(dest, is_dir)
}

/// Opens the OS file manager with `path` selected. On Windows this runs
/// `explorer /select,<path>`; `explorer.exe` returns a non-zero exit code even
/// on success, so the exit status is intentionally ignored.
#[tauri::command]
pub fn reveal_in_explorer(workspace_root: String, path: String) -> Result<(), String> {
    let target = validate_existing_path(&workspace_root, &path)?;
    let target_str = target.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&target_str)
            .spawn()
            .map_err(|e| format!("Não foi possível abrir o Explorer: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target_str;
        Err("Revelar no Explorer só é suportado no Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_exclude_matcher, copy_path, create_file, create_folder, move_path, rename_path};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn exclude_matcher_hides_build_dirs_by_name() {
        let patterns: Vec<String> = ["**/bin", "**/obj", "**/.git", "**/*.user"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let m = build_exclude_matcher(&patterns).expect("matcher");
        // `**/x` matches a bare name because `**` accepts zero leading segments.
        assert!(m.is_match("bin"));
        assert!(m.is_match("obj"));
        assert!(m.is_match(".git"));
        assert!(m.is_match("App.csproj.user"));
        // Real project content is NOT hidden.
        assert!(!m.is_match("Controllers"));
        assert!(!m.is_match("Program.cs"));
        assert!(!m.is_match("binaries")); // not an exact `bin` segment
    }

    #[test]
    fn exclude_matcher_handles_subtree_globs_for_dirs() {
        // A trailing-globstar pattern targets the subtree; read_dir tests `name/`
        // for directories so the dir itself is hidden too.
        let m = build_exclude_matcher(&["**/obj/**".to_string()]).expect("matcher");
        assert!(!m.is_match("obj"), "bare name doesn't match a subtree glob");
        assert!(m.is_match("obj/"), "but `name/` does (how read_dir tests dirs)");
        assert!(m.is_match("obj/Debug"));
    }

    #[test]
    fn exclude_matcher_is_none_when_empty_or_all_invalid() {
        assert!(build_exclude_matcher(&[]).is_none());
        assert!(build_exclude_matcher(&["".to_string(), "   ".to_string()]).is_none());
        // A malformed glob is skipped, not fatal: a valid one still builds a matcher.
        let m = build_exclude_matcher(&["[".to_string(), "**/bin".to_string()]).expect("matcher");
        assert!(m.is_match("bin"));
    }

    fn workspace() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("fluent-coder-explorer-{id}"));
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
        let created = create_folder(root_text.clone(), root_text.clone(), "src".into()).unwrap();
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

    #[test]
    fn renames_file_and_rejects_collision() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let a = create_file(root_text.clone(), root_text.clone(), "a.txt".into()).unwrap();
        create_file(root_text.clone(), root_text.clone(), "b.txt".into()).unwrap();

        let renamed = rename_path(root_text.clone(), a.path.clone(), "c.txt".into()).unwrap();
        assert_eq!(renamed.name, "c.txt");
        assert!(!Path::new(&a.path).exists());
        assert!(Path::new(&renamed.path).exists());

        // Renaming onto an existing name must be rejected (no overwrite).
        assert!(rename_path(root_text.clone(), renamed.path, "b.txt".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn serializes_renamed_paths_without_windows_extended_prefix() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let file = create_file(root_text.clone(), root_text.clone(), "before.txt".into()).unwrap();

        let renamed = rename_path(root_text, file.path, "after.txt".into()).unwrap();

        assert!(
            !renamed.path.starts_with(r"\\?\"),
            "o frontend não deve receber caminho estendido: {}",
            renamed.path
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_file_with_collision_suffix() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let f = create_file(root_text.clone(), root_text.clone(), "doc.txt".into()).unwrap();
        fs::write(&f.path, "hello").unwrap();

        // Copy into the same parent → collision resolved with a suffix.
        let copied = copy_path(root_text.clone(), f.path.clone(), root_text.clone()).unwrap();
        assert_ne!(copied.path, f.path);
        assert!(copied.name.contains("Cópia"));
        assert_eq!(fs::read_to_string(&copied.path).unwrap(), "hello");
        assert!(Path::new(&f.path).exists(), "origem deve permanecer");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_folder_recursively() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let dir = create_folder(root_text.clone(), root_text.clone(), "pasta".into()).unwrap();
        create_file(root_text.clone(), dir.path.clone(), "inner.txt".into()).unwrap();
        let dest = create_folder(root_text.clone(), root_text.clone(), "destino".into()).unwrap();

        let copied = copy_path(root_text.clone(), dir.path.clone(), dest.path.clone()).unwrap();
        assert!(copied.is_dir);
        assert!(Path::new(&copied.path).join("inner.txt").exists());
        assert!(Path::new(&dir.path).exists(), "origem deve permanecer");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moves_file_and_folder() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        let dest = create_folder(root_text.clone(), root_text.clone(), "out".into()).unwrap();

        let file = create_file(root_text.clone(), root_text.clone(), "m.txt".into()).unwrap();
        let moved = move_path(root_text.clone(), file.path.clone(), dest.path.clone()).unwrap();
        assert!(
            !Path::new(&file.path).exists(),
            "origem deve sumir após mover"
        );
        assert!(Path::new(&moved.path).exists());

        let folder = create_folder(root_text.clone(), root_text.clone(), "mp".into()).unwrap();
        create_file(root_text.clone(), folder.path.clone(), "k.txt".into()).unwrap();
        let moved_dir =
            move_path(root_text.clone(), folder.path.clone(), dest.path.clone()).unwrap();
        assert!(moved_dir.is_dir);
        assert!(!Path::new(&folder.path).exists());
        assert!(Path::new(&moved_dir.path).join("k.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_operations_outside_workspace() {
        let root = workspace();
        let root_text = root.to_string_lossy().to_string();
        // A sibling temp dir, definitely outside `root`.
        let outside = workspace();
        let outside_file = create_file(
            outside.to_string_lossy().to_string(),
            outside.to_string_lossy().to_string(),
            "x.txt".into(),
        )
        .unwrap();

        assert!(
            rename_path(root_text.clone(), outside_file.path.clone(), "y.txt".into()).is_err(),
            "renomear fora do workspace deve falhar"
        );
        assert!(
            copy_path(
                root_text.clone(),
                outside_file.path.clone(),
                root_text.clone()
            )
            .is_err(),
            "copiar origem fora do workspace deve falhar"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
