use crate::walk::is_skipped_dir;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{sinks, BinaryDetection, SearcherBuilder};
use ignore::{DirEntry, WalkBuilder};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tauri::State;

const MAX_RESULTS: usize = 500;
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;

pub struct SearchState {
    generation: Arc<AtomicU64>,
}

impl SearchState {
    pub fn new() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    path: String,
    name: String,
    line: u64,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    matches: Vec<SearchMatch>,
    limit_hit: bool,
    cancelled: bool,
    elapsed_ms: u128,
}

#[tauri::command]
pub fn cancel_search(state: State<'_, SearchState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

/// Runs outside Tauri's command thread. The walker honors ignore files and the
/// searcher scans incrementally with binary and file-size guards.
#[tauri::command]
pub async fn search_in_dir(
    state: State<'_, SearchState>,
    root: String,
    query: String,
) -> Result<SearchResponse, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(SearchResponse {
            matches: Vec::new(),
            limit_hit: false,
            cancelled: false,
            elapsed_ms: 0,
        });
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let shared_generation = Arc::clone(&state.generation);

    tauri::async_runtime::spawn_blocking(move || {
        run_search(PathBuf::from(root), query, generation, shared_generation)
    })
    .await
    .map_err(|error| format!("Falha ao executar a pesquisa: {error}"))?
}

fn run_search(
    root: PathBuf,
    query: String,
    generation: u64,
    shared_generation: Arc<AtomicU64>,
) -> Result<SearchResponse, String> {
    let started = Instant::now();
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(true)
        .build(&regex::escape(&query))
        .map_err(|error| format!("Consulta inválida: {error}"))?;
    let mut matches = Vec::new();
    let mut limit_hit = false;

    let mut builder = WalkBuilder::new(&root);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(should_visit);

    for entry in builder.build().flatten() {
        if is_cancelled(generation, &shared_generation) {
            return Ok(response(matches, limit_hit, true, started));
        }
        if matches.len() >= MAX_RESULTS {
            limit_hit = true;
            break;
        }
        if !is_searchable_file(&entry) {
            continue;
        }

        // Files may disappear or become unreadable during a scan.
        let _ = search_file(
            entry.path(),
            &matcher,
            &mut matches,
            generation,
            &shared_generation,
        );
        if matches.len() >= MAX_RESULTS {
            limit_hit = true;
            break;
        }
    }

    let cancelled = is_cancelled(generation, &shared_generation);
    Ok(response(matches, limit_hit, cancelled, started))
}

fn should_visit(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_some_and(|kind| kind.is_dir()) {
        return true;
    }
    !is_skipped_dir(&entry.file_name().to_string_lossy())
}

fn is_searchable_file(entry: &DirEntry) -> bool {
    if !entry.file_type().is_some_and(|kind| kind.is_file()) {
        return false;
    }
    entry
        .metadata()
        .map(|metadata| metadata.len() <= MAX_FILE_SIZE)
        .unwrap_or(false)
}

fn search_file(
    path: &Path,
    matcher: &grep_regex::RegexMatcher,
    out: &mut Vec<SearchMatch>,
    generation: u64,
    shared_generation: &AtomicU64,
) -> Result<(), String> {
    let path_text = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path_text.clone());
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\0'))
        .build();

    searcher
        .search_path(
            matcher,
            path,
            sinks::Lossy(|line_number, line| {
                if is_cancelled(generation, shared_generation) || out.len() >= MAX_RESULTS {
                    return Ok(false);
                }
                out.push(SearchMatch {
                    path: path_text.clone(),
                    name: name.clone(),
                    line: line_number,
                    text: line.trim_end().chars().take(400).collect(),
                });
                Ok(true)
            }),
        )
        .map_err(|error| format!("Falha ao pesquisar '{}': {error}", path.display()))
}

fn is_cancelled(generation: u64, shared_generation: &AtomicU64) -> bool {
    shared_generation.load(Ordering::Relaxed) != generation
}

fn response(
    matches: Vec<SearchMatch>,
    limit_hit: bool,
    cancelled: bool,
    started: Instant,
) -> SearchResponse {
    SearchResponse {
        matches,
        limit_hit,
        cancelled,
        elapsed_ms: started.elapsed().as_millis(),
    }
}

#[cfg(test)]
mod tests {
    use super::{run_search, MAX_RESULTS};
    use std::fs;
    use std::sync::{atomic::AtomicU64, Arc};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn workspace() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("code-editor-search-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn searches_text_and_respects_gitignore() {
        let root = workspace();
        fs::write(root.join("visible.txt"), "alpha\nNeedle here\nomega").unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/hidden.txt"), "needle").unwrap();
        let response = run_search(
            root.clone(),
            "needle".into(),
            1,
            Arc::new(AtomicU64::new(1)),
        )
        .unwrap();
        assert_eq!(response.matches.len(), 1);
        assert_eq!(response.matches[0].line, 2);
        assert!(!response.limit_hit);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stops_immediately_when_generation_is_cancelled() {
        let root = workspace();
        fs::write(root.join("visible.txt"), "needle").unwrap();
        let response = run_search(
            root.clone(),
            "needle".into(),
            1,
            Arc::new(AtomicU64::new(2)),
        )
        .unwrap();
        assert!(response.cancelled);
        assert!(response.matches.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caps_broad_queries_before_they_flood_the_frontend() {
        let root = workspace();
        let content = (0..(MAX_RESULTS + 20))
            .map(|index| format!("needle {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("many.txt"), content).unwrap();
        let response = run_search(
            root.clone(),
            "needle".into(),
            1,
            Arc::new(AtomicU64::new(1)),
        )
        .unwrap();
        assert_eq!(response.matches.len(), MAX_RESULTS);
        assert!(response.limit_hit);
        fs::remove_dir_all(root).unwrap();
    }
}
