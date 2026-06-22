use crate::walk::is_skipped_dir;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{sinks, BinaryDetection, SearcherBuilder};
use ignore::overrides::{Override, OverrideBuilder};
use ignore::{DirEntry, WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

/// Hard ceiling on total matches streamed for one query. Generous because
/// streaming delivers results incrementally — the UI never receives them all at
/// once — but still bounded so a `.` regex over a huge tree can't run forever.
const MAX_RESULTS: usize = 10_000;
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
/// Longest line we send to the UI (and the cap match ranges are clamped to).
const MAX_LINE_CHARS: usize = 400;
/// How long a built file index stays fresh before the next search rebuilds it.
/// Long enough that a burst of keystrokes reuses it (instant), short enough that
/// newly-created files show up quickly without an explicit invalidation.
const INDEX_TTL: Duration = Duration::from_secs(10);

/// A cached list of searchable file paths for one workspace root. Building it
/// (the directory walk + ignore-file parsing) is the expensive part of a search;
/// caching it makes repeated queries — i.e. typing — feel instant. The per-query
/// glob filters are applied cheaply in memory on top of this list.
struct FileIndex {
    root: PathBuf,
    files: Arc<Vec<PathBuf>>,
    built_at: Instant,
}

#[derive(Clone)]
struct WindowSearchState {
    generation: Arc<AtomicU64>,
    index: Arc<Mutex<Option<FileIndex>>>,
}

pub struct SearchState {
    windows: Mutex<HashMap<String, WindowSearchState>>,
}

impl SearchState {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    fn for_window(&self, label: &str) -> WindowSearchState {
        self.windows
            .lock()
            .expect("search window state poisoned")
            .entry(label.to_string())
            .or_insert_with(|| WindowSearchState {
                generation: Arc::new(AtomicU64::new(0)),
                index: Arc::new(Mutex::new(None)),
            })
            .clone()
    }
}

/// Toggles + glob filters mirroring VSCode's search box. Deserialized from the
/// frontend `SearchOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// Treat the query as a regular expression instead of a literal string.
    pub regex: bool,
    /// Case-sensitive match (default is case-insensitive).
    pub case_sensitive: bool,
    /// Match whole words only (adds word boundaries, like ripgrep `-w`).
    pub whole_word: bool,
    /// "files to include" globs (whitelist). Empty = everything.
    #[serde(default)]
    pub include_globs: Vec<String>,
    /// "files to exclude" globs (blacklist), applied on top of includes.
    #[serde(default)]
    pub exclude_globs: Vec<String>,
}

/// One matching line within a file, with the column ranges that matched so the
/// UI can highlight the term. Ranges are char offsets into `text`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    line: u64,
    text: String,
    ranges: Vec<[u32; 2]>,
}

/// All matches found in a single file, streamed as one event so the UI can
/// render the file group in one shot.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    path: String,
    name: String,
    matches: Vec<LineMatch>,
}

/// Streaming search events delivered over the request-scoped `Channel`. `Matches`
/// arrives once per file with hits; `Done` closes the stream with a summary.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    Matches {
        file: FileMatches,
    },
    Done {
        limit_hit: bool,
        cancelled: bool,
        // u64 (not u128): the IPC layer's JSON serialization doesn't round-trip
        // u128 cleanly, which surfaced as "undefined ms" in the UI.
        elapsed_ms: u64,
        total_matches: usize,
        total_files: usize,
    },
}

#[tauri::command]
pub fn cancel_search(window: tauri::Window, state: State<'_, SearchState>) {
    state
        .for_window(window.label())
        .generation
        .fetch_add(1, Ordering::SeqCst);
}

/// Pre-builds (warms) the file index for `root` so the first search is instant.
/// Called when a folder is opened. No-op work if the index is already fresh.
#[tauri::command]
pub async fn build_search_index(
    window: tauri::Window,
    state: State<'_, SearchState>,
    root: String,
) -> Result<(), String> {
    let index = state.for_window(window.label()).index;
    let root = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_index(&index, &root);
    })
    .await
    .map_err(|error| format!("Falha ao indexar: {error}"))
}

/// Runs outside Tauri's command thread. Searches the cached file index (rebuilt
/// when stale) in parallel and streams matches per file over `on_event` as
/// they're found. Honors `.gitignore`, the fixed `SKIP_DIRS` heavy-folder list
/// and the user's include/exclude globs.
#[tauri::command]
pub async fn search_in_dir(
    window: tauri::Window,
    state: State<'_, SearchState>,
    root: String,
    query: String,
    options: SearchOptions,
    on_event: Channel<SearchEvent>,
) -> Result<(), String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        let _ = on_event.send(SearchEvent::Done {
            limit_hit: false,
            cancelled: false,
            elapsed_ms: 0,
            total_matches: 0,
            total_files: 0,
        });
        return Ok(());
    }

    // Bumping the generation invalidates any in-flight search; this one owns the
    // new value and every worker checks it to bail out the moment a newer search
    // (or an explicit cancel) starts.
    let window_state = state.for_window(window.label());
    let generation = window_state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let shared_generation = window_state.generation;
    let index = window_state.index;
    let root = PathBuf::from(root);

    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let matcher = build_matcher(&query, &options)?;
        let overrides = build_overrides_opt(&root, &options)?;
        let files = ensure_index(&index, &root);

        let emit = move |event: SearchEvent| {
            let _ = on_event.send(event);
        };
        let summary = search_paths(
            &files,
            &root,
            &matcher,
            overrides.as_ref(),
            generation,
            &shared_generation,
            &emit,
        );
        let cancelled = shared_generation.load(Ordering::Relaxed) != generation;
        emit(SearchEvent::Done {
            limit_hit: summary.limit_hit,
            cancelled,
            elapsed_ms: started.elapsed().as_millis() as u64,
            total_matches: summary.total_matches,
            total_files: summary.total_files,
        });
        Ok(())
    })
    .await
    .map_err(|error| format!("Falha ao executar a pesquisa: {error}"))?
}

/// Returns the cached file list for `root`, rebuilding it when missing, stale or
/// pointing at a different root.
fn ensure_index(index: &Mutex<Option<FileIndex>>, root: &Path) -> Arc<Vec<PathBuf>> {
    {
        let guard = index.lock().unwrap();
        if let Some(existing) = guard.as_ref() {
            if existing.root == root && existing.built_at.elapsed() < INDEX_TTL {
                return Arc::clone(&existing.files);
            }
        }
    }
    // Build outside the lock so a slow walk doesn't block other commands.
    let files = Arc::new(collect_files(root));
    let mut guard = index.lock().unwrap();
    *guard = Some(FileIndex {
        root: root.to_path_buf(),
        files: Arc::clone(&files),
        built_at: Instant::now(),
    });
    files
}

/// Walks `root` in parallel and collects every searchable file path, honoring
/// ignore files and the fixed heavy-folder skip list. This is the cached part.
fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .require_git(false)
        .follow_links(false)
        .threads(0)
        .filter_entry(should_visit);

    let files = Mutex::new(Vec::new());
    builder.build_parallel().run(|| {
        Box::new(|result| {
            if let Ok(entry) = result {
                if is_searchable_file(&entry) {
                    files.lock().unwrap().push(entry.into_path());
                }
            }
            WalkState::Continue
        })
    });
    files.into_inner().unwrap()
}

struct Summary {
    total_matches: usize,
    total_files: usize,
    limit_hit: bool,
}

/// Searches `files` in parallel (a fixed worker pool over a shared cursor),
/// applying the per-query glob `overrides` cheaply in memory, and streams a
/// `Matches` event per file with hits. Stops on cancellation or the match cap.
fn search_paths<E>(
    files: &[PathBuf],
    root: &Path,
    matcher: &RegexMatcher,
    overrides: Option<&Override>,
    generation: u64,
    shared_generation: &AtomicU64,
    emit: &E,
) -> Summary
where
    E: Fn(SearchEvent) + Sync,
{
    let total_matches = AtomicUsize::new(0);
    let total_files = AtomicUsize::new(0);
    let limit_hit = AtomicBool::new(false);
    let cursor = AtomicUsize::new(0);

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(files.len().max(1));

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if shared_generation.load(Ordering::Relaxed) != generation {
                    break;
                }
                if total_matches.load(Ordering::Relaxed) >= MAX_RESULTS {
                    limit_hit.store(true, Ordering::Relaxed);
                    break;
                }
                let i = cursor.fetch_add(1, Ordering::Relaxed);
                if i >= files.len() {
                    break;
                }
                let path = &files[i];

                if let Some(ov) = overrides {
                    let rel = path.strip_prefix(root).unwrap_or(path);
                    if ov.matched(rel, false).is_ignore() {
                        continue;
                    }
                }

                let line_matches = search_file(
                    path,
                    matcher,
                    &total_matches,
                    generation,
                    shared_generation,
                );
                if line_matches.is_empty() {
                    continue;
                }

                let added = line_matches.len();
                let previous = total_matches.fetch_add(added, Ordering::Relaxed);
                total_files.fetch_add(1, Ordering::Relaxed);

                let path_text = path.to_string_lossy().to_string();
                let name = path
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_text.clone());
                emit(SearchEvent::Matches {
                    file: FileMatches {
                        path: path_text,
                        name,
                        matches: line_matches,
                    },
                });

                if previous + added >= MAX_RESULTS {
                    limit_hit.store(true, Ordering::Relaxed);
                    break;
                }
            });
        }
    });

    Summary {
        total_matches: total_matches.load(Ordering::Relaxed),
        total_files: total_files.load(Ordering::Relaxed),
        limit_hit: limit_hit.load(Ordering::Relaxed),
    }
}

/// Builds the regex matcher from the query + toggles. Returns `Err` for an
/// invalid regex so the caller (and ultimately the UI) can flag the input.
fn build_matcher(query: &str, options: &SearchOptions) -> Result<RegexMatcher, String> {
    let pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .word(options.whole_word)
        .build(&pattern)
        .map_err(|error| format!("Consulta inválida: {error}"))
}

/// A glob without a path separator matches at any depth (VSCode-style), so
/// `*.ts` becomes `**/*.ts`. Patterns that already contain `/` are left as-is.
fn normalize_glob(glob: &str) -> String {
    let glob = glob.trim();
    if glob.contains('/') {
        glob.to_string()
    } else {
        format!("**/{glob}")
    }
}

/// `Some(overrides)` when the query has include/exclude globs, else `None`.
fn build_overrides_opt(
    root: &Path,
    options: &SearchOptions,
) -> Result<Option<Override>, String> {
    if options.include_globs.is_empty() && options.exclude_globs.is_empty() {
        return Ok(None);
    }
    let mut builder = OverrideBuilder::new(root);
    for glob in &options.include_globs {
        if glob.trim().is_empty() {
            continue;
        }
        builder
            .add(&normalize_glob(glob))
            .map_err(|error| format!("Padrão de inclusão inválido '{glob}': {error}"))?;
    }
    for glob in &options.exclude_globs {
        if glob.trim().is_empty() {
            continue;
        }
        builder
            .add(&format!("!{}", normalize_glob(glob)))
            .map_err(|error| format!("Padrão de exclusão inválido '{glob}': {error}"))?;
    }
    builder
        .build()
        .map(Some)
        .map_err(|error| format!("Filtros de glob inválidos: {error}"))
}

/// Keep the fixed heavy-folder skip list (`node_modules`, `target`, …) on top of
/// the ignore-file handling. The root and every non-directory always pass.
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

/// Scans one file and returns its matching lines (with highlight ranges). Stops
/// early on cancellation or once the global match budget is exhausted.
fn search_file(
    path: &Path,
    matcher: &RegexMatcher,
    total_matches: &AtomicUsize,
    generation: u64,
    shared_generation: &AtomicU64,
) -> Vec<LineMatch> {
    let mut out: Vec<LineMatch> = Vec::new();
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .binary_detection(BinaryDetection::quit(b'\0'))
        .build();

    let _ = searcher.search_path(
        matcher,
        path,
        sinks::Lossy(|line_number, line| {
            if shared_generation.load(Ordering::Relaxed) != generation {
                return Ok(false);
            }
            // Approximate budget check: other workers may also be adding, so the
            // total can overshoot slightly, but the run still stops promptly.
            if total_matches.load(Ordering::Relaxed) + out.len() >= MAX_RESULTS {
                return Ok(false);
            }
            let ranges = match_ranges(matcher, line);
            let text: String = line.trim_end().chars().take(MAX_LINE_CHARS).collect();
            out.push(LineMatch {
                line: line_number,
                text,
                ranges,
            });
            Ok(true)
        }),
    );
    out
}

/// Locates every match within a single line and returns char-offset ranges,
/// clamped to the displayed line length (`MAX_LINE_CHARS`).
fn match_ranges(matcher: &RegexMatcher, line: &str) -> Vec<[u32; 2]> {
    let mut ranges = Vec::new();
    let bytes = line.as_bytes();
    let _ = matcher.find_iter(bytes, |m| {
        // Byte offsets → char offsets so the JS side can slice the string.
        let start = line[..m.start()].chars().count();
        let end = line[..m.end()].chars().count();
        if start < MAX_LINE_CHARS {
            ranges.push([start as u32, end.min(MAX_LINE_CHARS) as u32]);
        }
        true
    });
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn workspace() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("fluent-coder-search-{nonce}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    struct Outcome {
        files: Vec<FileMatches>,
        limit_hit: bool,
        cancelled: bool,
        total_matches: usize,
    }

    /// Runs a one-shot search (no index cache) and collects the streamed events.
    fn collect(
        root: PathBuf,
        query: &str,
        options: SearchOptions,
        generation: u64,
        shared: u64,
    ) -> Result<Outcome, String> {
        let started = Instant::now();
        let matcher = build_matcher(query, &options)?;
        let overrides = build_overrides_opt(&root, &options)?;
        let files = collect_files(&root);
        let shared_generation = Arc::new(AtomicU64::new(shared));

        let events: Mutex<Vec<SearchEvent>> = Mutex::new(Vec::new());
        let summary = {
            let emit = |event: SearchEvent| events.lock().unwrap().push(event);
            search_paths(
                &files,
                &root,
                &matcher,
                overrides.as_ref(),
                generation,
                &shared_generation,
                &emit,
            )
        };
        let cancelled = shared_generation.load(Ordering::Relaxed) != generation;
        let _ = started;

        let mut out_files = Vec::new();
        for event in events.into_inner().unwrap() {
            if let SearchEvent::Matches { file } = event {
                out_files.push(file);
            }
        }
        Ok(Outcome {
            files: out_files,
            limit_hit: summary.limit_hit,
            cancelled,
            total_matches: summary.total_matches,
        })
    }

    fn total_lines(files: &[FileMatches]) -> usize {
        files.iter().map(|f| f.matches.len()).sum()
    }

    #[test]
    fn searches_text_and_respects_gitignore() {
        let root = workspace();
        fs::write(root.join("visible.txt"), "alpha\nNeedle here\nomega").unwrap();
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/hidden.txt"), "needle").unwrap();
        let outcome = collect(root.clone(), "needle", SearchOptions::default(), 1, 1).unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        assert_eq!(outcome.files[0].matches[0].line, 2);
        assert!(!outcome.limit_hit);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_heavy_dirs_even_when_not_gitignored() {
        let root = workspace();
        fs::write(root.join("app.txt"), "needle").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/dep.txt"), "needle").unwrap();
        let outcome = collect(root.clone(), "needle", SearchOptions::default(), 1, 1).unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn case_sensitive_excludes_other_casings() {
        let root = workspace();
        fs::write(root.join("a.txt"), "Needle\nneedle").unwrap();
        let insensitive = collect(root.clone(), "needle", SearchOptions::default(), 1, 1).unwrap();
        assert_eq!(total_lines(&insensitive.files), 2);
        let sensitive = collect(
            root.clone(),
            "needle",
            SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(total_lines(&sensitive.files), 1);
        assert_eq!(sensitive.files[0].matches[0].line, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn whole_word_only_matches_bounded_words() {
        let root = workspace();
        fs::write(root.join("a.txt"), "needle\nneedles").unwrap();
        let outcome = collect(
            root.clone(),
            "needle",
            SearchOptions {
                whole_word: true,
                ..Default::default()
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        assert_eq!(outcome.files[0].matches[0].line, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn regex_mode_uses_query_as_pattern() {
        let root = workspace();
        fs::write(root.join("a.txt"), "foo123\nfooxyz").unwrap();
        let outcome = collect(
            root.clone(),
            r"foo\d+",
            SearchOptions {
                regex: true,
                ..Default::default()
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        assert_eq!(outcome.files[0].matches[0].line, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn literal_mode_does_not_treat_query_as_regex() {
        let root = workspace();
        fs::write(root.join("a.txt"), "a.b\naxb").unwrap();
        // Literal "a.b" must match only the dotted line, not "axb".
        let outcome = collect(root.clone(), "a.b", SearchOptions::default(), 1, 1).unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        assert_eq!(outcome.files[0].matches[0].line, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_regex_returns_error() {
        let root = workspace();
        fs::write(root.join("a.txt"), "anything").unwrap();
        let result = collect(
            root.clone(),
            "(unclosed",
            SearchOptions {
                regex: true,
                ..Default::default()
            },
            1,
            1,
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn include_globs_restrict_to_whitelist() {
        let root = workspace();
        fs::write(root.join("a.ts"), "needle").unwrap();
        fs::write(root.join("b.js"), "needle").unwrap();
        let outcome = collect(
            root.clone(),
            "needle",
            SearchOptions {
                include_globs: vec!["*.ts".into()],
                ..Default::default()
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        assert!(outcome.files[0].path.ends_with("a.ts"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exclude_globs_drop_matching_paths() {
        let root = workspace();
        fs::create_dir(root.join("test")).unwrap();
        fs::write(root.join("test/a.txt"), "needle").unwrap();
        fs::write(root.join("b.txt"), "needle").unwrap();
        let outcome = collect(
            root.clone(),
            "needle",
            SearchOptions {
                exclude_globs: vec!["test/**".into()],
                ..Default::default()
            },
            1,
            1,
        )
        .unwrap();
        assert_eq!(total_lines(&outcome.files), 1);
        assert!(outcome.files[0].path.ends_with("b.txt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_match_ranges_for_highlight() {
        let root = workspace();
        fs::write(root.join("a.txt"), "xx needle yy needle").unwrap();
        let outcome = collect(root.clone(), "needle", SearchOptions::default(), 1, 1).unwrap();
        let ranges = &outcome.files[0].matches[0].ranges;
        assert_eq!(ranges, &vec![[3, 9], [13, 19]]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stops_immediately_when_generation_is_cancelled() {
        let root = workspace();
        fs::write(root.join("visible.txt"), "needle").unwrap();
        // generation (1) differs from the shared counter (2): already cancelled.
        let outcome = collect(root.clone(), "needle", SearchOptions::default(), 1, 2).unwrap();
        assert!(outcome.cancelled);
        assert_eq!(total_lines(&outcome.files), 0);
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
        let outcome = collect(root.clone(), "needle", SearchOptions::default(), 1, 1).unwrap();
        assert_eq!(outcome.total_matches, MAX_RESULTS);
        assert!(outcome.limit_hit);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn index_is_reused_while_fresh_and_rebuilt_after_change() {
        let root = workspace();
        fs::write(root.join("a.txt"), "needle").unwrap();
        let index: Mutex<Option<FileIndex>> = Mutex::new(None);

        let first = ensure_index(&index, &root);
        assert_eq!(first.len(), 1);
        // A new file added now is NOT seen — the fresh index is reused.
        fs::write(root.join("b.txt"), "needle").unwrap();
        let cached = ensure_index(&index, &root);
        assert_eq!(cached.len(), 1);
        assert!(Arc::ptr_eq(&first, &cached));

        // Forcing the stored timestamp past the TTL triggers a rebuild.
        index.lock().unwrap().as_mut().unwrap().built_at = Instant::now() - INDEX_TTL - Duration::from_secs(1);
        let rebuilt = ensure_index(&index, &root);
        assert_eq!(rebuilt.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
