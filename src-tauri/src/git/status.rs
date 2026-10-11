//! `git status --porcelain=v2 -z --branch` → [`GitStatus`].
//!
//! Com `-z` os caminhos saem crus (sem aspas nem escapes octais), então nomes
//! com acentos, espaços, tabs ou aspas funcionam; renames trazem o caminho de
//! origem como entrada NUL seguinte; conflitos (`u`) têm 10 campos antes do
//! caminho. O parser também aceita a saída sem `-z` (linhas), para
//! compatibilidade com chamadores antigos.

use super::{GitFileStatus, GitStatus};

/// Argumentos do status (local e SSH).
pub(crate) const STATUS_ARGS: [&str; 4] = ["status", "--porcelain=v2", "-z", "--branch"];

/// Parser puro. `is_repo = true`; o chamador decide repo-ness antes.
pub(crate) fn parse_status(raw: &str) -> GitStatus {
    let z = raw.contains('\0');
    let mut entries: Box<dyn Iterator<Item = &str>> = if z {
        Box::new(raw.split('\0'))
    } else {
        Box::new(raw.lines())
    };

    let mut branch = String::new();
    let mut oid = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut has_upstream = false;
    let mut conflicted = 0u32;
    let mut files = Vec::new();

    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(rest) = entry.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = entry.strip_prefix("# branch.oid ") {
            oid = rest.trim().to_string();
        } else if entry.starts_with("# branch.upstream ") {
            has_upstream = true;
        } else if let Some(rest) = entry.strip_prefix("# branch.ab ") {
            has_upstream = true;
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = entry.strip_prefix("1 ") {
            // XY sub mH mI mW hH hI <path>
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            if fields.len() == 8 {
                files.push(changed(fields[0], fields[7].to_string(), None));
            }
        } else if let Some(rest) = entry.strip_prefix("2 ") {
            // XY sub mH mI mW hH hI Xscore <path>[\t<orig>] (com -z: <path>\0<orig>)
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            if fields.len() == 9 {
                let (path, orig) = if z {
                    (fields[8].to_string(), entries.next().map(str::to_string))
                } else {
                    match fields[8].split_once('\t') {
                        Some((p, o)) => (p.to_string(), Some(o.to_string())),
                        None => (fields[8].to_string(), None),
                    }
                };
                files.push(changed(fields[0], path, orig));
            }
        } else if let Some(rest) = entry.strip_prefix("u ") {
            // XY sub m1 m2 m3 mW h1 h2 h3 <path>
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            if fields.len() == 10 {
                conflicted += 1;
                files.push(GitFileStatus {
                    path: fields[9].to_string(),
                    orig_path: None,
                    code: fields[0].to_string(),
                    staged: false,
                    untracked: false,
                    conflicted: true,
                });
            }
        } else if let Some(rest) = entry.strip_prefix("? ") {
            files.push(GitFileStatus {
                path: rest.to_string(),
                orig_path: None,
                code: "??".to_string(),
                staged: false,
                untracked: true,
                conflicted: false,
            });
        }
    }

    if branch == "(detached)" && oid.len() >= 7 && oid != "(initial)" {
        branch = format!("({}…)", &oid[..7]);
    }

    GitStatus {
        root: String::new(),
        branch,
        ahead,
        behind,
        is_repo: true,
        has_upstream,
        conflicted,
        files,
    }
}

fn changed(xy: &str, path: String, orig_path: Option<String>) -> GitFileStatus {
    GitFileStatus {
        path,
        orig_path,
        code: xy.to_string(),
        staged: xy.chars().next().is_some_and(|c| c != '.'),
        untracked: false,
        conflicted: false,
    }
}

/// Nome completo da branch (`feat/x`, não `x`) ou `(abc1234…)` destacado.
/// Usa o git (funciona em worktrees/submódulos, onde `.git` é um arquivo);
/// sem git no PATH, cai para a leitura de `HEAD` seguindo `gitdir:`.
pub(crate) fn current_branch(path: &str) -> Option<String> {
    match super::run_git(path, &["symbolic-ref", "--short", "-q", "HEAD"]) {
        Ok(out) if !out.trim().is_empty() => return Some(out.trim().to_string()),
        Ok(_) => {}
        Err(error) if super::is_not_repo_error(&error) => return None,
        Err(error) if error.starts_with("Falha ao executar git") => {
            return branch_from_head_file(std::path::Path::new(path));
        }
        Err(_) => {}
    }
    // `symbolic-ref -q` sai com 1 quando HEAD está destacado.
    super::run_git(path, &["rev-parse", "--short", "HEAD"])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
        .map(|sha| format!("({sha}…)"))
}

/// Fallback sem o CLI: acha o git dir (diretório **ou** arquivo `gitdir:`).
pub(crate) fn branch_from_head_file(start: &std::path::Path) -> Option<String> {
    let git_dir = find_git_dir(start)?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(rest) = head.strip_prefix("ref: ") {
        let name = rest.strip_prefix("refs/heads/").unwrap_or(rest);
        return Some(name.to_string());
    }
    if head.len() >= 7 {
        return Some(format!("({}…)", &head[..7]));
    }
    None
}

fn find_git_dir(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(".git");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if candidate.is_file() {
            // Worktree/submódulo: `.git` é um arquivo "gitdir: <caminho>".
            let text = std::fs::read_to_string(&candidate).ok()?;
            let target = text.trim().strip_prefix("gitdir:")?.trim();
            let target = std::path::Path::new(target);
            return Some(if target.is_absolute() {
                target.to_path_buf()
            } else {
                dir.join(target)
            });
        }
        current = dir.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::TempRepo;

    #[test]
    fn parses_z_output_with_unicode_spaces_renames_and_conflicts() {
        let raw = "# branch.oid 5999de02e4a30cc942c542314c40d16e63c05a96\0# branch.head feat/x\0\
# branch.upstream origin/feat/x\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 0f7b 0f7b café é.txt\0\
2 R. N... 100644 100644 100644 6178 6178 R100 nóvo arq.txt\0new.txt\0\
u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conf lito.md\0\
? untr ação.md\0";
        let s = parse_status(raw);
        assert_eq!(s.branch, "feat/x");
        assert_eq!((s.ahead, s.behind, s.has_upstream, s.conflicted), (2, 1, true, 1));
        let paths: Vec<&str> = s.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["café é.txt", "nóvo arq.txt", "conf lito.md", "untr ação.md"]);
        assert_eq!(s.files[1].orig_path.as_deref(), Some("new.txt"));
        assert!(s.files[1].staged);
        assert!(!s.files[0].staged);
        assert!(s.files[2].conflicted);
        assert!(s.files[3].untracked);
    }

    #[test]
    fn detached_head_uses_oid_without_extra_spawn() {
        let s = parse_status("# branch.oid abcdef0123456789\0# branch.head (detached)\0");
        assert_eq!(s.branch, "(abcdef0…)");
        let s = parse_status("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(s.branch, "main");
        assert!(!s.has_upstream);
    }

    #[test]
    fn legacy_line_output_still_parses() {
        let s = parse_status("# branch.head main\n2 R. N... 100644 100644 100644 a a R100 new name.ts\told name.ts\n");
        assert_eq!(s.files[0].path, "new name.ts");
        assert_eq!(s.files[0].orig_path.as_deref(), Some("old name.ts"));
    }

    /// Repo real: acentos, espaços, rename staged, conflito de merge e branch `feat/x`.
    #[test]
    fn real_repo_status_and_branch() {
        let repo = TempRepo::new();
        repo.write("base.txt", "1\n");
        repo.write("velho nome.txt", "v\n");
        repo.commit_all("base");
        repo.git(&["checkout", "-q", "-b", "feat/conflito"]);
        repo.write("base.txt", "feat\n");
        repo.commit_all("feat");
        repo.git(&["checkout", "-q", "main"]);
        repo.write("base.txt", "main\n");
        repo.commit_all("main");
        repo.git(&["checkout", "-q", "-b", "feat/x"]);
        let _ = std::process::Command::new("git")
            .args(["merge", "feat/conflito"])
            .current_dir(repo.path())
            .output();
        repo.git(&["mv", "velho nome.txt", "novo – nome.txt"]);
        repo.write("dir com espaço/ação ü.md", "x\n");

        let status = crate::git::git_status_blocking(repo.root()).unwrap();
        assert!(status.is_repo);
        assert_eq!(status.branch, "feat/x");
        assert_eq!(status.root.replace('\\', "/"), repo.root().replace('\\', "/"));
        assert_eq!(status.conflicted, 1);
        let find = |p: &str| status.files.iter().find(|f| f.path == p);
        assert!(find("base.txt").unwrap().conflicted);
        let renamed = find("novo – nome.txt").expect("rename com caractere unicode");
        assert_eq!(renamed.orig_path.as_deref(), Some("velho nome.txt"));
        assert!(find("dir com espaço/").is_some(), "{:?}", status.files.iter().map(|f| &f.path).collect::<Vec<_>>());

        assert_eq!(current_branch(&repo.root()).as_deref(), Some("feat/x"));
        assert_eq!(branch_from_head_file(repo.path()).as_deref(), Some("feat/x"));
    }

    #[test]
    fn worktree_branch_resolves_through_gitdir_file() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("a");
        let wt_parent = tempfile::tempdir().unwrap();
        let wt = wt_parent.path().join("wt dir");
        repo.git(&["worktree", "add", "-q", "-b", "feat/wt", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file());
        assert_eq!(branch_from_head_file(&wt.join("sub")).as_deref().or(branch_from_head_file(&wt).as_deref()), Some("feat/wt"));
        assert_eq!(current_branch(wt.to_str().unwrap()).as_deref(), Some("feat/wt"));
        let status = crate::git::git_status_blocking(wt.to_string_lossy().to_string()).unwrap();
        assert_eq!(status.branch, "feat/wt");
    }

    #[test]
    fn detached_and_non_repo() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("a");
        repo.git(&["checkout", "-q", "--detach"]);
        let b = current_branch(&repo.root()).unwrap();
        assert!(b.starts_with('(') && b.ends_with("…)"), "{b}");
        let status = crate::git::git_status_blocking(repo.root()).unwrap();
        assert_eq!(status.branch, b);
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(current_branch(plain.path().to_str().unwrap()), None);
        assert!(!crate::git::git_status_blocking(plain.path().to_string_lossy().to_string()).unwrap().is_repo);
    }
}
