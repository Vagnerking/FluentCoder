use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;

const FLUENT_WORKSPACE_EXTENSION: &str = ".fluent-workspace";
const CODE_WORKSPACE_EXTENSION: &str = ".code-workspace";

#[derive(Default)]
pub struct WorkspaceOpenState(Mutex<Vec<String>>);

impl WorkspaceOpenState {
    pub fn new(paths: Vec<String>) -> Self {
        Self(Mutex::new(paths))
    }
}

#[tauri::command]
pub fn opened_workspace_files(state: State<WorkspaceOpenState>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|paths| paths.clone())
        .unwrap_or_default()
}

pub fn workspace_files_from_args(args: &[String]) -> Vec<String> {
    let mut paths: Vec<String> = args
        .iter()
        .skip(1)
        .filter_map(|arg| normalize_workspace_arg(arg))
        .collect();
    dedupe_preserving_order(&mut paths);
    paths
}

fn normalize_workspace_arg(value: &str) -> Option<String> {
    normalize_workspace_arg_for(value, crate::platform::Os::host())
}

/// Accepts a plain path or a `file://` URI (file association / deep link) and
/// keeps it only if it names a workspace file. URIs go through
/// `platform::file_uri_to_path`, so `file:///home/u/a.code-workspace` stays
/// ABSOLUTE on Linux/macOS (the old `strip_prefix("file:///")` produced the
/// relative `home/u/…`) and every `%XX` is decoded, not just `%20`.
fn normalize_workspace_arg_for(value: &str, os: crate::platform::Os) -> Option<String> {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.starts_with("--") {
        return None;
    }
    let path = if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("file://") {
        crate::platform::file_uri_to_path(trimmed, os)?
    } else {
        PathBuf::from(trimmed)
    };
    let text = path.to_string_lossy().to_string();
    let lower = text.to_ascii_lowercase();
    if !lower.ends_with(FLUENT_WORKSPACE_EXTENSION) && !lower.ends_with(CODE_WORKSPACE_EXTENSION) {
        return None;
    }
    Some(text)
}

fn dedupe_preserving_order(paths: &mut Vec<String>) {
    let insensitive = crate::platform::current().capabilities().paths_case_insensitive;
    dedupe_preserving_order_with(paths, insensitive);
}

/// Dedup by path, ignoring case only where the filesystem does (Windows,
/// macOS). On Linux `A.code-workspace` and `a.code-workspace` are two files.
fn dedupe_preserving_order_with(paths: &mut Vec<String>, case_insensitive: bool) {
    let mut seen = Vec::<String>::new();
    paths.retain(|path| {
        let key = if case_insensitive { path.to_lowercase() } else { path.clone() };
        if seen.iter().any(|item| item == &key) {
            false
        } else {
            seen.push(key);
            true
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn extracts_workspace_args() {
        let args = vec![
            "fluent-coder.exe".to_string(),
            "--new".to_string(),
            "C:\\work\\client.fluent-workspace".to_string(),
            "C:\\work\\notes.txt".to_string(),
            "file:///C:/work/legacy.code-workspace".to_string(),
        ];

        assert_eq!(
            workspace_files_from_args(&args),
            vec![
                "C:\\work\\client.fluent-workspace".to_string(),
                "C:\\work\\legacy.code-workspace".to_string(),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn dedupes_case_insensitively() {
        let args = vec![
            "fluent-coder.exe".to_string(),
            "C:\\work\\CLIENT.fluent-workspace".to_string(),
            "c:\\work\\client.fluent-workspace".to_string(),
        ];

        assert_eq!(
            workspace_files_from_args(&args),
            vec!["C:\\work\\CLIENT.fluent-workspace".to_string()]
        );
    }

    #[test]
    fn file_uris_become_absolute_unix_paths() {
        use crate::platform::Os;
        for os in [Os::Linux, Os::Macos] {
            assert_eq!(
                normalize_workspace_arg_for("file:///home/u/My%20Work/a%2Bb.code-workspace", os).as_deref(),
                Some("/home/u/My Work/a+b.code-workspace")
            );
            assert_eq!(normalize_workspace_arg_for("/home/u/x.fluent-workspace", os).as_deref(), Some("/home/u/x.fluent-workspace"));
            assert_eq!(normalize_workspace_arg_for("file:///home/u/notes.txt", os), None);
            assert_eq!(normalize_workspace_arg_for("file://remote/x.code-workspace", os), None);
        }
    }

    #[test]
    fn file_uris_become_windows_drive_paths() {
        use crate::platform::Os;
        let p = normalize_workspace_arg_for("file:///c%3A/work/legacy.code-workspace", Os::Windows).unwrap();
        assert!(p.starts_with("C:"), "{p}");
        assert!(p.ends_with("legacy.code-workspace"), "{p}");
    }

    #[test]
    fn dedup_respects_filesystem_case_rules() {
        let mut a = vec!["/w/A.code-workspace".to_string(), "/w/a.code-workspace".to_string()];
        dedupe_preserving_order_with(&mut a, false);
        assert_eq!(a.len(), 2, "Linux: nomes que só diferem na caixa são arquivos distintos");
        dedupe_preserving_order_with(&mut a, true);
        assert_eq!(a, vec!["/w/A.code-workspace".to_string()]);
    }
}
