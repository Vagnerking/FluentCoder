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

/// Workspace-relative directory paths (`/`-separated) skipped by the walks
/// even when no `.gitignore` covers them. `.claude/worktrees` holds full
/// copies of the repository (Claude Code worktrees): indexing it multiplied
/// the Quick Open list ~15× on the main checkout.
pub const SKIP_REL_DIRS: &[&str] = &[".claude/worktrees"];

/// Whether a directory name should be skipped during a recursive walk.
pub fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

/// Whether a directory, given by its root-relative `/` path, is skipped.
pub fn is_skipped_rel_dir(rel: &str) -> bool {
    SKIP_REL_DIRS.iter().any(|p| rel == *p || rel.ends_with(&format!("/{p}")))
}

/// Path form of [`is_skipped_rel_dir`] for walkers that only see absolute
/// paths (the content search): true when `path` ends in `.claude/worktrees`.
pub fn is_skipped_dir_path(path: &std::path::Path) -> bool {
    let mut comps = path.components().rev();
    let last = comps.next().map(|c| c.as_os_str().to_string_lossy().to_string());
    let parent = comps.next().map(|c| c.as_os_str().to_string_lossy().to_string());
    matches!((parent.as_deref(), last.as_deref()), (Some(".claude"), Some("worktrees")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_claude_worktrees_by_relative_path_only() {
        assert!(is_skipped_rel_dir(".claude/worktrees"));
        assert!(is_skipped_rel_dir("sub/.claude/worktrees"));
        assert!(!is_skipped_rel_dir(".claude"));
        assert!(!is_skipped_rel_dir("src/worktrees"));
        assert!(is_skipped_dir("node_modules") && is_skipped_dir("target") && !is_skipped_dir("src"));
        assert!(is_skipped_dir_path(std::path::Path::new("/r/.claude/worktrees")));
        assert!(!is_skipped_dir_path(std::path::Path::new("/r/.claude")));
    }
}
