//! Gerenciamento de extensões VS Code: pasta PRÓPRIA do app
//! (`<app_data>/extensions`) e descoberta (app + `~/.vscode/extensions`
//! somente leitura). Contratos: docs/context/extensoes-vscode.md.

pub mod semver;
pub mod store;
pub mod vsix;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use store::InstalledInfo;

static CLEANED: OnceLock<()> = OnceLock::new();

/// `<app_data>/extensions` (ou `FLUENT_APP_EXTENSIONS_DIR`, usado em testes).
pub fn managed_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var("FLUENT_APP_EXTENSIONS_DIR") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Falha ao obter a pasta de dados do app: {e}"))?
            .join("extensions"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Falha ao criar {}: {e}", dir.display()))?;
    CLEANED.get_or_init(|| store::cleanup_leftovers(&dir));
    Ok(dir)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionPaths {
    pub managed_dir: String,
    pub vscode_dir: Option<String>,
    pub platform: &'static str,
}

#[tauri::command]
pub fn extensions_paths(app: AppHandle) -> Result<ExtensionPaths, String> {
    Ok(ExtensionPaths {
        managed_dir: managed_dir(&app)?.to_string_lossy().into_owned(),
        vscode_dir: store::vscode_extensions_dir().map(|p| p.to_string_lossy().into_owned()),
        platform: store::host_platform(),
    })
}

#[tauri::command]
pub async fn extensions_list(app: AppHandle) -> Result<Vec<InstalledInfo>, String> {
    let dir = managed_dir(&app)?;
    let vdir = store::vscode_extensions_dir();
    tokio::task::spawn_blocking(move || store::discover(&dir, vdir.as_deref())).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn extensions_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let id = id.trim().to_lowercase();
    store::set_enabled(&managed_dir(&app)?, &id, enabled)
}
