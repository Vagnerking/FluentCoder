//! Repos git temporários reais para os testes de integração do módulo git.

use std::path::{Path, PathBuf};

pub(crate) struct TempRepo {
    pub dir: tempfile::TempDir,
}

pub(crate) fn sh_git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Ana Teste",
            "-c",
            "user.email=ana@example.com",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {:?} falhou: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

impl TempRepo {
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        sh_git(dir.path(), &["init", "-q"]);
        // Identidade local: os comandos do app leem user.name/email do repo.
        sh_git(dir.path(), &["config", "user.name", "Ana Teste"]);
        sh_git(dir.path(), &["config", "user.email", "ana@example.com"]);
        TempRepo { dir }
    }

    pub(crate) fn path(&self) -> &Path {
        self.dir.path()
    }

    pub(crate) fn root(&self) -> String {
        self.dir.path().to_string_lossy().to_string()
    }

    pub(crate) fn file(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    pub(crate) fn write(&self, rel: &str, content: &str) {
        let p = self.file(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    pub(crate) fn git(&self, args: &[&str]) -> String {
        sh_git(self.path(), args)
    }

    pub(crate) fn commit_all(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }
}
