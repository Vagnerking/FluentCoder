use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};

/// Runs blocking filesystem work on Tauri's blocking pool. In Tauri 2 a sync
/// `#[tauri::command] fn` runs on the MAIN thread, so every `read_dir`/`read_file`
/// used to freeze the UI (and the GTK event loop) for the whole I/O. All the
/// commands below are `async` wrappers over a `*_blocking` implementation.
async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("tarefa de arquivo falhou: {e}"))?
}

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
    // Device names (`CON`, `COM1`…) are unusable only on Windows; on Linux and
    // macOS they are ordinary (if non-portable) names, so they are allowed.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if cfg!(windows) && is_windows_reserved_stem(&stem) {
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

/// Windows device names that can't be used as a file or folder stem.
fn is_windows_reserved_stem(stem: &str) -> bool {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    RESERVED.contains(&stem)
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
/// `**/.git`, `**/*.user`, but also prefix-anchored ones like `src/generated` or
/// `foo/bar/**`. We test each entry by BOTH its bare name and its
/// workspace-relative path (see `read_dir`): `**/`-style patterns match a bare
/// name because `**` accepts zero leading segments, while prefix-anchored
/// patterns need the relative path. Invalid globs are skipped rather than
/// failing the whole listing.
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

/// Computes a directory entry's path RELATIVE to `workspace_root`, with `/`
/// separators (VS Code glob style). `None` if the entry isn't under the root
/// (e.g. a path outside the opened folder) or no root was provided. Comparison
/// strips Windows' `\\?\` transport prefix from both sides so an extended-length
/// `path` still matches a plain root.
fn workspace_relative(entry: &Path, workspace_root: Option<&str>) -> Option<String> {
    let root = workspace_root?;
    let root_norm = path_for_frontend(Path::new(root)).replace('\\', "/");
    let entry_norm = path_for_frontend(entry).replace('\\', "/");
    let root_trimmed = root_norm.trim_end_matches('/');
    let after = entry_norm.strip_prefix(root_trimmed)?;
    // Require a DIRECTORY-BOUNDARY after the prefix, else a sibling with a shared
    // prefix leaks in: root `/src/App` would wrongly match `/src/AppOther/x`
    // (`strip_prefix` → `Other/x`). Only an exact match (empty) or a `/`-separated
    // descendant is genuinely under the root.
    if after.is_empty() {
        return None; // the root itself, not "relative to itself"
    }
    if !after.starts_with('/') {
        return None; // shared-prefix sibling, not a descendant
    }
    let rest = after.trim_start_matches('/');
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

/// Lists the immediate children of `path`, directories first then files,
/// each group sorted case-insensitively by name. Children are read lazily:
/// the explorer calls this again when a folder is expanded.
///
/// `exclude` is the explorer's `files.exclude` glob list (VS Code-style); entries
/// whose name OR workspace-relative path matches any pattern are hidden from the
/// tree. `workspace_root` (the opened folder) lets prefix-anchored patterns like
/// `src/generated` or `foo/bar/**` work — without it only basename patterns
/// (`**/bin`) apply. The compilation is per-call but cheap (a handful of
/// patterns); the heavy walks (search, Quick Open) use the separate
/// `walk::SKIP_DIRS` list and are unaffected.
#[tauri::command]
pub async fn read_dir(path: String, exclude: Option<Vec<String>>, workspace_root: Option<String>) -> Result<Vec<DirEntry>, String> {
    off_main(move || read_dir_blocking(path, exclude, workspace_root)).await
}

/// Blocking body of [`read_dir`].
pub(crate) fn read_dir_blocking(
    path: String,
    exclude: Option<Vec<String>>,
    workspace_root: Option<String>,
) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("Falha ao ler '{path}': {e}"))?;
    let matcher = exclude.as_deref().and_then(build_exclude_matcher);

    let mut entries: Vec<DirEntry> = Vec::new();
    for item in read {
        let item = item.map_err(|e| e.to_string())?;
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_string();
        // Hide entries the user excluded (e.g. bin/obj on a C# project). Match
        // BOTH the bare NAME and the workspace-relative path, so `**/bin`
        // (basename) and `src/generated` / `foo/bar/**` (prefix-anchored) both
        // work. For directories we also test the trailing-slash form so a subtree
        // pattern like `**/obj/**` hides the `obj` folder itself (globset matches
        // `obj/` but not bare `obj` for that pattern).
        if let Some(m) = &matcher {
            let item_path = item.path();
            let rel = workspace_relative(&item_path, workspace_root.as_deref());
            let is_dir = file_type.is_dir();
            let mut excluded = m.is_match(&name) || (is_dir && m.is_match(format!("{name}/")));
            if !excluded {
                if let Some(rel) = &rel {
                    excluded = m.is_match(rel) || (is_dir && m.is_match(format!("{rel}/")));
                }
            }
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

/// Reads a text file, detecting its encoding and line ending like VS Code.
///
/// Returns the LF-normalised content plus the detected encoding/BOM/EOL so the
/// editor can show them in the status bar and round-trip them on save. This is
/// why a UTF-16 or BOM-prefixed file (e.g. Roslyn's decompiled metadata) opens
/// as clean text instead of showing a stray `◇`/`?` at the start.
///
/// Files above `HUGE_FILE_BYTES` are refused unless `allow_large` (the front
/// end asks first and then opens them read-only in large-file mode); nothing
/// above `MAX_TEXT_BYTES` is ever decoded (the IPC string would exhaust the
/// WebView). Runs off the main thread.
#[tauri::command]
pub async fn read_file(path: String, allow_large: Option<bool>) -> Result<crate::text_io::DecodedFile, String> {
    off_main(move || read_file_blocking(&path, allow_large.unwrap_or(false))).await
}

/// Above this the editor asks before opening (VS Code's
/// `files.maxMemoryForLargeFilesMB` prompt) and opens read-only.
pub(crate) const HUGE_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// Hard ceiling for decoding a file as text at all.
pub(crate) const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;
/// How many leading bytes the binary sniff inspects.
const SNIFF_BYTES: usize = 8 * 1024;

pub(crate) fn read_file_blocking(path: &str, allow_large: bool) -> Result<crate::text_io::DecodedFile, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    let size = meta.len();
    if size > MAX_TEXT_BYTES {
        return Err(format!("Arquivo grande demais para abrir como texto ({} MB).", size / 1_048_576));
    }
    if size > HUGE_FILE_BYTES && !allow_large {
        return Err(format!("FILE_TOO_LARGE:{size}"));
    }
    let bytes = fs::read(path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    Ok(crate::text_io::decode(&bytes))
}

/// Locate an already-open local file without assuming case behavior from its OS.
fn find_same_file_blocking(path: &str, candidates: &[String]) -> Result<Option<usize>, String> {
    let target =
        fs::metadata(path).map_err(|e| format!("Não foi possível identificar o arquivo: {e}"))?;
    if !target.is_file() {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(candidates.iter().position(|candidate| {
            fs::metadata(candidate).is_ok_and(|meta| {
                meta.is_file() && meta.dev() == target.dev() && meta.ino() == target.ino()
            })
        }))
    }
    #[cfg(not(unix))]
    {
        let target = fs::canonicalize(path).map_err(|e| e.to_string())?;
        Ok(candidates.iter().position(|candidate| {
            fs::canonicalize(candidate).is_ok_and(|candidate| candidate == target)
        }))
    }
}

#[tauri::command]
pub async fn find_same_file(
    path: String,
    candidates: Vec<String>,
) -> Result<Option<usize>, String> {
    off_main(move || find_same_file_blocking(&path, &candidates)).await
}

/// What the editor needs to decide HOW to open a file before reading it.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileProbe {
    pub size: u64,
    /// NUL byte in the first 8 KB (and no UTF-16 BOM): almost surely binary.
    pub binary: bool,
}

/// Binary sniff like git/VS Code: a NUL byte in the first block, unless the
/// file starts with a UTF-16 BOM (UTF-16 text is full of NULs).
pub(crate) fn looks_binary(head: &[u8]) -> bool {
    if head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    head.contains(&0)
}

pub(crate) fn probe_file_blocking(path: &str) -> Result<FileProbe, String> {
    use std::io::Read;
    let meta = fs::metadata(path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    if meta.is_dir() {
        return Err(format!("'{path}' é uma pasta."));
    }
    let mut head = vec![0u8; SNIFF_BYTES];
    let mut file = fs::File::open(path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("Falha ao ler '{path}': {e}")),
        }
    }
    Ok(FileProbe { size: meta.len(), binary: looks_binary(&head[..filled]) })
}

/// Size + binary sniff (reads at most 8 KB), off the main thread.
#[tauri::command]
pub async fn probe_file(path: String) -> Result<FileProbe, String> {
    off_main(move || probe_file_blocking(&path)).await
}

/// Re-reads a file forcing a specific encoding ("Reopen with Encoding"). The EOL
/// is still auto-detected from the freshly decoded text.
#[tauri::command]
pub async fn read_file_with_encoding(path: String, encoding: String) -> Result<crate::text_io::DecodedFile, String> {
    off_main(move || read_file_with_encoding_blocking(path, encoding)).await
}

/// Blocking body of [`read_file_with_encoding`].
pub(crate) fn read_file_with_encoding_blocking(
    path: String,
    encoding: String,
) -> Result<crate::text_io::DecodedFile, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    crate::text_io::decode_with(&bytes, &encoding)
}

/// Reads a file's raw bytes and returns them as a base64 `data:` URL.
///
/// Used by the image preview ("Open With… ▸ Preview de Imagem", ISSUE-70): the
/// WebView can't load arbitrary local paths without the asset protocol, so we
/// inline the bytes. `mime` is inferred from the extension; unknown types fall
/// back to `application/octet-stream` (the browser still renders common images).
/// Upper bound for inlining a file as a base64 `data:` URL. Beyond this, the
/// memory + string overhead would freeze the WebView, so we refuse instead.
pub(crate) const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    off_main(move || read_file_base64_blocking(path)).await
}

pub(crate) fn read_file_base64_blocking(path: String) -> Result<String, String> {
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
///
/// `contents` is the editor's LF buffer. When `encoding`/`eol` are supplied
/// (the normal save path), the file is re-encoded to its original encoding,
/// BOM and line ending so an edit never silently rewrites those — matching
/// VS Code's "preserve" default. Omitting them falls back to UTF-8 + LF.
#[tauri::command]
pub async fn write_file(path: String, contents: String, encoding: Option<String>, eol: Option<crate::text_io::Eol>, bom: Option<bool>) -> Result<(), String> {
    off_main(move || write_file_blocking(path, contents, encoding, eol, bom)).await
}

/// Blocking body of [`write_file`].
pub(crate) fn write_file_blocking(
    path: String,
    contents: String,
    encoding: Option<String>,
    eol: Option<crate::text_io::Eol>,
    bom: Option<bool>,
) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = match encoding {
        Some(enc) => {
            let eol = eol.unwrap_or(crate::text_io::Eol::Lf);
            crate::text_io::encode_for_save(&contents, &enc, eol, bom.unwrap_or(false))?
        }
        // Legacy/new-file path: plain UTF-8, no BOM, content as-is.
        None => contents.into_bytes(),
    };
    fs::write(&path, bytes).map_err(|e| format!("Falha ao salvar '{path}': {e}"))
}

/// Creates an empty file without ever overwriting an existing path.
#[tauri::command]
pub async fn create_file(workspace_root: String, parent: String, name: String) -> Result<DirEntry, String> {
    off_main(move || create_file_blocking(workspace_root, parent, name)).await
}

/// Blocking body of [`create_file`].
pub(crate) fn create_file_blocking(
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
pub async fn create_folder(workspace_root: String, parent: String, name: String) -> Result<DirEntry, String> {
    off_main(move || create_folder_blocking(workspace_root, parent, name)).await
}

/// Blocking body of [`create_folder`].
pub(crate) fn create_folder_blocking(
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
pub async fn rename_path(workspace_root: String, path: String, new_name: String) -> Result<DirEntry, String> {
    off_main(move || rename_path_blocking(workspace_root, path, new_name)).await
}

/// Blocking body of [`rename_path`].
pub(crate) fn rename_path_blocking(
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
pub async fn delete_to_trash(workspace_root: String, path: String) -> Result<(), String> {
    off_main(move || delete_to_trash_blocking(workspace_root, path)).await
}

/// Blocking body of [`delete_to_trash`].
pub(crate) fn delete_to_trash_blocking(workspace_root: String, path: String) -> Result<(), String> {
    let target = validate_existing_path(&workspace_root, &path)?;
    crate::platform::move_to_trash(&target)
}

/// Copies `src` (file or directory, recursive) into `dest_parent`, resolving any
/// name collision without overwriting. Revalidates both ends in the workspace.
#[tauri::command]
pub async fn copy_path(workspace_root: String, src: String, dest_parent: String) -> Result<DirEntry, String> {
    off_main(move || copy_path_blocking(workspace_root, src, dest_parent)).await
}

/// Blocking body of [`copy_path`].
pub(crate) fn copy_path_blocking(
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
pub async fn move_path(workspace_root: String, src: String, dest_parent: String) -> Result<DirEntry, String> {
    off_main(move || move_path_blocking(workspace_root, src, dest_parent)).await
}

/// Blocking body of [`move_path`].
pub(crate) fn move_path_blocking(
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

/// Opens the OS file manager with `path` selected — Explorer (`/select,`) on
/// Windows, Finder (`open -R`) on macOS and, on Linux, the desktop's file
/// manager via `org.freedesktop.FileManager1.ShowItems` (falling back to
/// `xdg-open` on the parent folder). See `platform::reveal_in_file_manager`.
///
/// `async` + `spawn_blocking`: the D-Bus call waits for a reply, which must
/// never block the main thread.
#[tauri::command]
pub async fn reveal_in_explorer(workspace_root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = validate_existing_path(&workspace_root, &path)?;
        crate::platform::reveal_in_file_manager(&target)
    })
    .await
    .map_err(|e| format!("reveal join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        build_exclude_matcher, copy_path_blocking as copy_path, create_file_blocking as create_file,
        create_folder_blocking as create_folder, looks_binary, move_path_blocking as move_path,
        probe_file_blocking, read_file_blocking, rename_path_blocking as rename_path, workspace_relative,
        HUGE_FILE_BYTES,
    };
    use std::fs;
    use std::path::Path;

    #[cfg(unix)]
    #[test]
    fn file_identity_recognizes_aliases_without_merging_distinct_files() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("MixedName.txt");
        let alias = dir.path().join("hard-link.txt");
        let other = dir.path().join("other.txt");
        fs::write(&first, "first").unwrap();
        fs::hard_link(&first, &alias).unwrap();
        fs::write(&other, "other").unwrap();
        let candidates = vec![first.to_string_lossy().into_owned()];
        assert_eq!(
            super::find_same_file_blocking(alias.to_str().unwrap(), &candidates).unwrap(),
            Some(0)
        );
        assert_eq!(
            super::find_same_file_blocking(other.to_str().unwrap(), &candidates).unwrap(),
            None
        );
        let lower = dir.path().join("mixedname.txt");
        if lower.exists() {
            // Case-insensitive volume: the differently cased path is an alias.
            assert_eq!(
                super::find_same_file_blocking(lower.to_str().unwrap(), &candidates).unwrap(),
                Some(0)
            );
        } else {
            // Case-sensitive volume: both names can back independent buffers.
            fs::write(&lower, "distinct").unwrap();
            assert_eq!(
                super::find_same_file_blocking(lower.to_str().unwrap(), &candidates).unwrap(),
                None
            );
            assert_eq!(fs::read(&first).unwrap(), b"first");
        }
        dir.close().unwrap();
    }

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
        assert!(
            m.is_match("obj/"),
            "but `name/` does (how read_dir tests dirs)"
        );
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

    #[test]
    fn workspace_relative_computes_forward_slashed_relative_path() {
        let root = if cfg!(windows) {
            r"C:\src\App"
        } else {
            "/src/App"
        };
        let entry = if cfg!(windows) {
            r"C:\src\App\src\generated"
        } else {
            "/src/App/src/generated"
        };
        assert_eq!(
            workspace_relative(Path::new(entry), Some(root)).as_deref(),
            Some("src/generated")
        );
        // No root → None (only basename patterns apply).
        assert_eq!(workspace_relative(Path::new(entry), None), None);
        // The root itself is not "relative to itself".
        assert_eq!(workspace_relative(Path::new(root), Some(root)), None);
        // An entry outside the root → None.
        let outside = if cfg!(windows) {
            r"C:\other\x"
        } else {
            "/other/x"
        };
        assert_eq!(workspace_relative(Path::new(outside), Some(root)), None);
        // A SIBLING sharing the root's prefix is NOT under it (directory boundary).
        let sibling = if cfg!(windows) {
            r"C:\src\AppOther\x"
        } else {
            "/src/AppOther/x"
        };
        assert_eq!(
            workspace_relative(Path::new(sibling), Some(root)),
            None,
            "shared-prefix sibling must not be treated as a descendant"
        );
    }

    #[test]
    fn exclude_matcher_handles_prefix_anchored_patterns() {
        // Prefix-anchored patterns (no leading `**`) only match the
        // workspace-relative path, which is exactly what `read_dir` now feeds.
        let m = build_exclude_matcher(&["src/generated".to_string(), "foo/bar/**".to_string()])
            .expect("matcher");
        // Bare name `generated` (read at the root) does NOT match — correct, since
        // the pattern is anchored at `src/`.
        assert!(!m.is_match("generated"));
        // The workspace-relative path does match.
        assert!(m.is_match("src/generated"));
        assert!(m.is_match("foo/bar/baz.cs"));
        // A `generated` dir under a different parent is NOT hidden.
        assert!(!m.is_match("docs/generated"));
    }

    fn workspace() -> tempfile::TempDir {
        // Clock precision does not guarantee unique names in parallel tests.
        // Own the directory so failures also clean up only this fixture.
        tempfile::Builder::new()
            .prefix("fluent-coder-explorer-")
            .tempdir()
            .unwrap()
    }

    #[test]
    fn creates_file_without_overwriting() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let created = create_file(root_text.clone(), root_text.clone(), "novo.txt".into()).unwrap();
        assert_eq!(created.name, "novo.txt");
        assert!(!created.is_dir);
        assert!(create_file(root_text.clone(), root_text, "novo.txt".into()).is_err());
        workspace_dir.close().unwrap();
    }

    #[test]
    fn creates_single_folder_and_rejects_paths() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let created = create_folder(root_text.clone(), root_text.clone(), "src".into()).unwrap();
        assert!(created.is_dir);
        assert!(create_folder(root_text.clone(), root_text, "../fora".into()).is_err());
        workspace_dir.close().unwrap();
    }

    #[test]
    fn rejects_windows_reserved_or_invalid_names() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let reserved: &[&str] = if cfg!(windows) { &["CON", "aux.txt"] } else { &[] };
        for name in reserved.iter().copied().chain(["nome.", "nome ", "a/b"]) {
            assert!(
                create_file(root_text.clone(), root_text.clone(), name.into()).is_err(),
                "{name} deveria ser rejeitado"
            );
        }
        workspace_dir.close().unwrap();
    }

    #[test]
    fn windows_device_names_are_detected_case_insensitively_by_stem() {
        assert!(super::is_windows_reserved_stem("CON"));
        assert!(super::is_windows_reserved_stem("LPT9"));
        assert!(!super::is_windows_reserved_stem("CONSOLE"));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_allows_windows_device_names() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        assert!(create_file(root_text.clone(), root_text, "con.txt".into()).is_ok());
        workspace_dir.close().unwrap();
    }

    #[test]
    fn binary_sniff_and_probe() {
        assert!(looks_binary(b"MZ\x90\x00\x03"));
        assert!(!looks_binary(b"fn main() {}\n"));
        assert!(!looks_binary(&[0xFF, 0xFE, b'a', 0, b'b', 0]), "UTF-16 LE com BOM é texto");
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let bin = root.join("a.bin");
        fs::write(&bin, [1u8, 2, 0, 4]).unwrap();
        let txt = root.join("a.txt");
        fs::write(&txt, "olá").unwrap();
        let p = probe_file_blocking(&bin.to_string_lossy()).unwrap();
        assert!(p.binary && p.size == 4);
        let p = probe_file_blocking(&txt.to_string_lossy()).unwrap();
        assert!(!p.binary);
        assert!(probe_file_blocking(&root.to_string_lossy()).is_err(), "pasta não é arquivo");
        workspace_dir.close().unwrap();
    }

    #[test]
    fn huge_files_need_explicit_consent() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let big = root.join("big.log");
        let f = fs::File::create(&big).unwrap();
        // Sparse file: no real disk use.
        f.set_len(HUGE_FILE_BYTES + 1).unwrap();
        let err = read_file_blocking(&big.to_string_lossy(), false).unwrap_err();
        assert!(err.starts_with("FILE_TOO_LARGE:"), "{err}");
        let small = root.join("s.txt");
        fs::write(&small, "x\r\ny").unwrap();
        assert_eq!(read_file_blocking(&small.to_string_lossy(), false).unwrap().content, "x\ny");
        workspace_dir.close().unwrap();
    }

    #[test]
    fn renames_file_and_rejects_collision() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let a = create_file(root_text.clone(), root_text.clone(), "a.txt".into()).unwrap();
        create_file(root_text.clone(), root_text.clone(), "b.txt".into()).unwrap();

        let renamed = rename_path(root_text.clone(), a.path.clone(), "c.txt".into()).unwrap();
        assert_eq!(renamed.name, "c.txt");
        assert!(!Path::new(&a.path).exists());
        assert!(Path::new(&renamed.path).exists());

        // Renaming onto an existing name must be rejected (no overwrite).
        assert!(rename_path(root_text.clone(), renamed.path, "b.txt".into()).is_err());
        workspace_dir.close().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn serializes_renamed_paths_without_windows_extended_prefix() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let file = create_file(root_text.clone(), root_text.clone(), "before.txt".into()).unwrap();

        let renamed = rename_path(root_text, file.path, "after.txt".into()).unwrap();

        assert!(
            !renamed.path.starts_with(r"\\?\"),
            "o frontend não deve receber caminho estendido: {}",
            renamed.path
        );
        workspace_dir.close().unwrap();
    }

    #[test]
    fn copies_file_with_collision_suffix() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let f = create_file(root_text.clone(), root_text.clone(), "doc.txt".into()).unwrap();
        fs::write(&f.path, "hello").unwrap();

        // Copy into the same parent → collision resolved with a suffix.
        let copied = copy_path(root_text.clone(), f.path.clone(), root_text.clone()).unwrap();
        assert_ne!(copied.path, f.path);
        assert!(copied.name.contains("Cópia"));
        assert_eq!(fs::read_to_string(&copied.path).unwrap(), "hello");
        assert!(Path::new(&f.path).exists(), "origem deve permanecer");
        workspace_dir.close().unwrap();
    }

    #[test]
    fn copies_folder_recursively() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        let dir = create_folder(root_text.clone(), root_text.clone(), "pasta".into()).unwrap();
        create_file(root_text.clone(), dir.path.clone(), "inner.txt".into()).unwrap();
        let dest = create_folder(root_text.clone(), root_text.clone(), "destino".into()).unwrap();

        let copied = copy_path(root_text.clone(), dir.path.clone(), dest.path.clone()).unwrap();
        assert!(copied.is_dir);
        assert!(Path::new(&copied.path).join("inner.txt").exists());
        assert!(Path::new(&dir.path).exists(), "origem deve permanecer");
        workspace_dir.close().unwrap();
    }

    #[test]
    fn moves_file_and_folder() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
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
        workspace_dir.close().unwrap();
    }

    #[test]
    fn rejects_operations_outside_workspace() {
        let workspace_dir = workspace();
        let root = workspace_dir.path();
        let root_text = root.to_string_lossy().to_string();
        // A sibling temp dir, definitely outside `root`.
        let outside_dir = workspace();
        let outside = outside_dir.path();
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
        workspace_dir.close().unwrap();
        outside_dir.close().unwrap();
    }
}
