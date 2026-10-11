use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) mod history;
pub(crate) mod runner;
#[cfg(test)]
pub(crate) mod test_support;

/// Returns the current git branch name for the repository containing `path`,
/// or `None` when the folder isn't a git repo (or HEAD is detached/unborn).
///
/// Reads `.git/HEAD` directly instead of shelling out to `git`, so it works
/// even where the git CLI isn't on PATH and adds no process-spawn latency.
#[tauri::command]
pub async fn git_branch(path: String) -> Option<String> {
    runner::blocking(move || git_branch_blocking(path)).await
}

fn git_branch_blocking(path: String) -> Option<String> {
    let git_dir = find_git_dir(Path::new(&path))?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();

    // Normal case: "ref: refs/heads/<branch>".
    if let Some(rest) = head.strip_prefix("ref: ") {
        return rest.rsplit('/').next().map(|s| s.to_string());
    }

    // Detached HEAD: HEAD holds a raw commit sha. Show a short hash.
    if head.len() >= 7 {
        return Some(format!("({}…)", &head[..7]));
    }
    None
}

/// Walks up from `start` looking for a `.git` directory, so the branch resolves
/// even when a subfolder of the repo is opened.
fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(".git");
        if candidate.is_dir() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

// ---------------------------------------------------------------------------
// Source control: status, staging, commit, sync, history.
//
// We drive the `git` CLI (like VSCode does) rather than a Rust git library.
// That keeps the dependency footprint small and, crucially, makes push/pull
// reuse the user's existing credential helper — no auth re-implementation.
// ---------------------------------------------------------------------------

/// One changed path in `git status`, classified for the SCM list.
#[derive(Serialize)]
pub struct GitFileStatus {
    /// Path relative to the repo root.
    path: String,
    /// Two-letter porcelain code, e.g. " M", "A ", "??", "MM", "UU".
    code: String,
    /// Whether the change is (at least partly) staged in the index.
    staged: bool,
    /// Whether the file is untracked ("??").
    untracked: bool,
    /// Whether the file is unmerged (a merge/rebase conflict).
    conflicted: bool,
}

/// Overall repo state shown above the file list.
#[derive(Serialize)]
pub struct GitStatus {
    /// Current branch, or a short sha when detached. Empty if not a repo.
    /// `pub(crate)` so the remote-git layer can refine a detached HEAD.
    pub(crate) branch: String,
    /// Commits the local branch is ahead of its upstream.
    ahead: u32,
    /// Commits the local branch is behind its upstream.
    behind: u32,
    /// True when `path` is inside a git work tree.
    is_repo: bool,
    /// True when an upstream tracking branch is configured (enables push/pull).
    has_upstream: bool,
    /// Number of unmerged (conflicted) paths — non-zero during a merge/rebase.
    conflicted: u32,
    files: Vec<GitFileStatus>,
}

/// One linked worktree in the repository.
#[derive(Serialize)]
pub struct GitWorktreeInfo {
    /// Absolute path of the worktree.
    path: String,
    /// Branch name, detached short sha, or empty for bare/unborn entries.
    branch: String,
    /// Current HEAD sha when available.
    head: String,
    /// True when the worktree is detached.
    detached: bool,
    /// True for bare worktree entries.
    bare: bool,
    /// True when this entry backs the current panel root.
    current: bool,
}

/// One configured Git remote.
#[derive(Serialize)]
pub struct GitRemoteInfo {
    name: String,
    #[serde(rename = "fetchUrl")]
    fetch_url: String,
    #[serde(rename = "pushUrl")]
    push_url: String,
}

/// A single commit in the history list.
#[derive(Serialize)]
pub struct GitCommit {
    pub(crate) hash: String,
    pub(crate) short: String,
    pub(crate) author: String,
    #[serde(rename = "authorEmail")]
    pub(crate) author_email: String,
    #[serde(rename = "avatarUrl")]
    pub(crate) avatar_url: String,
    #[serde(rename = "isCurrentUser")]
    pub(crate) is_current_user: bool,
    /// Relative date, e.g. "2 hours ago".
    pub(crate) date: String,
    pub(crate) subject: String,
    pub(crate) additions: u32,
    pub(crate) deletions: u32,
    #[serde(rename = "filesChanged")]
    pub(crate) files_changed: u32,
    #[serde(rename = "remoteUrl")]
    pub(crate) remote_url: String,
}

/// GitLens-style comparison between the current branch and its upstream.
#[derive(Serialize)]
pub struct GitUpstreamComparison {
    pub upstream: String,
    pub ahead: Vec<GitCommit>,
    pub behind: Vec<GitCommit>,
}

/// One row in the Git commit graph.
#[derive(Serialize)]
pub struct GitGraphCommit {
    hash: String,
    short: String,
    parents: Vec<String>,
    refs: Vec<String>,
    author: String,
    #[serde(rename = "authorEmail")]
    author_email: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: String,
    #[serde(rename = "isCurrentUser")]
    is_current_user: bool,
    date: String,
    subject: String,
    #[serde(rename = "remoteUrl")]
    remote_url: String,
}

/// One file changed by a commit, used by the GitLens-like Commit Details view.
#[derive(Serialize, Clone)]
pub struct GitCommitFile {
    /// Path relative to the repo root, using `/`.
    path: String,
    /// Previous path for renames/copies, when Git reports one.
    #[serde(rename = "oldPath")]
    old_path: Option<String>,
    /// Git name-status code: M, A, D, R, C, etc.
    status: String,
    additions: u32,
    deletions: u32,
}

/// Runs `git <args>` in `cwd`, returning stdout on success or a combined
/// stdout+stderr error string on failure (so the UI can show what went wrong).
///
/// Delegates to [`runner::run`] (timeouts, cancel, stable env). Callers are
/// always inside a `*_blocking` fn that runs off the main thread.
pub(crate) fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    runner::run(cwd, args)
}

/// Cancels in-flight git processes for `path` (all repos when `None`). With
/// `network_only` (the default from the UI), only fetch/pull/push are killed.
#[tauri::command]
pub fn git_cancel(path: Option<String>, network_only: Option<bool>) -> usize {
    runner::cancel_running(path.as_deref(), network_only.unwrap_or(true))
}

/// The empty, non-erroring status returned when a folder isn't a git repo.
/// Shared by the local and remote (SSH) status commands.
pub fn empty_status() -> GitStatus {
    GitStatus {
        branch: String::new(),
        ahead: 0,
        behind: 0,
        is_repo: false,
        has_upstream: false,
        conflicted: 0,
        files: Vec::new(),
    }
}

pub(crate) fn is_not_repo_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("not a git repository")
}

/// Collects working-tree status: branch, ahead/behind, and per-file changes.
#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    runner::blocking(move || git_status_blocking(path)).await
}

fn git_status_blocking(path: String) -> Result<GitStatus, String> {
    // Not a repo? Return an empty, non-erroring status so the UI can say so.
    match run_git(&path, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(_) => {}
        Err(error) if is_not_repo_error(&error) => return Ok(empty_status()),
        Err(error) => return Err(error),
    }

    // --porcelain=v2 --branch gives both branch/ahead/behind headers and files.
    let raw = run_git(&path, &["status", "--porcelain=v2", "--branch"])?;
    let mut status = parse_status_v2(&raw);
    if status.branch == "(detached)" {
        if let Ok(sha) = run_git(&path, &["rev-parse", "--short", "HEAD"]) {
            status.branch = format!("({}…)", sha.trim());
        }
    }
    Ok(status)
}

/// Lists linked worktrees for the repository containing `path`.
#[tauri::command]
pub async fn git_worktrees(path: String) -> Result<Vec<GitWorktreeInfo>, String> {
    runner::blocking(move || git_worktrees_blocking(path)).await
}

fn git_worktrees_blocking(path: String) -> Result<Vec<GitWorktreeInfo>, String> {
    match run_git(&path, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(_) => {}
        Err(error) if is_not_repo_error(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    }

    let current_root = run_git(&path, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let raw = run_git(&path, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&raw, current_root.trim()))
}

/// Adds a linked worktree. When `create_branch` is true, `branch` is created
/// from HEAD; otherwise `branch_or_ref` may be an existing branch, tag or sha.
#[tauri::command]
pub async fn git_worktree_add(path: String, target: String, branch_or_ref: Option<String>, create_branch: bool) -> Result<(), String> {
    runner::blocking(move || git_worktree_add_blocking(path, target, branch_or_ref, create_branch)).await
}

fn git_worktree_add_blocking(path: String, target: String, branch_or_ref: Option<String>, create_branch: bool) -> Result<(), String> {
    let branch_or_ref = branch_or_ref.unwrap_or_default();
    let branch_or_ref = branch_or_ref.trim();
    if target.trim().is_empty() {
        return Err("Informe a pasta da worktree.".into());
    }
    match (create_branch, branch_or_ref.is_empty()) {
        (true, true) => Err("Informe o nome da nova branch.".into()),
        (true, false) => run_git(&path, &["worktree", "add", "-b", branch_or_ref, &target, "HEAD"]).map(|_| ()),
        (false, true) => run_git(&path, &["worktree", "add", &target]).map(|_| ()),
        (false, false) => run_git(&path, &["worktree", "add", &target, branch_or_ref]).map(|_| ()),
    }
}

/// Removes a linked worktree. `force` passes `--force` for dirty/broken entries.
#[tauri::command]
pub async fn git_worktree_remove(path: String, worktree_path: String, force: bool) -> Result<(), String> {
    runner::blocking(move || git_worktree_remove_blocking(path, worktree_path, force)).await
}

fn git_worktree_remove_blocking(path: String, worktree_path: String, force: bool) -> Result<(), String> {
    if worktree_path.trim().is_empty() {
        return Err("Informe a worktree para remover.".into());
    }
    if force {
        run_git(&path, &["worktree", "remove", "--force", &worktree_path]).map(|_| ())
    } else {
        run_git(&path, &["worktree", "remove", &worktree_path]).map(|_| ())
    }
}

/// Prunes stale worktree metadata, mirroring `git worktree prune`.
#[tauri::command]
pub async fn git_worktree_prune(path: String) -> Result<(), String> {
    runner::blocking(move || git_worktree_prune_blocking(path)).await
}

fn git_worktree_prune_blocking(path: String) -> Result<(), String> {
    run_git(&path, &["worktree", "prune"]).map(|_| ())
}

fn normalize_worktree_branch(raw: &str, head: &str, detached: bool) -> String {
    if detached {
        return if head.len() >= 7 {
            format!("({}…)", &head[..7])
        } else {
            "(detached)".to_string()
        };
    }
    raw.strip_prefix("refs/heads/")
        .unwrap_or(raw)
        .to_string()
}

fn same_path(left: &str, right: &str) -> bool {
    let norm = |value: &str| {
        value
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    norm(left) == norm(right)
}

pub(crate) fn parse_worktrees(raw: &str, current_root: &str) -> Vec<GitWorktreeInfo> {
    fn flush(
        worktrees: &mut Vec<GitWorktreeInfo>,
        path: &mut String,
        branch_raw: &mut String,
        head: &mut String,
        detached: &mut bool,
        bare: &mut bool,
        current_root: &str,
    ) {
        if path.is_empty() {
            return;
        }
        let current = same_path(path, current_root);
        worktrees.push(GitWorktreeInfo {
            path: std::mem::take(path),
            branch: normalize_worktree_branch(branch_raw, head, *detached),
            head: std::mem::take(head),
            detached: *detached,
            bare: *bare,
            current,
        });
        branch_raw.clear();
        *detached = false;
        *bare = false;
    }

    let mut worktrees = Vec::new();
    let mut path = String::new();
    let mut branch_raw = String::new();
    let mut head = String::new();
    let mut detached = false;
    let mut bare = false;

    for line in raw.lines() {
        if line.trim().is_empty() {
            flush(
                &mut worktrees,
                &mut path,
                &mut branch_raw,
                &mut head,
                &mut detached,
                &mut bare,
                current_root,
            );
        } else if let Some(value) = line.strip_prefix("worktree ") {
            if !path.is_empty() {
                flush(
                    &mut worktrees,
                    &mut path,
                    &mut branch_raw,
                    &mut head,
                    &mut detached,
                    &mut bare,
                    current_root,
                );
            }
            path = value.to_string();
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = value.to_string();
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch_raw = value.to_string();
        } else if line == "detached" {
            detached = true;
        } else if line == "bare" {
            bare = true;
        }
    }

    flush(
        &mut worktrees,
        &mut path,
        &mut branch_raw,
        &mut head,
        &mut detached,
        &mut bare,
        current_root,
    );
    worktrees
}

/// Parses `git status --porcelain=v2 --branch` output into a {@link GitStatus}
/// (always `is_repo = true`; the caller checks repo-ness first). A detached HEAD
/// is left as `"(detached)"` for the caller to refine with a short sha. Shared by
/// the local and remote (SSH) status commands.
pub fn parse_status_v2(raw: &str) -> GitStatus {
    let mut branch = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut has_upstream = false;
    let mut conflicted = 0u32;
    let mut files: Vec<GitFileStatus> = Vec::new();

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            has_upstream = true;
            // Format: "+<ahead> -<behind>"
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // Ordinary changed entry: "<XY> <sub> ... <path>"
            push_v2_entry(rest, false, &mut files);
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // Renamed/copied: path is "<new>\t<orig>"; keep the new path.
            push_v2_entry(rest, true, &mut files);
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged (merge/rebase conflict): "<XY> <sub> ... <path>".
            let mut parts = rest.splitn(2, ' ');
            let code = parts.next().unwrap_or("UU").to_string();
            let tail = parts.next().unwrap_or("");
            let path = tail.rsplit(' ').next().unwrap_or(tail).to_string();
            conflicted += 1;
            files.push(GitFileStatus {
                path,
                code,
                staged: false,
                untracked: false,
                conflicted: true,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            files.push(GitFileStatus {
                path: rest.trim().to_string(),
                code: "??".to_string(),
                staged: false,
                untracked: true,
                conflicted: false,
            });
        }
    }

    GitStatus {
        branch,
        ahead,
        behind,
        is_repo: true,
        has_upstream,
        conflicted,
        files,
    }
}

/// Parses the tail of a porcelain v2 "1"/"2" line into a GitFileStatus.
/// The XY status field is the first token; the path is the last field.
fn push_v2_entry(rest: &str, renamed: bool, files: &mut Vec<GitFileStatus>) {
    let mut parts = rest.splitn(2, ' ');
    let xy = parts.next().unwrap_or("..").to_string();
    let tail = parts.next().unwrap_or("");
    // The path is everything after the 7 metadata columns; the simplest robust
    // approach is to take the substring after the last metadata field. Porcelain
    // v2 separates the path with a single space after the score/sha columns, and
    // a rename uses a tab between new and original. We split off the path as the
    // final whitespace-tab segment.
    let field_count = if renamed { 8 } else { 7 };
    let path_field = tail
        .splitn(field_count, ' ')
        .nth(field_count - 1)
        .unwrap_or(tail);
    let path = if renamed {
        path_field.split('\t').next().unwrap_or(path_field)
    } else {
        path_field
    }
    .to_string();

    let staged = xy.chars().next().map(|c| c != '.').unwrap_or(false);
    files.push(GitFileStatus {
        path,
        code: xy,
        staged,
        untracked: false,
        conflicted: false,
    });
}

/// One local branch in the branch picker (issue #16), with the metadata needed
/// to render a VSCode-style Quick Pick row.
#[derive(Serialize)]
pub struct GitBranchInfo {
    /// Branch name (e.g. "main", "feat/x").
    name: String,
    /// True for the branch currently checked out.
    current: bool,
    /// Short hash of the branch tip.
    short: String,
    /// Last-commit date, relative (e.g. "2 hours ago").
    date: String,
    /// Last-commit author name.
    author: String,
    /// Last-commit subject (first line).
    subject: String,
    /// Commits ahead of the upstream, if any tracking branch is set.
    ahead: u32,
    /// Commits behind the upstream, if any tracking branch is set.
    behind: u32,
    /// True when the branch has a configured upstream (ahead/behind are valid).
    has_upstream: bool,
}

/// Lists local branches, most-recently-committed first (like VSCode's branch
/// Quick Pick). Each row carries the tip's short hash, relative date, author and
/// subject, plus ahead/behind vs. its upstream. Returns an empty list when not a
/// git repo.
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<GitBranchInfo>, String> {
    runner::blocking(move || git_branches_blocking(path)).await
}

fn git_branches_blocking(path: String) -> Result<Vec<GitBranchInfo>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }

    // One ref-record per branch, sorted by commit recency (see BRANCHES_FORMAT:
    // the `%(HEAD)` marker flags the checked-out branch; `upstream:track` gives
    // ahead/behind).
    let raw = run_git(
        &path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "refs/heads",
            &format!("--format={BRANCHES_FORMAT}"),
        ],
    )?;
    Ok(parse_branches(&raw))
}

/// Lists remote-tracking branches, most-recently-committed first.
#[tauri::command]
pub async fn git_remote_branches(path: String) -> Result<Vec<GitBranchInfo>, String> {
    runner::blocking(move || git_remote_branches_blocking(path)).await
}

fn git_remote_branches_blocking(path: String) -> Result<Vec<GitBranchInfo>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    let raw = run_git(
        &path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "refs/remotes",
            "--format=%(HEAD)\x1f%(refname:short)\x1f%(objectname:short)\x1f%(committerdate:relative)\x1f%(authorname)\x1f%(contents:subject)\x1f",
        ],
    )?;
    Ok(parse_remote_branches(&raw))
}

/// Lists configured remotes with fetch/push URLs.
#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<GitRemoteInfo>, String> {
    runner::blocking(move || git_remotes_blocking(path)).await
}

fn git_remotes_blocking(path: String) -> Result<Vec<GitRemoteInfo>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    let raw = run_git(&path, &["remote", "-v"])?;
    Ok(parse_remotes(&raw))
}

/// Adds a Git remote (`git remote add <name> <url>`).
#[tauri::command]
pub async fn git_remote_add(path: String, name: String, url: String) -> Result<(), String> {
    runner::blocking(move || git_remote_add_blocking(path, name, url)).await
}

fn git_remote_add_blocking(path: String, name: String, url: String) -> Result<(), String> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err("Nome do remoto vazio.".to_string());
    }
    if url.is_empty() {
        return Err("URL do remoto vazia.".to_string());
    }
    run_git(&path, &["remote", "add", name, url]).map(|_| ())
}

/// Removes a Git remote (`git remote remove <name>`).
#[tauri::command]
pub async fn git_remote_remove(path: String, name: String) -> Result<(), String> {
    runner::blocking(move || git_remote_remove_blocking(path, name)).await
}

fn git_remote_remove_blocking(path: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Nome do remoto vazio.".to_string());
    }
    run_git(&path, &["remote", "remove", name]).map(|_| ())
}

/// Renames a Git remote (`git remote rename <old> <new>`).
#[tauri::command]
pub async fn git_remote_rename(path: String, old_name: String, new_name: String) -> Result<(), String> {
    runner::blocking(move || git_remote_rename_blocking(path, old_name, new_name)).await
}

fn git_remote_rename_blocking(path: String, old_name: String, new_name: String) -> Result<(), String> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if old_name.is_empty() || new_name.is_empty() {
        return Err("Nome do remoto vazio.".to_string());
    }
    run_git(&path, &["remote", "rename", old_name, new_name]).map(|_| ())
}

/// Updates a Git remote fetch URL (`git remote set-url <name> <url>`).
#[tauri::command]
pub async fn git_remote_set_url(path: String, name: String, url: String) -> Result<(), String> {
    runner::blocking(move || git_remote_set_url_blocking(path, name, url)).await
}

fn git_remote_set_url_blocking(path: String, name: String, url: String) -> Result<(), String> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err("Nome do remoto vazio.".to_string());
    }
    if url.is_empty() {
        return Err("URL do remoto vazia.".to_string());
    }
    run_git(&path, &["remote", "set-url", name, url]).map(|_| ())
}

/// The `for-each-ref` format used to list branches (shared local/remote).
pub const BRANCHES_FORMAT: &str = "%(HEAD)\x1f%(refname:short)\x1f%(objectname:short)\x1f\
%(committerdate:relative)\x1f%(authorname)\x1f%(contents:subject)\x1f\
%(upstream:track,nobracket)";

/// Parses the `\x1f`-joined `for-each-ref` output into branch rows. Shared by the
/// local and remote (SSH) branch listings.
pub fn parse_branches(raw: &str) -> Vec<GitBranchInfo> {
    let mut branches = Vec::new();
    for line in raw.lines() {
        let fields: Vec<&str> = line.split('\x1f').collect();
        if fields.len() < 7 {
            continue;
        }
        let (ahead, behind, has_upstream) = parse_track(fields[6]);
        branches.push(GitBranchInfo {
            current: fields[0] == "*",
            name: fields[1].to_string(),
            short: fields[2].to_string(),
            date: fields[3].to_string(),
            author: fields[4].to_string(),
            subject: fields[5].to_string(),
            ahead,
            behind,
            has_upstream,
        });
    }
    branches
}

pub fn parse_remote_branches(raw: &str) -> Vec<GitBranchInfo> {
    parse_branches(raw)
        .into_iter()
        .filter(|branch| !branch.name.ends_with("/HEAD"))
        .collect()
}

pub fn parse_remotes(raw: &str) -> Vec<GitRemoteInfo> {
    let mut remotes: Vec<GitRemoteInfo> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue };
        let Some(url) = parts.next() else { continue };
        let kind = parts.next().unwrap_or("");
        if let Some(existing) = remotes.iter_mut().find(|remote| remote.name == name) {
            if kind == "(push)" {
                existing.push_url = url.to_string();
            } else {
                existing.fetch_url = url.to_string();
            }
        } else {
            remotes.push(GitRemoteInfo {
                name: name.to_string(),
                fetch_url: if kind == "(push)" { String::new() } else { url.to_string() },
                push_url: if kind == "(push)" { url.to_string() } else { String::new() },
            });
        }
    }
    for remote in &mut remotes {
        if remote.push_url.is_empty() {
            remote.push_url = remote.fetch_url.clone();
        }
    }
    remotes
}

/// Parses git's `%(upstream:track,nobracket)` field, e.g. "ahead 2, behind 1",
/// "ahead 3", "behind 1", "gone", or "" (no upstream). Returns
/// `(ahead, behind, has_upstream)`.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let track = track.trim();
    if track.is_empty() {
        return (0, 0, false);
    }
    // "gone" means the upstream was deleted — treat as tracked but 0/0.
    if track == "gone" {
        return (0, 0, true);
    }
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for part in track.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, true)
}

/// Checks out an existing local branch (`git checkout <branch>`). The error
/// string is surfaced to the UI, e.g. when the working tree has conflicting
/// local changes git refuses to discard.
#[tauri::command]
pub async fn git_checkout(path: String, branch: String) -> Result<(), String> {
    runner::blocking(move || git_checkout_blocking(path, branch)).await
}

fn git_checkout_blocking(path: String, branch: String) -> Result<(), String> {
    if branch.trim().is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    run_git(&path, &["checkout", &branch]).map(|_| ())
}

/// Creates a new branch from the current HEAD and checks it out
/// (`git checkout -b <name>`). Fails if the name already exists or is invalid.
#[tauri::command]
pub async fn git_create_branch(path: String, name: String) -> Result<(), String> {
    runner::blocking(move || git_create_branch_blocking(path, name)).await
}

fn git_create_branch_blocking(path: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    run_git(&path, &["checkout", "-b", name]).map(|_| ())
}

/// Renames a local branch.
#[tauri::command]
pub async fn git_rename_branch(path: String, old_name: String, new_name: String) -> Result<(), String> {
    runner::blocking(move || git_rename_branch_blocking(path, old_name, new_name)).await
}

fn git_rename_branch_blocking(path: String, old_name: String, new_name: String) -> Result<(), String> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if old_name.is_empty() || new_name.is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    run_git(&path, &["branch", "-m", old_name, new_name]).map(|_| ())
}

/// Deletes a local branch. Uses `-D` when `force` is true.
#[tauri::command]
pub async fn git_delete_branch(path: String, name: String, force: bool) -> Result<(), String> {
    runner::blocking(move || git_delete_branch_blocking(path, name, force)).await
}

fn git_delete_branch_blocking(path: String, name: String, force: bool) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    let flag = if force { "-D" } else { "-d" };
    run_git(&path, &["branch", flag, name]).map(|_| ())
}

/// Deletes a remote branch via `git push <remote> --delete <branch>`.
#[tauri::command]
pub async fn git_delete_remote_branch(path: String, remote: String, branch: String) -> Result<String, String> {
    runner::blocking(move || git_delete_remote_branch_blocking(path, remote, branch)).await
}

fn git_delete_remote_branch_blocking(path: String, remote: String, branch: String) -> Result<String, String> {
    let remote = remote.trim();
    let branch = branch.trim();
    if remote.is_empty() {
        return Err("Nome do remoto vazio.".to_string());
    }
    if branch.is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    run_git(&path, &["push", remote, "--delete", branch])
}

/// Creates a local branch tracking a remote branch, then checks it out.
#[tauri::command]
pub async fn git_checkout_remote_branch(path: String, remote_branch: String, local_name: String) -> Result<(), String> {
    runner::blocking(move || git_checkout_remote_branch_blocking(path, remote_branch, local_name)).await
}

fn git_checkout_remote_branch_blocking(path: String, remote_branch: String, local_name: String) -> Result<(), String> {
    let remote_branch = remote_branch.trim();
    let local_name = local_name.trim();
    if remote_branch.is_empty() {
        return Err("Branch remota vazia.".to_string());
    }
    if local_name.is_empty() {
        return Err("Nome de branch local vazio.".to_string());
    }
    run_git(&path, &["checkout", "-b", local_name, "--track", remote_branch]).map(|_| ())
}

/// Stages a single path (`git add -- <path>`).
#[tauri::command]
pub async fn git_stage(path: String, file: String) -> Result<(), String> {
    runner::blocking(move || git_stage_blocking(path, file)).await
}

fn git_stage_blocking(path: String, file: String) -> Result<(), String> {
    run_git(&path, &["add", "--", &file]).map(|_| ())
}

/// Unstages a single path (`git reset -- <path>`), keeping working changes.
#[tauri::command]
pub async fn git_unstage(path: String, file: String) -> Result<(), String> {
    runner::blocking(move || git_unstage_blocking(path, file)).await
}

fn git_unstage_blocking(path: String, file: String) -> Result<(), String> {
    run_git(&path, &["reset", "--", &file]).map(|_| ())
}

/// Unstages every staged path (`git reset`), keeping working changes.
#[tauri::command]
pub async fn git_unstage_all(path: String) -> Result<(), String> {
    runner::blocking(move || git_unstage_all_blocking(path)).await
}

fn git_unstage_all_blocking(path: String) -> Result<(), String> {
    run_git(&path, &["reset"]).map(|_| ())
}

/// Stages everything (`git add -A`).
#[tauri::command]
pub async fn git_stage_all(path: String) -> Result<(), String> {
    runner::blocking(move || git_stage_all_blocking(path)).await
}

fn git_stage_all_blocking(path: String) -> Result<(), String> {
    run_git(&path, &["add", "-A"]).map(|_| ())
}

/// Commits the staged changes with `message`.
#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<(), String> {
    runner::blocking(move || git_commit_blocking(path, message)).await
}

fn git_commit_blocking(path: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A mensagem de commit não pode estar vazia.".to_string());
    }
    run_git(&path, &["commit", "-m", &message]).map(|_| ())
}

/// Fetches from the default remote (`git fetch`).
#[tauri::command]
pub async fn git_fetch(path: String) -> Result<(), String> {
    runner::blocking(move || git_fetch_blocking(path)).await
}

fn git_fetch_blocking(path: String) -> Result<(), String> {
    run_git(&path, &["fetch"]).map(|_| ())
}

/// Fetches from one configured remote.
#[tauri::command]
pub async fn git_fetch_remote(path: String, remote: String) -> Result<(), String> {
    runner::blocking(move || git_fetch_remote_blocking(path, remote)).await
}

fn git_fetch_remote_blocking(path: String, remote: String) -> Result<(), String> {
    let remote = remote.trim();
    if remote.is_empty() {
        return Err("Nome do remoto vazio.".to_string());
    }
    run_git(&path, &["fetch", remote]).map(|_| ())
}

/// Pulls from the upstream branch (`git pull`).
#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    runner::blocking(move || git_pull_blocking(path)).await
}

fn git_pull_blocking(path: String) -> Result<String, String> {
    run_git(&path, &["pull"])
}

/// Pushes the current branch (`git push`).
#[tauri::command]
pub async fn git_push(path: String) -> Result<String, String> {
    runner::blocking(move || git_push_blocking(path)).await
}

fn git_push_blocking(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

/// Publishes the current branch: pushes it AND sets its upstream
/// (`git push -u <remote> <branch>`), so a never-pushed branch gets a tracking
/// ref. Prefers the "origin" remote, else the first configured one.
#[tauri::command]
pub async fn git_publish(path: String) -> Result<String, String> {
    runner::blocking(move || git_publish_blocking(path)).await
}

fn git_publish_blocking(path: String) -> Result<String, String> {
    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err("HEAD destacado: faça checkout de uma branch antes de publicar.".into());
    }
    let remotes = run_git(&path, &["remote"]).unwrap_or_default();
    let remote = remotes
        .lines()
        .map(str::trim)
        .find(|r| *r == "origin")
        .or_else(|| remotes.lines().map(str::trim).find(|r| !r.is_empty()))
        .ok_or_else(|| "Nenhum remoto configurado para publicar.".to_string())?
        .to_string();
    run_git(&path, &["push", "-u", &remote, &branch])
}

/// Discards a file's changes, reverting index + worktree to HEAD. An untracked
/// file is removed from disk instead (it has no HEAD version). Irreversible — the
/// UI confirms first.
#[tauri::command]
pub async fn git_discard_file(path: String, file: String, untracked: bool) -> Result<(), String> {
    runner::blocking(move || git_discard_file_blocking(path, file, untracked)).await
}

fn git_discard_file_blocking(path: String, file: String, untracked: bool) -> Result<(), String> {
    if untracked {
        run_git(&path, &["clean", "-f", "--", &file]).map(|_| ())
    } else {
        run_git(
            &path,
            &[
                "restore",
                "--staged",
                "--worktree",
                "--source=HEAD",
                "--",
                &file,
            ],
        )
        .map(|_| ())
    }
}

/// Discards ALL working-tree changes: reverts tracked files to HEAD and removes
/// untracked files/dirs. Irreversible — the UI confirms first.
#[tauri::command]
pub async fn git_discard_all(path: String) -> Result<(), String> {
    runner::blocking(move || git_discard_all_blocking(path)).await
}

fn git_discard_all_blocking(path: String) -> Result<(), String> {
    run_git(
        &path,
        &[
            "restore",
            "--staged",
            "--worktree",
            "--source=HEAD",
            "--",
            ".",
        ],
    )?;
    run_git(&path, &["clean", "-fd"]).map(|_| ())
}

/// One entry in `git stash list`.
#[derive(Serialize)]
pub struct GitStashEntry {
    /// Stash index (`stash@{index}`).
    index: u32,
    /// Stash subject/message.
    message: String,
}

/// One file changed inside a stash entry.
#[derive(Serialize, Clone)]
pub struct GitStashFile {
    /// Path relative to the repo root, using `/`.
    path: String,
    /// Git name-status code: M, A, D, R, C, etc.
    status: String,
}

/// Stashes the working tree (including untracked, `-u`), with an optional message.
#[tauri::command]
pub async fn git_stash_push(path: String, message: Option<String>) -> Result<String, String> {
    runner::blocking(move || git_stash_push_blocking(path, message)).await
}

fn git_stash_push_blocking(path: String, message: Option<String>) -> Result<String, String> {
    let msg = message.unwrap_or_default();
    let mut args: Vec<&str> = vec!["stash", "push", "-u"];
    if !msg.trim().is_empty() {
        args.push("-m");
        args.push(&msg);
    }
    run_git(&path, &args)
}

/// Lists the stash entries (newest first), or an empty list when not a repo.
#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<GitStashEntry>, String> {
    runner::blocking(move || git_stash_list_blocking(path)).await
}

fn git_stash_list_blocking(path: String) -> Result<Vec<GitStashEntry>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    let raw = run_git(&path, &["stash", "list", "--format=%gd\x1f%s"])?;
    Ok(parse_stash_list(&raw))
}

/// Parses `git stash list --format=%gd\x1f%s` rows into `GitStashEntry`s. Shared
/// with the remote (SSH) stash list.
pub(crate) fn parse_stash_list(raw: &str) -> Vec<GitStashEntry> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(2, '\x1f');
        let refname = parts.next().unwrap_or("");
        let message = parts.next().unwrap_or("").to_string();
        if let Some(idx) = refname
            .strip_prefix("stash@{")
            .and_then(|s| s.strip_suffix('}'))
        {
            if let Ok(index) = idx.parse::<u32>() {
                out.push(GitStashEntry { index, message });
            }
        }
    }
    out
}

/// Lists files contained in a stash entry without applying it.
#[tauri::command]
pub async fn git_stash_files(path: String, index: u32) -> Result<Vec<GitStashFile>, String> {
    runner::blocking(move || git_stash_files_blocking(path, index)).await
}

fn git_stash_files_blocking(path: String, index: u32) -> Result<Vec<GitStashFile>, String> {
    let raw = run_git(
        &path,
        &[
            "stash",
            "show",
            "--include-untracked",
            "--name-status",
            "--find-renames",
            &format!("stash@{{{index}}}"),
        ],
    )?;
    Ok(parse_stash_files(&raw))
}

pub(crate) fn parse_stash_files(raw: &str) -> Vec<GitStashFile> {
    let mut files = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.is_empty() {
            continue;
        }
        let raw_status = fields[0];
        let status = raw_status.chars().next().unwrap_or('M').to_string();
        let path = if matches!(status.as_str(), "R" | "C") && fields.len() >= 3 {
            normalize_git_path(fields[2])
        } else if fields.len() >= 2 {
            normalize_git_path(fields[1])
        } else {
            String::new()
        };
        if path.is_empty() {
            continue;
        }
        files.push(GitStashFile { path, status });
    }
    files
}

/// Applies a stash entry, keeping it in the list (`git stash apply`).
#[tauri::command]
pub async fn git_stash_apply(path: String, index: u32) -> Result<String, String> {
    runner::blocking(move || git_stash_apply_blocking(path, index)).await
}

fn git_stash_apply_blocking(path: String, index: u32) -> Result<String, String> {
    run_git(&path, &["stash", "apply", &format!("stash@{{{index}}}")])
}

/// Pops a stash entry (apply + drop) (`git stash pop`).
#[tauri::command]
pub async fn git_stash_pop(path: String, index: u32) -> Result<String, String> {
    runner::blocking(move || git_stash_pop_blocking(path, index)).await
}

fn git_stash_pop_blocking(path: String, index: u32) -> Result<String, String> {
    run_git(&path, &["stash", "pop", &format!("stash@{{{index}}}")])
}

/// Drops a stash entry without applying it (`git stash drop`).
#[tauri::command]
pub async fn git_stash_drop(path: String, index: u32) -> Result<(), String> {
    runner::blocking(move || git_stash_drop_blocking(path, index)).await
}

fn git_stash_drop_blocking(path: String, index: u32) -> Result<(), String> {
    run_git(&path, &["stash", "drop", &format!("stash@{{{index}}}")]).map(|_| ())
}

/// Reverts a commit by creating a new inverse commit (`git revert --no-edit`).
#[tauri::command]
pub async fn git_revert_commit(path: String, commit: String) -> Result<String, String> {
    runner::blocking(move || git_revert_commit_blocking(path, commit)).await
}

fn git_revert_commit_blocking(path: String, commit: String) -> Result<String, String> {
    let commit = commit.trim();
    if commit.is_empty() {
        return Err("Commit vazio para revert.".to_string());
    }
    run_git(&path, &["revert", "--no-edit", commit])
}

/// Undoes the last commit while keeping its changes staged (`git reset --soft`).
#[tauri::command]
pub async fn git_undo_last_commit(path: String) -> Result<String, String> {
    runner::blocking(move || git_undo_last_commit_blocking(path)).await
}

fn git_undo_last_commit_blocking(path: String) -> Result<String, String> {
    run_git(&path, &["reset", "--soft", "HEAD~1"])
}

/// Blame info for a single line, returned by `git_blame`.
#[derive(Serialize)]
pub struct BlameHunk {
    /// Full commit SHA — empty for uncommitted lines.
    pub hash: String,
    /// Short commit SHA (7 chars) — empty for uncommitted lines.
    pub short: String,
    /// Author name.
    pub author: String,
    /// Author email, used by the editor to resolve avatars and "You".
    #[serde(rename = "authorEmail")]
    pub author_email: String,
    /// Whether the blamed author matches the repository's current git identity.
    #[serde(rename = "isCurrentUser")]
    pub is_current_user: bool,
    /// Best-effort avatar URL derived from the author email.
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
    /// Author date in relative format, e.g. "3 days ago".
    pub date: String,
    /// First line of the commit message.
    pub subject: String,
    /// First parent commit SHA, when available.
    #[serde(rename = "previousHash")]
    pub previous_hash: String,
    /// Lines added by this commit in this file, best-effort from `git show --numstat`.
    pub additions: u32,
    /// Lines deleted by this commit in this file, best-effort from `git show --numstat`.
    pub deletions: u32,
    /// Number of changed file entries reported for this commit/file path.
    #[serde(rename = "filesChanged")]
    pub files_changed: u32,
    /// Remote commit URL, when origin/upstream can be converted to a web URL.
    #[serde(rename = "remoteUrl")]
    pub remote_url: String,
    /// 1-based line number in the final file.
    pub line: u32,
}

/// Returns per-line blame info for `file` (absolute path) inside repo at `root`.
/// Lines that have never been committed get placeholder values with empty `short`.
#[tauri::command]
pub async fn git_blame(root: String, file: String) -> Result<Vec<BlameHunk>, String> {
    runner::blocking(move || git_blame_blocking(root, file)).await
}

fn git_blame_blocking(root: String, file: String) -> Result<Vec<BlameHunk>, String> {
    // --porcelain: machine-readable. -M: detect moved lines within the file.
    let raw = match run_git(&root, &["blame", "--porcelain", "-M", "--", &file]) {
        Ok(raw) => raw,
        Err(error) if is_not_repo_error(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut hunks = parse_blame(&raw);
    // Uma chamada de estatísticas para TODOS os hashes do blame (antes: um
    // `git show` por hash) + uma de identidade/remoto.
    let hashes = history::blame_hashes(&hunks);
    let stats = if hashes.is_empty() {
        Vec::new()
    } else {
        let args = history::stats_args(true);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let stdin = hashes.join("\n") + "\n";
        let raw = runner::run_with(
            &root,
            &args,
            runner::RunOptions {
                kind: runner::CallKind::Read,
                timeout: None,
                stdin: Some(stdin.as_bytes()),
            },
        )
        .unwrap_or_default();
        history::parse_log_z(&raw, Some(&repo_relative_path(&root, &file)))
    };
    let meta = history::repo_meta_local(&root);
    history::apply_to_blame(&mut hunks, &meta, &stats);
    Ok(hunks)
}

/// Parses `git blame --porcelain` output into per-line `BlameHunk`s. Shared with
/// the remote (SSH) blame over `exec_git`.
pub(crate) fn parse_blame(raw: &str) -> Vec<BlameHunk> {
    use std::collections::HashMap;

    #[derive(Clone, Default)]
    struct BlameMeta {
        author: String,
        author_email: String,
        date: String,
        subject: String,
    }

    let mut hunks: Vec<BlameHunk> = Vec::new();

    // State for the hunk being accumulated.
    let mut cur_hash = String::new();
    let mut cur_line: u32 = 0;
    // Per-commit metadata cache keyed by 40-char hash — git omits headers on repeat hunks.
    let mut cache: HashMap<String, BlameMeta> = HashMap::new();

    for raw_line in raw.lines() {
        if raw_line.starts_with('\t') {
            // TAB-prefixed line = actual file content. Emit the accumulated hunk.
            let meta = if cur_hash.bytes().all(|b| b == b'0') {
                // All-zero hash = uncommitted (working-tree change).
                BlameMeta {
                    author: "Não commitado".to_string(),
                    ..Default::default()
                }
            } else {
                cache.get(&cur_hash).cloned().unwrap_or_default()
            };
            hunks.push(BlameHunk {
                hash: if cur_hash.bytes().all(|b| b == b'0') {
                    String::new()
                } else {
                    cur_hash.clone()
                },
                short: if cur_hash.bytes().all(|b| b == b'0') {
                    String::new()
                } else {
                    cur_hash[..7.min(cur_hash.len())].to_string()
                },
                author: meta.author,
                author_email: meta.author_email,
                is_current_user: false,
                avatar_url: String::new(),
                date: meta.date,
                subject: meta.subject,
                previous_hash: String::new(),
                additions: 0,
                deletions: 0,
                files_changed: 0,
                remote_url: String::new(),
                line: cur_line,
            });
            continue;
        }

        // Hunk header line: exactly 40 hex chars at the start.
        let bytes = raw_line.as_bytes();
        if bytes.len() >= 40 && bytes[..40].iter().all(|b| b.is_ascii_hexdigit()) {
            let parts: Vec<&str> = raw_line.splitn(4, ' ').collect();
            cur_hash = parts[0].to_string();
            // Third token is the final-file line number.
            cur_line = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
            continue;
        }

        // Header fields — git only emits them once per unique hash.
        if let Some(rest) = raw_line.strip_prefix("author ") {
            cache.entry(cur_hash.clone()).or_default().author = rest.to_string();
        } else if let Some(rest) = raw_line.strip_prefix("author-mail ") {
            cache.entry(cur_hash.clone()).or_default().author_email = normalize_git_email(rest);
        } else if let Some(rest) = raw_line.strip_prefix("author-time ") {
            if let Ok(ts) = rest.trim().parse::<i64>() {
                cache.entry(cur_hash.clone()).or_default().date = format_relative_time(ts);
            }
        } else if let Some(rest) = raw_line.strip_prefix("summary ") {
            cache.entry(cur_hash.clone()).or_default().subject = rest.to_string();
        }
    }

    hunks
}

pub(crate) fn commit_url_from_remote(remote: &str, hash: &str) -> String {
    if remote.is_empty() || hash.is_empty() {
        return String::new();
    }
    let mut web = remote.trim().trim_end_matches(".git").to_string();
    if let Some(rest) = web.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            web = format!("https://{host}/{path}");
        }
    } else if let Some(rest) = web.strip_prefix("ssh://git@") {
        web = format!("https://{rest}");
    }
    if web.contains("gitlab.") || web.contains("gitlab.com") {
        format!("{web}/-/commit/{hash}")
    } else if web.contains("bitbucket.") || web.contains("bitbucket.org") {
        format!("{web}/commits/{hash}")
    } else {
        format!("{web}/commit/{hash}")
    }
}

pub(crate) fn normalize_git_email(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_ascii_lowercase()
}

fn avatar_url_for_email(email: &str) -> String {
    if email.is_empty() {
        return String::new();
    }
    // GitHub noreply emails can be resolved directly to a GitHub avatar.
    if let Some(local) = email.strip_suffix("@users.noreply.github.com") {
        let username = local
            .split_once('+')
            .map(|(_, username)| username)
            .unwrap_or(local);
        if !username.is_empty() {
            return format!("https://github.com/{}.png?size=64", username);
        }
    }
    // Generic best-effort provider for normal commit emails. If it cannot find
    // a real profile image, Monaco simply keeps the initials fallback nearby.
    format!("https://unavatar.io/{}", email)
}

/// Converts a Unix timestamp to a human-readable relative string.
fn format_relative_time(ts: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(ts);
    let diff = now - ts;
    if diff < 0 {
        return "agora".to_string();
    }
    match diff {
        0..=59 => "agora".to_string(),
        60..=3599 => format!("há {} min", diff / 60),
        3600..=86399 => format!("há {} h", diff / 3600),
        86400..=2591999 => format!("há {} dias", diff / 86400),
        2592000..=31535999 => format!("há {} meses", diff / 2592000),
        _ => format!("há {} anos", diff / 31536000),
    }
}

/// Returns the most recent commits (newest first), capped to `limit`.
#[tauri::command]
pub async fn git_log(path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    runner::blocking(move || git_log_blocking(path, limit)).await
}

fn git_log_blocking(path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    // Um único `git log -z --numstat` (antes: 1 log + 1 `git show` por commit).
    local_log(&path, &history::log_args(limit, &[]), None)
}

/// Roda um `git log` no formato de [`history::LOG_FORMAT`] e aplica
/// identidade/remoto (1 chamada). Repo inexistente ou sem commits → vazio.
fn local_log(path: &str, args: &[String], path_filter: Option<&str>) -> Result<Vec<GitCommit>, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let raw = match run_git(path, &args) {
        Ok(raw) => raw,
        Err(error) if history::is_empty_history_error(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut commits = history::into_commits(history::parse_log_z(&raw, path_filter));
    let meta = history::repo_meta_local(path);
    history::apply_meta_to_log(&mut commits, &meta);
    Ok(commits)
}

/// Returns recent commits across all refs with parent hashes and decorations,
/// enough for a GitLens-like graph inside the Source Control panel.
#[tauri::command]
pub async fn git_graph(path: String, limit: u32) -> Result<Vec<GitGraphCommit>, String> {
    runner::blocking(move || git_graph_blocking(path, limit)).await
}

fn git_graph_blocking(path: String, limit: u32) -> Result<Vec<GitGraphCommit>, String> {
    let raw = match run_git(&path, &graph_args(limit).iter().map(String::as_str).collect::<Vec<_>>()) {
        Ok(raw) => raw,
        Err(error) if history::is_empty_history_error(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut commits = parse_graph_records(&raw)?;
    let meta = history::repo_meta_local(&path);
    history::apply_meta_to_graph(&mut commits, &meta);
    Ok(commits)
}

/// Args do grafo. `--branches --remotes --tags HEAD` em vez de `--all`: o
/// `--all` incluía `refs/stash` (commits WIP/index do stash viravam branches
/// fantasmas). `HEAD` mantém o commit atual mesmo destacado.
pub(crate) fn graph_args(limit: u32) -> Vec<String> {
    vec![
        "log".into(),
        "--branches".into(),
        "--remotes".into(),
        "--tags".into(),
        "HEAD".into(),
        "--topo-order".into(),
        "--decorate=short".into(),
        format!("-{limit}"),
        "--no-color".into(),
        "--pretty=format:%H\x1f%h\x1f%P\x1f%D\x1f%an\x1f%ae\x1f%at\x1f%s\x1e".into(),
    ]
}

/// Lists commits that are only on HEAD (`ahead`) or only on @{upstream}
/// (`behind`), mirroring GitLens' "Compare with upstream" view.
#[tauri::command]
pub async fn git_compare_upstream(path: String, limit: u32) -> Result<GitUpstreamComparison, String> {
    runner::blocking(move || git_compare_upstream_blocking(path, limit)).await
}

fn git_compare_upstream_blocking(path: String, limit: u32) -> Result<GitUpstreamComparison, String> {
    let upstream = match run_git(&path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) {
        Ok(value) => value.trim().to_string(),
        Err(_) => {
            return Ok(GitUpstreamComparison {
                upstream: String::new(),
                ahead: Vec::new(),
                behind: Vec::new(),
            })
        }
    };
    let ahead = local_log(&path, &history::log_args(limit, &["@{upstream}..HEAD"]), None)?;
    let behind = local_log(&path, &history::log_args(limit, &["HEAD..@{upstream}"]), None)?;
    Ok(GitUpstreamComparison {
        upstream,
        ahead,
        behind,
    })
}

/// History of a single file (ISSUE-71 · File History): the commits that touched
/// `file` (absolute path or path relative to the repo at `path`), newest first.
/// Reuses the same `GitCommit` shape as `git_log`, adding `--follow` so renames
/// are tracked across history. Returns an empty list when not a repo.
#[tauri::command]
pub async fn git_log_file(path: String, file: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    runner::blocking(move || git_log_file_blocking(path, file, limit)).await
}

fn git_log_file_blocking(path: String, file: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    // `--follow` + pathspec: o numstat já vem restrito ao arquivo (com renames).
    local_log(&path, &history::log_args(limit, &["--follow", "--", &file]), None)
}

/// History for a single line in a file, GitLens-style. This is intentionally
/// implemented with `git log -L <line>,<line>:<path>` so Git follows how that
/// exact line evolved through prior revisions instead of merely listing every
/// commit that touched the file.
#[tauri::command]
pub async fn git_log_line(path: String, file: String, line: u32, limit: u32) -> Result<Vec<GitCommit>, String> {
    runner::blocking(move || git_log_line_blocking(path, file, line, limit)).await
}

fn git_log_line_blocking(path: String, file: String, line: u32, limit: u32) -> Result<Vec<GitCommit>, String> {
    if line == 0 {
        return Err("Linha inválida para histórico Git.".into());
    }
    let rel = repo_relative_path(&path, &file);
    let line_spec = format!("-L{line},{line}:{rel}");
    let fmt = "--pretty=format:%x1e%H\x1f%h\x1f%an\x1f%ae\x1f%ar\x1f%s";
    let raw = match run_git(
        &path,
        &[
            "log",
            &format!("-{limit}"),
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            fmt,
            &line_spec,
        ],
    ) {
        Ok(raw) => raw,
        Err(error) if history::is_empty_history_error(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let hashes: Vec<String> = parse_log_records_from_line_history(&raw)?
        .into_iter()
        .map(|c| c.hash)
        .collect();
    if hashes.is_empty() {
        return Ok(Vec::new());
    }
    // Metadados + estatísticas do arquivo para todos os hashes em UMA chamada.
    let args = history::stats_args(true);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let stdin = hashes.join("\n") + "\n";
    let stats_raw = runner::run_with(
        &path,
        &args,
        runner::RunOptions {
            kind: runner::CallKind::Read,
            timeout: None,
            stdin: Some(stdin.as_bytes()),
        },
    )?;
    let mut commits = history::into_commits(history::parse_log_z(&stats_raw, Some(&rel)));
    let meta = history::repo_meta_local(&path);
    history::apply_meta_to_log(&mut commits, &meta);
    Ok(commits)
}

/// Returns the file contents exactly as they were at `commit`.
#[tauri::command]
pub async fn git_show_file_at_commit(path: String, file: String, commit: String) -> Result<String, String> {
    runner::blocking(move || git_show_file_at_commit_blocking(path, file, commit)).await
}

fn git_show_file_at_commit_blocking(path: String, file: String, commit: String) -> Result<String, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Esta pasta não é um repositório Git.".into());
    }
    let rel = repo_relative_path(&path, &file);
    let spec = format!("{commit}:{rel}");
    run_git(&path, &["show", "--no-ext-diff", &spec])
}

/// Returns the file contents currently staged in the Git index.
#[tauri::command]
pub async fn git_show_file_staged(path: String, file: String) -> Result<String, String> {
    runner::blocking(move || git_show_file_staged_blocking(path, file)).await
}

fn git_show_file_staged_blocking(path: String, file: String) -> Result<String, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Esta pasta não é um repositório Git.".into());
    }
    let rel = repo_relative_path(&path, &file);
    let spec = format!(":{rel}");
    run_git(&path, &["show", "--no-ext-diff", &spec])
}

/// Returns a unified diff for a file revision, matching GitLens' "Open Changes"
/// affordances:
/// - `previous`: changes introduced by `commit` versus its parent (root commits
///   are handled by `git show`).
/// - `working`: changes between `commit` and the current working file.
#[tauri::command]
pub async fn git_diff_file_revision(path: String, file: String, commit: String, compare_to: String) -> Result<String, String> {
    runner::blocking(move || git_diff_file_revision_blocking(path, file, commit, compare_to)).await
}

fn git_diff_file_revision_blocking(path: String, file: String, commit: String, compare_to: String) -> Result<String, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Esta pasta não é um repositório Git.".into());
    }
    let rel = repo_relative_path(&path, &file);
    match compare_to.as_str() {
        "previous" => run_git(
            &path,
            &[
                "show",
                "--format=",
                "--no-ext-diff",
                "--find-renames",
                "--patch",
                &commit,
                "--",
                &rel,
            ],
        ),
        "working" => run_git(
            &path,
            &[
                "diff",
                "--no-ext-diff",
                "--find-renames",
                &commit,
                "--",
                &rel,
            ],
        ),
        _ => Err("Comparação Git desconhecida.".into()),
    }
}

/// Returns the working-tree patch for a tracked file versus HEAD. This backs the
/// VS Code-like "Open Changes" action from Explorer/Source Control.
#[tauri::command]
pub async fn git_diff_file(path: String, file: String) -> Result<String, String> {
    runner::blocking(move || git_diff_file_blocking(path, file)).await
}

fn git_diff_file_blocking(path: String, file: String) -> Result<String, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Esta pasta não é um repositório Git.".into());
    }
    let rel = repo_relative_path(&path, &file);
    run_git(
        &path,
        &[
            "diff",
            "--no-ext-diff",
            "--find-renames",
            "HEAD",
            "--",
            &rel,
        ],
    )
}

/// Returns the staged/index patch for a tracked file versus HEAD. This backs the
/// VS Code-like staged changes view from Source Control.
#[tauri::command]
pub async fn git_diff_file_staged(path: String, file: String) -> Result<String, String> {
    runner::blocking(move || git_diff_file_staged_blocking(path, file)).await
}

fn git_diff_file_staged_blocking(path: String, file: String) -> Result<String, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Esta pasta não é um repositório Git.".into());
    }
    let rel = repo_relative_path(&path, &file);
    run_git(
        &path,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--find-renames",
            "--",
            &rel,
        ],
    )
}

/// Lists files changed by a commit for the GitLens-like Commit Details card.
#[tauri::command]
pub async fn git_commit_files(path: String, commit: String) -> Result<Vec<GitCommitFile>, String> {
    runner::blocking(move || git_commit_files_blocking(path, commit)).await
}

fn git_commit_files_blocking(path: String, commit: String) -> Result<Vec<GitCommitFile>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("Esta pasta não é um repositório Git.".into());
    }
    let status = run_git(
        &path,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            "--no-ext-diff",
            &commit,
        ],
    )?;
    let numstat = run_git(
        &path,
        &[
            "show",
            "--format=",
            "--numstat",
            "--find-renames",
            "--no-ext-diff",
            &commit,
        ],
    )
    .unwrap_or_default();
    Ok(parse_commit_file_records(&status, &numstat))
}

fn repo_relative_path(root: &str, file: &str) -> String {
    let root_path = std::path::Path::new(root);
    let file_path = std::path::Path::new(file);
    file_path
        .strip_prefix(root_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| file.to_string())
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

pub(crate) fn parse_commit_file_records(status_raw: &str, numstat_raw: &str) -> Vec<GitCommitFile> {
    let mut stats: HashMap<String, (u32, u32)> = HashMap::new();
    for line in numstat_raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let deletions = parts.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let path = normalize_numstat_path(parts.next().unwrap_or(""));
        if !path.is_empty() {
            stats.insert(path, (additions, deletions));
        }
    }

    let mut files = Vec::new();
    for line in status_raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.is_empty() {
            continue;
        }
        let raw_status = fields[0];
        let status = raw_status.chars().next().unwrap_or('M').to_string();
        let (old_path, path) = if matches!(status.as_str(), "R" | "C") && fields.len() >= 3 {
            (
                Some(normalize_git_path(fields[1])),
                normalize_git_path(fields[2]),
            )
        } else if fields.len() >= 2 {
            (None, normalize_git_path(fields[1]))
        } else {
            (None, String::new())
        };
        if path.is_empty() {
            continue;
        }
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        files.push(GitCommitFile {
            path,
            old_path,
            status,
            additions,
            deletions,
        });
    }
    files
}

fn normalize_git_path(path: &str) -> String {
    path.trim().trim_matches('"').replace('\\', "/")
}

fn normalize_numstat_path(path: &str) -> String {
    let normalized = normalize_git_path(path);
    if let Some((_, right)) = normalized.split_once(" => ") {
        return normalize_git_path(right);
    }
    normalized
}

/// Parses the `%H\x1f%h\x1f%an\x1f%ae\x1f%ar\x1f%s\x1e` record stream shared by the
/// repo-wide and per-file log commands into `GitCommit`s. Also reused by the
/// remote (SSH) log over `exec_git`.
pub(crate) fn parse_log_records(raw: &str) -> Result<Vec<GitCommit>, String> {
    let mut commits = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() >= 6 {
            let email = normalize_git_email(fields[3]);
            commits.push(GitCommit {
                hash: fields[0].to_string(),
                short: fields[1].to_string(),
                author: fields[2].to_string(),
                author_email: email.clone(),
                avatar_url: avatar_url_for_email(&email),
                is_current_user: false,
                date: fields[4].to_string(),
                subject: fields[5].to_string(),
                additions: 0,
                deletions: 0,
                files_changed: 0,
                remote_url: String::new(),
            });
        } else if fields.len() >= 5 {
            // Back-compat with older callers/tests using the previous format.
            commits.push(GitCommit {
                hash: fields[0].to_string(),
                short: fields[1].to_string(),
                author: fields[2].to_string(),
                author_email: String::new(),
                avatar_url: String::new(),
                is_current_user: false,
                date: fields[3].to_string(),
                subject: fields[4].to_string(),
                additions: 0,
                deletions: 0,
                files_changed: 0,
                remote_url: String::new(),
            });
        }
    }
    Ok(commits)
}

pub(crate) fn parse_graph_records(raw: &str) -> Result<Vec<GitGraphCommit>, String> {
    let mut commits = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_start_matches('\n');
        if record.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() < 8 {
            continue;
        }
        let email = normalize_git_email(fields[5]);
        let refs = fields[3]
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect();
        let parents = fields[2]
            .split_whitespace()
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect();
        commits.push(GitGraphCommit {
            hash: fields[0].to_string(),
            short: fields[1].to_string(),
            parents,
            refs,
            author: fields[4].to_string(),
            author_email: email.clone(),
            avatar_url: avatar_url_for_email(&email),
            is_current_user: false,
            // `%at` (local e SSH) → "há 2 h", como blame/CodeLens; aceita `%ar`.
            date: fields[6]
                .trim()
                .parse::<i64>()
                .map(format_relative_time)
                .unwrap_or_else(|_| fields[6].to_string()),
            subject: fields[7].to_string(),
            remote_url: String::new(),
        });
    }
    Ok(commits)
}

fn parse_log_records_from_line_history(raw: &str) -> Result<Vec<GitCommit>, String> {
    let mut compact = String::new();
    for chunk in raw.split('\x1e') {
        let line = chunk.lines().next().unwrap_or("").trim();
        if line.matches('\x1f').count() >= 5 {
            compact.push_str(line);
            compact.push('\x1e');
        }
    }
    parse_log_records(&compact)
}

// ---------------------------------------------------------------------------
// Agent workspace snapshots (used by the chat's "revert" action).
//
// This mirrors how the big AI coding tools implement undo: instead of copying
// files, we capture a lightweight git object of the working tree before a
// write-capable request, then restore the tree to it on demand. `git stash
// create` builds a commit holding tracked + staged changes WITHOUT touching the
// working tree, so taking a snapshot is cheap and side-effect free.
// ---------------------------------------------------------------------------

/// A captured workspace state the chat can roll back to.
#[derive(Serialize)]
pub struct GitSnapshot {
    /// Git object id of the snapshot commit (from `git stash create`). Empty
    /// when the tree was clean — restoring then just resets to `head`.
    snapshot_id: String,
    /// HEAD commit at capture time.
    head: String,
}

/// Captures the current working tree so a later `git_snapshot_restore` can undo
/// whatever the agent changes next. Errors only when `path` isn't a git repo —
/// callers should treat that as "revert unavailable" rather than fatal.
#[tauri::command]
pub async fn git_snapshot_create(path: String) -> Result<GitSnapshot, String> {
    runner::blocking(move || git_snapshot_create_blocking(path)).await
}

fn git_snapshot_create_blocking(path: String) -> Result<GitSnapshot, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("O workspace não é um repositório git.".into());
    }
    let head = run_git(&path, &["rev-parse", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // `stash create` emits the snapshot commit sha on stdout, or nothing when
    // the tree is clean. It never alters the working tree or the stash list.
    let snapshot_id = run_git(&path, &["stash", "create", "fluent-coder agent snapshot"])?
        .trim()
        .to_string();

    Ok(GitSnapshot { snapshot_id, head })
}

/// Restores the working tree to a snapshot taken by `git_snapshot_create`,
/// discarding everything the agent changed since. Tracked files are reset to the
/// snapshot; files the agent newly created (untracked) are removed.
#[tauri::command]
pub async fn git_snapshot_restore(path: String, snapshot_id: String, head: String) -> Result<(), String> {
    runner::blocking(move || git_snapshot_restore_blocking(path, snapshot_id, head)).await
}

fn git_snapshot_restore_blocking(path: String, snapshot_id: String, head: String) -> Result<(), String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Err("O workspace não é um repositório git.".into());
    }

    // Files created by the agent after the snapshot are untracked; drop them so
    // the tree matches the snapshot exactly. -d includes new dirs; we never
    // touch ignored files (no -x) to preserve build output, node_modules, etc.
    let _ = run_git(&path, &["clean", "-d", "--force"]);

    // The snapshot source: the stash-create commit when the tree was dirty, or
    // HEAD when it was clean (nothing was captured, so HEAD is the prior state).
    let source = if snapshot_id.trim().is_empty() {
        head.trim()
    } else {
        snapshot_id.trim()
    };
    if source.is_empty() {
        return Err("Não há um ponto de restauração válido para este pedido.".into());
    }

    // Reset both the index and the working tree of every path to the snapshot.
    run_git(
        &path,
        &[
            "restore",
            "--source",
            source,
            "--staged",
            "--worktree",
            "--",
            ".",
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::test_support::TempRepo;

    /// Repo com: arquivo não-ASCII com espaço, rename e um segundo autor.
    fn history_repo() -> TempRepo {
        let repo = TempRepo::new();
        repo.write("café é.txt", "a\n");
        repo.write("old.txt", "x\n");
        repo.commit_all("primeiro");
        repo.write("café é.txt", "a\nb\nc\n");
        repo.git(&["mv", "old.txt", "novo nome.txt"]);
        repo.commit_all("segundo: rename");
        repo.write("café é.txt", "a\nB\nc\n");
        repo.git(&["add", "-A"]);
        repo.git(&[
            "-c", "user.name=Bia", "-c", "user.email=bia@example.com",
            "commit", "-q", "-m", "terceiro",
        ]);
        repo
    }

    #[test]
    fn log_has_stats_identity_from_a_single_log_call() {
        let repo = history_repo();
        let commits = git_log_blocking(repo.root(), 30).unwrap();
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].subject, "terceiro");
        assert_eq!(commits[0].author, "Bia");
        assert!(!commits[0].is_current_user);
        assert!(commits[1].is_current_user, "Ana é o user.name do repo");
        assert_eq!((commits[0].additions, commits[0].deletions, commits[0].files_changed), (1, 1, 1));
        // segundo: café (+2) e o rename (0/0) → 2 arquivos.
        assert_eq!((commits[1].additions, commits[1].files_changed), (2, 2));
        assert!(commits[2].date.starts_with("agora") || commits[2].date.starts_with("há"));
    }

    #[test]
    fn file_and_line_history_and_blame_follow_non_ascii_paths() {
        let repo = history_repo();
        let file = repo.file("café é.txt").to_string_lossy().to_string();
        let history = git_log_file_blocking(repo.root(), file.clone(), 50).unwrap();
        assert_eq!(history.len(), 3);
        assert_eq!(history[1].additions, 2);
        assert_eq!(history[1].files_changed, 1, "numstat restrito ao arquivo");

        let line = git_log_line_blocking(repo.root(), file.clone(), 2, 50).unwrap();
        assert_eq!(line.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["terceiro", "segundo: rename"]);
        assert_eq!(line[0].files_changed, 1);

        let blame = git_blame_blocking(repo.root(), file).unwrap();
        assert_eq!(blame.len(), 3);
        assert_eq!(blame[1].author, "Bia");
        assert_eq!(blame[1].subject, "terceiro");
        assert!(!blame[1].previous_hash.is_empty(), "pai vem do lote de stats");
        assert_eq!((blame[1].additions, blame[1].deletions), (1, 1));
        assert_eq!(blame[0].subject, "primeiro");
        assert!(blame[0].is_current_user);
    }

    #[test]
    fn empty_and_non_repo_histories_are_empty_lists() {
        let repo = TempRepo::new();
        assert!(git_log_blocking(repo.root(), 30).unwrap().is_empty());
        assert!(git_graph_blocking(repo.root(), 30).unwrap().is_empty());
        let plain = tempfile::tempdir().unwrap();
        let plain = plain.path().to_string_lossy().to_string();
        assert!(git_log_blocking(plain.clone(), 30).unwrap().is_empty());
        assert!(git_blame_blocking(plain, "x".into()).unwrap().is_empty());
    }

    /// Medição (não roda por padrão): `FLUENT_BENCH_REPO=/caminho cargo test
    /// --lib git::tests::bench_history -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_history() {
        let root = std::env::var("FLUENT_BENCH_REPO").expect("FLUENT_BENCH_REPO");
        let t = std::time::Instant::now();
        // Caminho antigo: log + 2 config + remote + 1 `git show --numstat` por commit.
        let raw = run_git(&root, &["log", "-30", "--format=%H"]).unwrap();
        let _ = run_git(&root, &["config", "--get", "user.name"]);
        let _ = run_git(&root, &["config", "--get", "user.email"]);
        let _ = run_git(&root, &["remote", "get-url", "origin"]);
        let mut spawns = 4;
        for hash in raw.lines() {
            let _ = run_git(&root, &["show", "--numstat", "--format=%P", hash]);
            spawns += 1;
        }
        let old = t.elapsed();
        let t = std::time::Instant::now();
        let commits = git_log_blocking(root.clone(), 30).unwrap();
        let new = t.elapsed();
        println!("historico 30 commits: antes {old:?} ({spawns} spawns) / depois {new:?} (2 spawns) — {} commits", commits.len());
    }

    /// Compile-time guard: the git commands Tauri invokes are `async fn`s
    /// (futures), so Tauri runs them on its async runtime — never on the main
    /// thread. Building the future does not run it.
    #[test]
    fn git_commands_are_async() {
        fn is_future<F: std::future::Future>(_: F) {}
        let p = || String::from("/nonexistent");
        is_future(git_status(p()));
        is_future(git_branch(p()));
        is_future(git_fetch(p()));
        is_future(git_fetch_remote(p(), p()));
        is_future(git_pull(p()));
        is_future(git_push(p()));
        is_future(git_publish(p()));
        is_future(git_commit(p(), p()));
        is_future(git_checkout(p(), p()));
        is_future(git_log(p(), 30));
        is_future(git_graph(p(), 80));
        is_future(git_log_file(p(), p(), 50));
        is_future(git_log_line(p(), p(), 1, 50));
        is_future(git_blame(p(), p()));
        is_future(git_stash_push(p(), None));
        is_future(git_worktrees(p()));
    }

    #[test]
    fn porcelain_v2_rename_uses_destination_path() {
        let raw = "# branch.head main\n2 R. N... 100644 100644 100644 abcdef abcdef R100 new name.ts\told name.ts\n";
        let status = parse_status_v2(raw);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "new name.ts");
    }

    #[test]
    fn only_not_a_repo_errors_are_downgraded() {
        assert!(is_not_repo_error("fatal: not a git repository"));
        assert!(!is_not_repo_error("git executable was not found"));
        assert!(!is_not_repo_error("permission denied"));
    }

    #[test]
    fn worktree_porcelain_marks_current_and_detached() {
        let raw = "worktree C:/repo/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree C:/repo/feature\nHEAD abcdef0123456789abcdef0123456789abcdef01\ndetached\n\n";
        let worktrees = parse_worktrees(raw, "C:\\repo\\main");
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].current);
        assert_eq!(worktrees[0].branch, "main");
        assert!(!worktrees[1].current);
        assert!(worktrees[1].detached);
        assert_eq!(worktrees[1].branch, "(abcdef0…)");
    }

    #[test]
    fn remote_verbose_merges_fetch_and_push_urls() {
        let raw = "origin\thttps://github.com/acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\nupstream\thttps://github.com/base/app.git (fetch)\n";
        let remotes = parse_remotes(raw);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].fetch_url, "https://github.com/acme/app.git");
        assert_eq!(remotes[0].push_url, "git@github.com:acme/app.git");
        assert_eq!(remotes[1].name, "upstream");
        assert_eq!(remotes[1].push_url, "https://github.com/base/app.git");
    }

    #[test]
    fn remote_branches_hide_symbolic_head() {
        let raw = " \x1forigin/HEAD\x1fabc123\x1fhá 1 h\x1fRafa\x1finit\x1f\n \x1forigin/main\x1fdef456\x1fhá 2 h\x1fRafa\x1fmain\x1f\n";
        let branches = parse_remote_branches(raw);
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].name, "origin/main");
    }

    #[test]
    fn graph_records_parse_parents_and_refs() {
        let raw = "abcdef012345\x1fabcdef0\x1f1111111 2222222\x1fHEAD -> main, tag: v1.0, origin/main\x1fRafa\x1frafa@example.com\x1fhá 1 h\x1fmerge branch\x1e";
        let commits = parse_graph_records(raw).expect("graph records");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].parents, vec!["1111111", "2222222"]);
        assert_eq!(commits[0].refs, vec!["HEAD -> main", "tag: v1.0", "origin/main"]);
        assert_eq!(commits[0].author_email, "rafa@example.com");
    }

    #[test]
    fn commit_file_records_merge_status_and_numstat() {
        let status = "M\tsrc/app.ts\nR100\told/name.ts\tnew/name.ts\nD\tdead.ts\n";
        let numstat = "12\t3\tsrc/app.ts\n1\t0\tnew/name.ts\n0\t7\tdead.ts\n";
        let files = parse_commit_file_records(status, numstat);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].additions, 12);
        assert_eq!(files[0].deletions, 3);
        assert_eq!(files[1].old_path.as_deref(), Some("old/name.ts"));
        assert_eq!(files[1].path, "new/name.ts");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[2].status, "D");
        assert_eq!(files[2].deletions, 7);
    }

    #[test]
    fn stash_files_use_destination_for_renames() {
        let raw = "M\tsrc/app.ts\nR100\told/name.ts\tnew/name.ts\nA\tnew.ts\n";
        let files = parse_stash_files(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[1].path, "new/name.ts");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[2].path, "new.ts");
        assert_eq!(files[2].status, "A");
    }
}
