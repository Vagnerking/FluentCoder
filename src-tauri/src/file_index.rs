//! Builds the flat list of project files that powers Quick Open (Ctrl+P).
//!
//! Unlike `search_in_dir`, this never reads file contents — it only walks the
//! tree and collects paths. The fuzzy matching and ranking happen on the front
//! end; the backend just produces the index.
//!
//! Rules (shared with the content search so both agree on "project files"):
//! - `.gitignore` / `.ignore` / `.git/info/exclude` / global gitignore are
//!   honoured (the `ignore` crate, like ripgrep), even outside a git repo;
//! - the heavy dirs of `walk::SKIP_DIRS` (`node_modules`, `.git`, `target`,
//!   `dist`, …) and `walk::SKIP_REL_DIRS` (`.claude/worktrees`) are skipped;
//! - `files.exclude` + `search.exclude` globs from the front end are applied
//!   (defaults: VS Code's `search.exclude`, see `DEFAULT_SEARCH_EXCLUDE`);
//! - the size cap is explicit and REPORTED (`truncated`), never silent.
//!
//! The walk is parallel and runs on the blocking pool (`async` command +
//! `spawn_blocking`), never on the main thread.

use crate::walk::{is_skipped_dir, is_skipped_rel_dir};
use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

/// One file in the project index, as consumed by the Quick Open palette.
#[derive(Serialize, Debug, Clone)]
pub struct ProjectFile {
    /// Absolute path — what we hand back to the editor to open the file.
    path: String,
    /// File name, shown as the primary label (and matched with most weight).
    name: String,
    /// Path relative to `root`, normalized to `/`, shown dimmed next to the name.
    rel: String,
}

impl ProjectFile {
    /// Builds an entry from already-resolved parts (used by the remote/SSH lister).
    pub fn new(path: String, name: String, rel: String) -> Self {
        ProjectFile { path, name, rel }
    }
}

/// The index plus how it was bounded, so the UI can say so.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIndex {
    pub files: Vec<ProjectFile>,
    /// More files exist than `cap`; the list was cut.
    pub truncated: bool,
    /// The cap applied to this walk.
    pub cap: usize,
}

/// Default cap: big enough for real monorepos, small enough that the IPC
/// payload (≈ 230 B/file of JSON) stays around 10 MB. Configurable per call
/// (`fluent.quickOpen.maxFiles` on the front end), clamped to `MIN..=MAX`.
pub const DEFAULT_MAX_FILES: usize = 50_000;
const MIN_MAX_FILES: usize = 1_000;
const MAX_MAX_FILES: usize = 1_000_000;

/// VS Code's default `search.exclude` (Quick Open honours it too).
pub const DEFAULT_SEARCH_EXCLUDE: &[&str] = &["**/node_modules", "**/bower_components", "**/*.code-search"];

/// Compiles exclude globs (invalid ones are skipped, not fatal).
fn build_globs(patterns: &[String]) -> Option<globset::GlobSet> {
    let mut b = globset::GlobSetBuilder::new();
    let mut any = false;
    for p in patterns.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        if let Ok(g) = globset::Glob::new(p) {
            b.add(g);
            any = true;
        }
    }
    if any {
        b.build().ok()
    } else {
        None
    }
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        None
    } else {
        Some(rel)
    }
}

/// Excluded by name, relative path or glob? Directories are also tested with
/// a trailing `/` so subtree globs (`**/obj/**`) hide the folder itself.
fn excluded(rel: &str, name: &str, is_dir: bool, globs: Option<&globset::GlobSet>) -> bool {
    if is_dir && (is_skipped_dir(name) || is_skipped_rel_dir(rel)) {
        return true;
    }
    let Some(g) = globs else { return false };
    g.is_match(rel) || g.is_match(name) || (is_dir && (g.is_match(format!("{rel}/")) || g.is_match(format!("{name}/"))))
}

/// The walk itself (blocking). `exclude`: `files.exclude` + `search.exclude`
/// globs; `None` = `DEFAULT_SEARCH_EXCLUDE`.
pub fn build_index(root: &Path, exclude: Option<&[String]>, max_files: usize) -> ProjectIndex {
    let cap = max_files.clamp(MIN_MAX_FILES, MAX_MAX_FILES);
    let defaults: Vec<String> = DEFAULT_SEARCH_EXCLUDE.iter().map(|s| s.to_string()).collect();
    let globs = build_globs(exclude.unwrap_or(&defaults));
    let root_buf = root.to_path_buf();

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
        .threads(0);
    {
        let globs = globs.clone();
        let root = root_buf.clone();
        builder.filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            let name = entry.file_name().to_string_lossy();
            let Some(rel) = rel_of(&root, entry.path()) else { return true };
            !excluded(&rel, &name, is_dir, globs.as_ref())
        });
    }

    let files = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    builder.build_parallel().run(|| {
        Box::new(|result| {
            let Ok(entry) = result else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            if count.fetch_add(1, Ordering::Relaxed) >= cap {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = rel_of(&root_buf, path).unwrap_or_else(|| name.clone());
            let file = ProjectFile { path: path.to_string_lossy().to_string(), name, rel };
            files.lock().expect("index lock").push(file);
            WalkState::Continue
        })
    });
    let mut files = files.into_inner().expect("index lock");
    files.truncate(cap);
    // Parallel walk → nondeterministic order; sort for stable ranking ties.
    files.sort_unstable_by(|a, b| a.rel.cmp(&b.rel));
    ProjectIndex { files, truncated: truncated.load(Ordering::Relaxed), cap }
}

/// Walks `root` and returns its project files (see the module docs for the
/// rules), plus whether the cap cut the list.
#[tauri::command]
pub async fn list_project_files(
    root: String,
    exclude: Option<Vec<String>>,
    max_files: Option<usize>,
) -> Result<ProjectIndex, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = Path::new(&root);
        if !root_path.is_dir() {
            return Err(format!("não é um diretório: {root}"));
        }
        Ok(build_index(root_path, exclude.as_deref(), max_files.unwrap_or(DEFAULT_MAX_FILES)))
    })
    .await
    .map_err(|e| format!("list_project_files join error: {e}"))?
}

/// Whether `root` (or a non-skipped subdir, bounded depth) contains a `.sln` or
/// `.csproj`. Used to decide whether to warm-start the C# Roslyn on folder open.
///
/// `async` + `spawn_blocking`: the directory walk runs on the blocking pool, NEVER
/// the main thread, so opening a large folder can't stall the UI. Early-exits on
/// the first match, so the common case (solution at the root) returns instantly.
#[tauri::command]
pub async fn has_dotnet_project(root: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || find_dotnet(Path::new(&root), 0))
        .await
        .map_err(|e| format!("has_dotnet_project join error: {e}"))
}

/// Depth-bounded search for a `.sln`/`.csproj`, files first (so a root-level
/// solution short-circuits before descending), skipping the heavy dirs.
fn find_dotnet(dir: &Path, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_file() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.ends_with(".sln") || name.ends_with(".csproj") {
                return true;
            }
        } else if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            // Skip the shared heavy dirs AND build outputs (a project's `.csproj`
            // is never inside bin/obj).
            if !is_skipped_dir(&name) && lower != "bin" && lower != "obj" {
                subdirs.push(entry.path());
            }
        }
    }
    subdirs.iter().any(|d| find_dotnet(d, depth + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fluent-index-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "").unwrap();
    }

    fn rels(idx: &ProjectIndex) -> Vec<String> {
        idx.files.iter().map(|f| f.rel.clone()).collect()
    }

    #[test]
    fn honours_gitignore_heavy_dirs_worktrees_and_excludes() {
        let root = tmp("rules");
        for rel in [
            "src/a.ts",
            "src/b.cs",
            "out/gen.js",
            "node_modules/x/index.js",
            "target/debug/app",
            "dist/app.js",
            ".git/HEAD",
            ".claude/worktrees/wt/src/a.ts",
            ".claude/settings.json",
            "bin/Debug/app.dll",
            "notes.code-search",
        ] {
            touch(&root, rel);
        }
        fs::write(root.join(".gitignore"), "out/\n").unwrap();
        let excl = vec!["**/bin".to_string(), "**/node_modules".to_string(), "**/*.code-search".to_string()];
        let idx = build_index(&root, Some(&excl), 10_000);
        assert_eq!(rels(&idx), vec![".claude/settings.json", ".gitignore", "src/a.ts", "src/b.cs"]);
        assert!(!idx.truncated);
        // Defaults (no list from the front) still drop node_modules/*.code-search.
        let idx = build_index(&root, None, 10_000);
        assert!(rels(&idx).contains(&"bin/Debug/app.dll".to_string()));
        assert!(!rels(&idx).iter().any(|r| r.contains("node_modules") || r.ends_with(".code-search")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cap_is_reported_not_silent() {
        let root = tmp("cap");
        for i in 0..1_500 {
            touch(&root, &format!("d{}/f{i}.txt", i % 10));
        }
        let idx = build_index(&root, None, 1_000);
        assert_eq!(idx.files.len(), 1_000);
        assert!(idx.truncated);
        assert_eq!(idx.cap, 1_000);
        let idx = build_index(&root, None, 5_000);
        assert_eq!(idx.files.len(), 1_500);
        assert!(!idx.truncated);
        // Below the floor the cap is clamped (no 0-file "index").
        assert_eq!(build_index(&root, None, 0).cap, MIN_MAX_FILES);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn subtree_globs_hide_the_folder() {
        let root = tmp("subtree");
        touch(&root, "obj/x.json");
        touch(&root, "src/obj/y.json");
        touch(&root, "src/keep.cs");
        let idx = build_index(&root, Some(&["**/obj/**".to_string()]), 10_000);
        assert_eq!(rels(&idx), vec!["src/keep.cs"]);
        fs::remove_dir_all(root).unwrap();
    }

    /// Manual measurement: `FLUENT_BENCH_ROOT=<dir> cargo test --lib bench_quick_open -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_quick_open_index() {
        let root = std::env::var("FLUENT_BENCH_ROOT").expect("FLUENT_BENCH_ROOT");
        let cap: usize = std::env::var("FLUENT_BENCH_CAP").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_MAX_FILES);
        let excl: Vec<String> = ["**/.git", "**/.svn", "**/.hg", "**/.DS_Store", "**/Thumbs.db", "**/bin", "**/obj"]
            .iter()
            .chain(DEFAULT_SEARCH_EXCLUDE)
            .map(|s| s.to_string())
            .collect();
        for run in 0..3 {
            let t = std::time::Instant::now();
            let idx = build_index(Path::new(&root), Some(&excl), cap);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let json = serde_json::to_vec(&idx).unwrap().len();
            println!("BENCH after run={run} files={} truncated={} ms={ms:.1} json_kb={}", idx.files.len(), idx.truncated, json / 1024);
        }
    }
}
