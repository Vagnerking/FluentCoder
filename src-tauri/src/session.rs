//! Persisted UI session — currently just the last opened project folder, so the
//! app can reopen it on launch. Stored as a small JSON file in the app data dir.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// What we remember between runs. Kept as a struct so more fields (open tabs,
/// active view, etc.) can be added later without changing the command surface.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Absolute path of the last opened project folder, if any.
    #[serde(default)]
    pub last_folder: Option<String>,
}

/// Path to the session file: `<app_data>/session.json`.
fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Sem diretório de dados do app: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// Loads the saved session (defaults if the file is absent or unreadable).
#[tauri::command]
pub fn session_load(app: AppHandle) -> Result<Session, String> {
    let path = session_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("Sessão inválida: {e}")),
        // No file yet (first run) is not an error — return an empty session.
        Err(_) => Ok(Session::default()),
    }
}

/// Records the last opened project folder. Passing an empty/None path clears it,
/// e.g. so a deleted folder isn't reopened forever.
#[tauri::command]
pub fn session_set_last_folder(app: AppHandle, folder: Option<String>) -> Result<(), String> {
    let path = session_file(&app)?;
    let session = Session {
        last_folder: folder.filter(|f| !f.is_empty()),
    };
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Falha ao salvar sessão: {e}"))
}
