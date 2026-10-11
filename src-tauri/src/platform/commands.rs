//! Comandos Tauri do módulo de plataforma. Todos `async` + `spawn_blocking`:
//! esperar `gdbus`/`open -R` nunca pode travar a main thread (event loop GTK).

use super::{PlatformInfo, ShellSpec};
use std::path::PathBuf;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("tarefa de plataforma falhou: {e}"))?
}

/// Canonicaliza `path` e, com `workspace_root`, exige que ele fique dentro.
fn checked_path(workspace_root: Option<&str>, path: &str) -> Result<PathBuf, String> {
    let target = std::fs::canonicalize(path).map_err(|e| format!("Não foi possível acessar o item: {e}"))?;
    if let Some(root) = workspace_root.filter(|r| !r.trim().is_empty()) {
        let root = std::fs::canonicalize(root).map_err(|e| format!("Não foi possível validar o workspace: {e}"))?;
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
pub async fn platform_reveal_path(workspace_root: Option<String>, path: String) -> Result<(), String> {
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
pub async fn platform_open_path(workspace_root: Option<String>, path: String) -> Result<(), String> {
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
