//! Shared filesystem-walking helpers used by the search and file-index
//! commands. Keeping the skip list in one place means the content search
//! (`search_in_dir`) and the Quick Open index (`list_project_files`) agree on
//! which heavy directories to ignore.

/// Directories we never descend into — they're large and rarely interesting,
/// and walking them would make search and Quick Open feel sluggish.
pub const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
];

/// Whether a directory name should be skipped during a recursive walk.
pub fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}
