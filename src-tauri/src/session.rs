//! Persisted UI session — the last opened project folder plus the tabs that were
//! open in it, so the app can reopen the project AND restore the same editor tabs
//! on launch. Stored as a small JSON file in the app data dir.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// One open editor tab to restore on launch. Only the absolute `path` and the
/// view `mode` are persisted — the content is re-read from disk on reopen, so
/// neither the buffer text nor its `dirty` flag is saved. `mode` is optional so
/// the front can fall back to its `defaultModeFor` heuristic when it's absent.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenTab {
    /// Absolute path of the file backing this tab.
    pub path: String,
    /// Persisted view ("text" | "image"); `None` ⇒ let the front decide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// What we remember between runs. New fields stay `#[serde(default)]` so older
/// session files (which only had `lastFolder`) keep loading without error.
///
/// The tab list is stored flat (`open_tabs` + `active_path`) to mirror the
/// current single-group editor model. If the split/groups feature lands later,
/// it can add a `groups` field and migrate this flat pair into a single group
/// without breaking old files — see issue #7's "Compatibilidade com grupos".
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Absolute path of the last opened project folder, if any.
    #[serde(default)]
    pub last_folder: Option<String>,
    /// Tabs that were open in that folder, in tab-bar (left-to-right) order.
    /// Flat fallback (the active group's tabs) for when `layout` is absent.
    #[serde(default)]
    pub open_tabs: Vec<OpenTab>,
    /// Absolute path of the tab that was active, if any.
    #[serde(default)]
    pub active_path: Option<String>,
    /// The editor split grid as an opaque JSON blob owned by the frontend (tree
    /// of groups + each group's tabs). Restores the whole split layout, not just
    /// the active group. Absent ⇒ restore the flat `open_tabs` into one group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
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

/// Reads the current session from disk, or a default one if it's absent/invalid.
/// Used by the read-modify-write setters so updating one field never clobbers
/// the others.
fn read_session(app: &AppHandle) -> Result<Session, String> {
    let path = session_file(app)?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        // No file yet (first run) is not an error — return an empty session.
        Err(_) => Ok(Session::default()),
    }
}

/// Serializes `session` back to the session file (pretty JSON).
fn write_session(app: &AppHandle, session: &Session) -> Result<(), String> {
    let path = session_file(app)?;
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Falha ao salvar sessão: {e}"))
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
/// e.g. so a deleted folder isn't reopened forever. Reads the existing session
/// first so the open tabs and active path are preserved.
#[tauri::command]
pub fn session_set_last_folder(app: AppHandle, folder: Option<String>) -> Result<(), String> {
    let mut session = read_session(&app)?;
    session.last_folder = folder.filter(|f| !f.is_empty());
    write_session(&app, &session)
}

/// Records the open tabs and the active tab for the current folder, leaving the
/// stored `last_folder` untouched. Called (debounced) by the front whenever the
/// tab list or the active file changes.
#[tauri::command]
pub fn session_set_open_files(
    app: AppHandle,
    tabs: Vec<OpenTab>,
    active_path: Option<String>,
    layout: Option<String>,
) -> Result<(), String> {
    let mut session = read_session(&app)?;
    session.open_tabs = tabs;
    session.active_path = active_path.filter(|p| !p.is_empty());
    session.layout = layout.filter(|l| !l.is_empty());
    write_session(&app, &session)
}
