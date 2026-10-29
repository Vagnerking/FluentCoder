//! Descoberta de repositórios (local).
//!
//! "Repositório" deixou de ser "pasta do workspace": uma pasta dentro de um repo
//! já listado é o MESMO repo (antes virava um segundo painel e dobrava os
//! contadores da status bar). Para cada pasta resolvemos o toplevel e, até
//! `max_depth` níveis abaixo dela, procuramos repos aninhados (clones dentro da
//! pasta, submódulos, worktrees como subpasta) — como o
//! `git.repositoryScanMaxDepth` do VS Code. O resultado é deduplicado por
//! toplevel e traz o tipo (`main`/`worktree`/`submodule`/`nested`) e o repo pai.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Pastas nunca varridas atrás de repos aninhados (custo e falsos positivos).
const SCAN_IGNORED: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", "bin", "obj", ".venv", "venv",
    "vendor", ".next", ".cache", "__pycache__",
];

/// Profundidade máxima aceita (evita varreduras patológicas).
pub(crate) const MAX_SCAN_DEPTH: u32 = 5;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Chave estável: o toplevel normalizado.
    pub id: String,
    /// `rev-parse --show-toplevel`.
    pub root: String,
    pub git_dir: String,
    /// `--git-common-dir`: igual para todas as worktrees de um repo.
    pub common_dir: String,
    /// `main`, `worktree`, `submodule` ou `nested`.
    pub kind: String,
    /// Repo "pai": a worktree principal (para `worktree`) ou o repo que contém
    /// o aninhado/submódulo.
    pub parent_root: Option<String>,
    /// Pastas do workspace que caem dentro deste repo (e não num mais profundo).
    pub folders: Vec<String>,
}

fn norm(p: &str) -> String {
    // Git expands Windows 8.3 aliases while workspace folders may retain them.
    // Resolve existing paths before comparing identity; do not lowercase paths
    // because case-sensitive directories can exist on Windows too.
    #[cfg(windows)]
    let canonical = std::fs::canonicalize(p).ok();
    #[cfg(windows)]
    let p = canonical.as_deref().and_then(Path::to_str).unwrap_or(p);
    #[cfg(windows)]
    let expanded;
    #[cfg(windows)]
    let p = if let Some(unc) = p.strip_prefix(r"\\?\UNC\") {
        expanded = format!(r"\\{unc}");
        expanded.as_str()
    } else {
        p.strip_prefix(r"\\?\").unwrap_or(p)
    };
    let s = p.replace('\\', "/");
    let t = s.trim_end_matches('/');
    if t.is_empty() { "/".into() } else { t.to_string() }
}

fn within(path: &str, root: &str) -> bool {
    let (p, r) = (norm(path), norm(root));
    p == r || p.starts_with(&format!("{}/", r.trim_end_matches('/')))
}

struct Resolved {
    root: String,
    git_dir: String,
    common_dir: String,
}

fn resolve(path: &Path) -> Option<Resolved> {
    let out = super::run_git(
        path.to_str()?,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    )
    .ok()?;
    let mut lines = out.lines().map(str::trim);
    let root = lines.next()?.to_string();
    let git_dir = lines.next()?.to_string();
    let common_dir = lines.next().unwrap_or(&git_dir).to_string();
    if root.is_empty() {
        return None;
    }
    Some(Resolved { root, git_dir, common_dir })
}

/// Diretórios com `.git` (pasta ou arquivo) até `max_depth` níveis abaixo de `start`.
fn scan_nested(start: &Path, max_depth: u32) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut frontier = vec![start.to_path_buf()];
    for _ in 0..max_depth {
        let mut next = Vec::new();
        for dir in frontier {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                if !ft.is_dir() || ft.is_symlink() {
                    continue;
                }
                let name = entry.file_name();
                if SCAN_IGNORED.iter().any(|ignored| name == *ignored) {
                    continue;
                }
                let path = entry.path();
                if path.join(".git").exists() {
                    found.push(path.clone());
                }
                next.push(path);
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }
    found
}

/// Descobre e deduplica os repos das pastas. Puro sobre o FS + git; testado.
pub(crate) fn discover(folders: &[String], max_depth: u32) -> Vec<RepoInfo> {
    let max_depth = max_depth.min(MAX_SCAN_DEPTH);
    let mut by_root: HashMap<String, RepoInfo> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut add = |resolved: Resolved, nested_under: Option<String>| {
        let id = norm(&resolved.root);
        if by_root.contains_key(&id) {
            return id;
        }
        let is_worktree = norm(&resolved.git_dir) != norm(&resolved.common_dir);
        let is_submodule = norm(&resolved.git_dir).contains("/.git/modules/");
        let (kind, parent_root) = if is_worktree {
            let common = norm(&resolved.common_dir);
            let main = common.strip_suffix("/.git").map(str::to_string);
            ("worktree", main)
        } else if is_submodule {
            ("submodule", nested_under.clone())
        } else if nested_under.is_some() {
            ("nested", nested_under.clone())
        } else {
            ("main", None)
        };
        by_root.insert(
            id.clone(),
            RepoInfo {
                id: id.clone(),
                root: resolved.root,
                git_dir: resolved.git_dir,
                common_dir: resolved.common_dir,
                kind: kind.into(),
                parent_root,
                folders: Vec::new(),
            },
        );
        order.push(id.clone());
        id
    };

    for folder in folders {
        let path = Path::new(folder);
        let container = resolve(path).map(|r| add(r, None));
        for nested in scan_nested(path, max_depth) {
            if let Some(resolved) = resolve(&nested) {
                // `.git` dentro de pasta ignorada pelo repo pai também conta
                // (clones dentro do workspace): o toplevel é o próprio dir.
                if container.as_deref().is_some_and(|c| norm(&resolved.root) == *c) {
                    continue;
                }
                add(resolved, container.clone());
            }
        }
    }
    drop(add);

    // Pasta → repo mais profundo que a contém.
    let mut repos: Vec<RepoInfo> = order.iter().filter_map(|id| by_root.remove(id)).collect();
    for folder in folders {
        if let Some(best) = repos
            .iter_mut()
            .filter(|repo| within(folder, &repo.root))
            .max_by_key(|repo| repo.root.len())
        {
            if !best.folders.iter().any(|f| norm(f) == norm(folder)) {
                best.folders.push(folder.clone());
            }
        }
    }
    repos
}

/// Descobre os repos locais das pastas do workspace (deduplicados por
/// toplevel; aninhados até `max_depth`, padrão 1).
#[tauri::command]
pub async fn git_repos_discover(folders: Vec<String>, max_depth: Option<u32>) -> Result<Vec<RepoInfo>, String> {
    super::runner::blocking(move || Ok(discover(&folders, max_depth.unwrap_or(1)))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{sh_git, TempRepo};

    #[test]
    fn subfolder_of_listed_repo_is_the_same_repo() {
        let repo = TempRepo::new();
        repo.write("docs/a.md", "a\n");
        repo.commit_all("a");
        let docs = repo.file("docs").to_string_lossy().to_string();
        let repos = discover(&[repo.root(), docs.clone()], 1);
        assert_eq!(repos.len(), 1, "{repos:?}");
        assert_eq!(repos[0].kind, "main");
        assert_eq!(repos[0].folders, vec![repo.root(), docs]);
        // Só a subpasta aberta: o repo é o toplevel.
        let only_docs = discover(&[repo.file("docs").to_string_lossy().to_string()], 1);
        assert_eq!(norm(&only_docs[0].root), norm(&repo.root()));
    }

    #[test]
    fn nested_repos_respect_depth_and_ignored_folders() {
        let outer = TempRepo::new();
        outer.write(".gitignore", "libs/\n");
        outer.commit_all("outer");
        let ui = outer.file("libs/ui");
        std::fs::create_dir_all(&ui).unwrap();
        sh_git(&ui, &["init", "-q"]);
        let junk = outer.file("node_modules/pkg");
        std::fs::create_dir_all(&junk).unwrap();
        sh_git(&junk, &["init", "-q"]);

        let shallow = discover(&[outer.root()], 1);
        assert_eq!(shallow.len(), 1, "profundidade 1 não chega em libs/ui");
        let deep = discover(&[outer.root()], 2);
        assert_eq!(deep.len(), 2, "{deep:?}");
        let nested = deep.iter().find(|r| r.kind == "nested").unwrap();
        assert!(norm(&nested.root).ends_with("/libs/ui"));
        assert_eq!(nested.parent_root.as_deref().map(norm), Some(norm(&outer.root())));
        assert!(!deep.iter().any(|r| r.root.contains("node_modules")));
    }

    #[test]
    fn worktree_folder_is_its_own_repo_linked_to_main() {
        let repo = TempRepo::new();
        repo.write("a.txt", "a\n");
        repo.commit_all("a");
        let parent = tempfile::tempdir().unwrap();
        let wt = parent.path().join("wt");
        repo.git(&["worktree", "add", "-q", "-b", "feat/wt", wt.to_str().unwrap()]);
        let repos = discover(&[repo.root(), wt.to_string_lossy().to_string()], 1);
        assert_eq!(repos.len(), 2);
        let w = repos.iter().find(|r| r.kind == "worktree").expect("worktree");
        assert_eq!(w.parent_root.as_deref().map(norm), Some(norm(&repo.root())));
        assert_eq!(norm(&w.common_dir), norm(&repos[0].common_dir));
        // Worktree aninhada (subpasta do repo principal) também é descoberta.
        let inner = repo.file("wt-inner");
        repo.git(&["worktree", "add", "-q", "-b", "feat/in", inner.to_str().unwrap()]);
        let repos = discover(&[repo.root()], 1);
        assert!(repos.iter().any(|r| r.kind == "worktree" && norm(&r.root).ends_with("/wt-inner")), "{repos:?}");
    }

    #[test]
    fn submodule_is_discovered_with_parent() {
        let lib = TempRepo::new();
        lib.write("lib.txt", "l\n");
        lib.commit_all("lib");
        let app = TempRepo::new();
        app.write("app.txt", "a\n");
        app.commit_all("app");
        app.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", &lib.root(), "vendor-lib"]);
        let repos = discover(&[app.root()], 1);
        let sub = repos.iter().find(|r| r.kind == "submodule").expect("submódulo");
        assert!(norm(&sub.root).ends_with("/vendor-lib"));
        assert_eq!(sub.parent_root.as_deref().map(norm), Some(norm(&app.root())));
    }

    #[test]
    fn plain_folder_yields_nothing() {
        let plain = tempfile::tempdir().unwrap();
        assert!(discover(&[plain.path().to_string_lossy().to_string()], 2).is_empty());
    }
}
