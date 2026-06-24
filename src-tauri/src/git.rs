use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Returns the current git branch name for the repository containing `path`,
/// or `None` when the folder isn't a git repo (or HEAD is detached/unborn).
///
/// Reads `.git/HEAD` directly instead of shelling out to `git`, so it works
/// even where the git CLI isn't on PATH and adds no process-spawn latency.
#[tauri::command]
pub fn git_branch(path: String) -> Option<String> {
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

/// A single commit in the history list.
#[derive(Serialize)]
pub struct GitCommit {
    hash: String,
    short: String,
    author: String,
    /// Relative date, e.g. "2 hours ago".
    date: String,
    subject: String,
}

/// Runs `git <args>` in `cwd`, returning stdout on success or a combined
/// stdout+stderr error string on failure (so the UI can show what went wrong).
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Falha ao executar git: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let msg = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        Err(msg.trim().to_string())
    }
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

fn is_not_repo_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("not a git repository")
}

/// Collects working-tree status: branch, ahead/behind, and per-file changes.
#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
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
pub fn git_branches(path: String) -> Result<Vec<GitBranchInfo>, String> {
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
pub fn git_checkout(path: String, branch: String) -> Result<(), String> {
    if branch.trim().is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    run_git(&path, &["checkout", &branch]).map(|_| ())
}

/// Creates a new branch from the current HEAD and checks it out
/// (`git checkout -b <name>`). Fails if the name already exists or is invalid.
#[tauri::command]
pub fn git_create_branch(path: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Nome de branch vazio.".to_string());
    }
    run_git(&path, &["checkout", "-b", name]).map(|_| ())
}

/// Stages a single path (`git add -- <path>`).
#[tauri::command]
pub fn git_stage(path: String, file: String) -> Result<(), String> {
    run_git(&path, &["add", "--", &file]).map(|_| ())
}

/// Unstages a single path (`git reset -- <path>`), keeping working changes.
#[tauri::command]
pub fn git_unstage(path: String, file: String) -> Result<(), String> {
    run_git(&path, &["reset", "--", &file]).map(|_| ())
}

/// Stages everything (`git add -A`).
#[tauri::command]
pub fn git_stage_all(path: String) -> Result<(), String> {
    run_git(&path, &["add", "-A"]).map(|_| ())
}

/// Commits the staged changes with `message`.
#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A mensagem de commit não pode estar vazia.".to_string());
    }
    run_git(&path, &["commit", "-m", &message]).map(|_| ())
}

/// Fetches from the default remote (`git fetch`).
#[tauri::command]
pub fn git_fetch(path: String) -> Result<(), String> {
    run_git(&path, &["fetch"]).map(|_| ())
}

/// Pulls from the upstream branch (`git pull`).
#[tauri::command]
pub fn git_pull(path: String) -> Result<String, String> {
    run_git(&path, &["pull"])
}

/// Pushes the current branch (`git push`).
#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

/// Publishes the current branch: pushes it AND sets its upstream
/// (`git push -u <remote> <branch>`), so a never-pushed branch gets a tracking
/// ref. Prefers the "origin" remote, else the first configured one.
#[tauri::command]
pub fn git_publish(path: String) -> Result<String, String> {
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
pub fn git_discard_file(path: String, file: String, untracked: bool) -> Result<(), String> {
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
pub fn git_discard_all(path: String) -> Result<(), String> {
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

/// Stashes the working tree (including untracked, `-u`), with an optional message.
#[tauri::command]
pub fn git_stash_push(path: String, message: Option<String>) -> Result<String, String> {
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
pub fn git_stash_list(path: String) -> Result<Vec<GitStashEntry>, String> {
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

/// Applies a stash entry, keeping it in the list (`git stash apply`).
#[tauri::command]
pub fn git_stash_apply(path: String, index: u32) -> Result<String, String> {
    run_git(&path, &["stash", "apply", &format!("stash@{{{index}}}")])
}

/// Pops a stash entry (apply + drop) (`git stash pop`).
#[tauri::command]
pub fn git_stash_pop(path: String, index: u32) -> Result<String, String> {
    run_git(&path, &["stash", "pop", &format!("stash@{{{index}}}")])
}

/// Drops a stash entry without applying it (`git stash drop`).
#[tauri::command]
pub fn git_stash_drop(path: String, index: u32) -> Result<(), String> {
    run_git(&path, &["stash", "drop", &format!("stash@{{{index}}}")]).map(|_| ())
}

/// Blame info for a single line, returned by `git_blame`.
#[derive(Serialize)]
pub struct BlameHunk {
    /// Short commit SHA (7 chars) — empty for uncommitted lines.
    pub short: String,
    /// Author name.
    pub author: String,
    /// Author date in relative format, e.g. "3 days ago".
    pub date: String,
    /// First line of the commit message.
    pub subject: String,
    /// 1-based line number in the final file.
    pub line: u32,
}

/// Returns per-line blame info for `file` (absolute path) inside repo at `root`.
/// Lines that have never been committed get placeholder values with empty `short`.
#[tauri::command]
pub fn git_blame(root: String, file: String) -> Result<Vec<BlameHunk>, String> {
    if run_git(&root, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    // --porcelain: machine-readable. -M: detect moved lines within the file.
    let raw = run_git(&root, &["blame", "--porcelain", "-M", "--", &file])?;
    Ok(parse_blame(&raw))
}

/// Parses `git blame --porcelain` output into per-line `BlameHunk`s. Shared with
/// the remote (SSH) blame over `exec_git`.
pub(crate) fn parse_blame(raw: &str) -> Vec<BlameHunk> {
    use std::collections::HashMap;

    let mut hunks: Vec<BlameHunk> = Vec::new();

    // State for the hunk being accumulated.
    let mut cur_hash = String::new();
    let mut cur_line: u32 = 0;
    // Per-commit metadata cache keyed by 40-char hash — git omits headers on repeat hunks.
    let mut cache: HashMap<String, (String, String, String)> = HashMap::new();

    for raw_line in raw.lines() {
        if raw_line.starts_with('\t') {
            // TAB-prefixed line = actual file content. Emit the accumulated hunk.
            let (author, date, subject) = if cur_hash.bytes().all(|b| b == b'0') {
                // All-zero hash = uncommitted (working-tree change).
                ("Não commitado".to_string(), String::new(), String::new())
            } else {
                cache.get(&cur_hash).cloned().unwrap_or_default()
            };
            hunks.push(BlameHunk {
                short: if cur_hash.bytes().all(|b| b == b'0') {
                    String::new()
                } else {
                    cur_hash[..7.min(cur_hash.len())].to_string()
                },
                author,
                date,
                subject,
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
            cache.entry(cur_hash.clone()).or_default().0 = rest.to_string();
        } else if let Some(rest) = raw_line.strip_prefix("author-time ") {
            if let Ok(ts) = rest.trim().parse::<i64>() {
                cache.entry(cur_hash.clone()).or_default().1 = format_relative_time(ts);
            }
        } else if let Some(rest) = raw_line.strip_prefix("summary ") {
            cache.entry(cur_hash.clone()).or_default().2 = rest.to_string();
        }
    }

    hunks
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
pub fn git_log(path: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    // Unit separator (\x1f) between fields, record separator (\x1e) between rows
    // — safe against any character that could appear in a subject.
    let fmt = "--pretty=format:%H\x1f%h\x1f%an\x1f%ar\x1f%s\x1e";
    let raw = run_git(&path, &["log", &format!("-{limit}"), "--no-color", fmt])?;

    parse_log_records(&raw)
}

/// History of a single file (ISSUE-71 · File History): the commits that touched
/// `file` (absolute path or path relative to the repo at `path`), newest first.
/// Reuses the same `GitCommit` shape as `git_log`, adding `--follow` so renames
/// are tracked across history. Returns an empty list when not a repo.
#[tauri::command]
pub fn git_log_file(path: String, file: String, limit: u32) -> Result<Vec<GitCommit>, String> {
    if run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return Ok(Vec::new());
    }
    let fmt = "--pretty=format:%H\x1f%h\x1f%an\x1f%ar\x1f%s\x1e";
    let raw = run_git(
        &path,
        &[
            "log",
            &format!("-{limit}"),
            "--no-color",
            "--follow",
            fmt,
            "--",
            &file,
        ],
    )?;
    parse_log_records(&raw)
}

/// Parses the `%H\x1f%h\x1f%an\x1f%ar\x1f%s\x1e` record stream shared by the
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
        if fields.len() >= 5 {
            commits.push(GitCommit {
                hash: fields[0].to_string(),
                short: fields[1].to_string(),
                author: fields[2].to_string(),
                date: fields[3].to_string(),
                subject: fields[4].to_string(),
            });
        }
    }
    Ok(commits)
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
pub fn git_snapshot_create(path: String) -> Result<GitSnapshot, String> {
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
pub fn git_snapshot_restore(path: String, snapshot_id: String, head: String) -> Result<(), String> {
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
}
