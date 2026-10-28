//! Comandos Tauri do módulo de plataforma. Todos `async` + `spawn_blocking`:
//! esperar `gdbus`/`open -R` nunca pode travar a main thread (event loop GTK).

use super::{PlatformInfo, ShellSpec};
use std::path::PathBuf;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("tarefa de plataforma falhou: {e}"))?
}

/// Canonicaliza `path` e, com `workspace_root`, exige que ele fique dentro.
fn checked_path(workspace_root: Option<&str>, path: &str) -> Result<PathBuf, String> {
    let target =
        std::fs::canonicalize(path).map_err(|e| format!("Não foi possível acessar o item: {e}"))?;
    if let Some(root) = workspace_root.filter(|r| !r.trim().is_empty()) {
        let root = std::fs::canonicalize(root)
            .map_err(|e| format!("Não foi possível validar o workspace: {e}"))?;
        if !target.starts_with(&root) {
            return Err("O item está fora do workspace.".into());
        }
    }
    Ok(target)
}

#[tauri::command]
pub async fn platform_info() -> PlatformInfo {
    super::info()
}

/// Revela `path` no gerenciador de arquivos (Explorer / Finder / Files…).
#[tauri::command]
pub async fn platform_reveal_path(
    workspace_root: Option<String>,
    path: String,
) -> Result<(), String> {
    blocking(move || {
        let target = checked_path(workspace_root.as_deref(), &path)?;
        super::reveal_in_file_manager(&target)
    })
    .await
}

/// Abre uma URL http(s)/mailto no navegador/cliente do sistema.
#[tauri::command]
pub async fn platform_open_external(url: String) -> Result<(), String> {
    blocking(move || super::open_external_url(&url)).await
}

/// Abre um arquivo/pasta local no app padrão do sistema.
#[tauri::command]
pub async fn platform_open_path(
    workspace_root: Option<String>,
    path: String,
) -> Result<(), String> {
    blocking(move || {
        let target = checked_path(workspace_root.as_deref(), &path)?;
        super::open_path(&target)
    })
    .await
}

/// Shell padrão do terminal integrado (para exibir/perfis).
#[tauri::command]
pub async fn platform_default_shell() -> Result<ShellSpec, String> {
    blocking(|| Ok(super::default_shell())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_existing_workspace_items_and_explicit_unscoped_items() {
        let dir = tempfile::tempdir().unwrap();
        let item = dir.path().join("ação com espaços.txt");
        std::fs::write(&item, "content").unwrap();
        let expected = item.canonicalize().unwrap();
        assert_eq!(
            checked_path(Some(dir.path().to_str().unwrap()), item.to_str().unwrap()).unwrap(),
            expected
        );
        assert_eq!(
            checked_path(None, item.to_str().unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn rejects_sibling_prefix_and_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let sibling = dir.path().join("workspace-other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let item = sibling.join("item.txt");
        std::fs::write(&item, "content").unwrap();
        for target in [item, root.join("..").join("workspace-other/item.txt")] {
            assert!(checked_path(Some(root.to_str().unwrap()), target.to_str().unwrap()).is_err());
        }
    }

    #[test]
    fn rejects_missing_items_and_missing_workspace_roots() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert!(checked_path(None, missing.to_str().unwrap()).is_err());
        assert!(checked_path(
            Some(missing.to_str().unwrap()),
            dir.path().to_str().unwrap()
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlinks_before_applying_the_optional_workspace_constraint() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let inside = root.join("inside.txt");
        let outside = dir.path().join("outside.txt");
        std::fs::write(&inside, "inside").unwrap();
        std::fs::write(&outside, "outside").unwrap();
        let allowed = root.join("allowed-link");
        let denied = root.join("outside-link");
        std::os::unix::fs::symlink(&inside, &allowed).unwrap();
        std::os::unix::fs::symlink(&outside, &denied).unwrap();
        assert_eq!(
            checked_path(Some(root.to_str().unwrap()), allowed.to_str().unwrap()).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(checked_path(Some(root.to_str().unwrap()), denied.to_str().unwrap()).is_err());
    }
}
