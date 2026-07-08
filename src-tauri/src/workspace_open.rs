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
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.starts_with("--") {
        return None;
    }
    let path = trimmed
        .strip_prefix("file:///")
        .or_else(|| trimmed.strip_prefix("file://"))
        .unwrap_or(trimmed);
    let path = path.replace("%20", " ");
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(FLUENT_WORKSPACE_EXTENSION) && !lower.ends_with(CODE_WORKSPACE_EXTENSION) {
        return None;
    }
    Some(PathBuf::from(path).to_string_lossy().to_string())
}

fn dedupe_preserving_order(paths: &mut Vec<String>) {
    let mut seen = Vec::<String>::new();
    paths.retain(|path| {
        let key = path.to_ascii_lowercase();
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
                "C:/work/legacy.code-workspace".to_string(),
            ]
        );
    }

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
}
