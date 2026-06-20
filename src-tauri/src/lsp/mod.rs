//! Generic, server-agnostic LSP infrastructure.
//!
//! Mirrors the long-lived-process management style of `terminal.rs`
//! (`Mutex<HashMap<String, _>>` keyed by id), but for language servers: each
//! session owns a spawned process proxied through a local WebSocket bridge.
//!
//! tokio lives **only** here — `terminal.rs` stays synchronous.

pub mod bridge;
pub mod codec;
pub mod csharp;
pub mod process;
pub mod razor;
pub mod typescript;

use bridge::{start_bridge, BridgeHandle, BridgeInfo};
use process::LspProcess;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tokio::runtime::Runtime;

/// One active language server: its bridge handle (port + token + shutdown).
struct LspServerSession {
    bridge: BridgeHandle,
}

/// App-wide LSP state: a dedicated multi-thread tokio runtime plus the table of
/// active sessions keyed by free-form server id (`"csharp"`, `"typescript"`…).
pub struct LspState {
    runtime: Runtime,
    sessions: Mutex<HashMap<String, LspServerSession>>,
}

impl LspState {
    pub fn new() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build LSP tokio runtime");
        LspState {
            runtime,
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for LspState {
    fn default() -> Self {
        Self::new()
    }
}

impl LspState {
    /// Shuts down every active LSP session (each bridge kills its server process)
    /// and clears the table. Called on window close so no language server is left
    /// orphaned holding the app open.
    ///
    /// `shutdown()` only signals the bridge task; the actual `process.kill()` runs
    /// asynchronously on this state's tokio runtime. We give that runtime a brief
    /// window to drain those kills before the process exits, so servers are
    /// reaped rather than orphaned.
    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_id, mut session) in sessions.drain() {
                session.bridge.shutdown();
            }
        }
        // Let the bridge tasks observe the shutdown signal and kill their child
        // processes. Bounded so a stuck server can't block app exit.
        self.runtime.block_on(async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        });
    }
}

/// Spawns an LSP server and brings up its local WS bridge. If a session with the
/// same `id` already exists it is stopped first (no duplicate instances).
#[tauri::command]
pub fn lsp_start_server(
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    state: State<'_, LspState>,
) -> Result<BridgeInfo, String> {
    // Replace any existing session with this id.
    let existing = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(mut session) = existing {
        session.bridge.shutdown();
    }

    let cwd_path = PathBuf::from(&cwd);
    let server_id = id.clone();

    let bridge = state.runtime.block_on(async move {
        let mut process = LspProcess::spawn(&program, &args, &cwd_path, &[])
            .map_err(|e| format!("failed to spawn LSP server: {e}"))?;
        process.forward_stderr(server_id);
        start_bridge(process)
            .await
            .map_err(|e| format!("failed to start LSP bridge: {e}"))
    })?;

    let info = bridge.info();
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(id, LspServerSession { bridge });
    Ok(info)
}

/// Stops the LSP server with the given id and tears down its bridge/process.
#[tauri::command]
pub fn lsp_stop_server(id: String, state: State<'_, LspState>) -> Result<(), String> {
    let session = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(mut session) = session {
        session.bridge.shutdown();
    }
    Ok(())
}

/// Returns the `{ port, token }` of an existing session (used for reconnection).
#[tauri::command]
pub fn lsp_bridge_info(id: String, state: State<'_, LspState>) -> Result<BridgeInfo, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions
        .get(&id)
        .map(|s| s.bridge.info())
        .ok_or_else(|| format!("no active LSP session for id '{id}'"))
}

/// Ensures the Roslyn C# server is downloaded/cached and `dotnet` is present.
///
/// Returns the launch command as `"<program>\n<arg1>\n<arg2>…"` (program on the
/// first line). The frontend splits this and feeds it to `lsp_start_server`.
#[tauri::command]
pub fn lsp_ensure_csharp_server(
    root_path: String,
    state: State<'_, LspState>,
    app: AppHandle,
) -> Result<String, String> {
    let root = PathBuf::from(&root_path);
    let (program, args) = state
        .runtime
        .block_on(async move { csharp::roslyn_launch_command(&app, &root).await })?;

    let mut lines = vec![program];
    lines.extend(args);
    Ok(lines.join("\n"))
}

/// Resolves the launch command for `typescript-language-server` in a project.
///
/// Returns `{ program, args }`; the frontend forwards it to `lsp_start_server`.
/// Errors with an actionable message if Node or the server isn't installed.
#[tauri::command]
pub fn lsp_ensure_ts_server(root_path: String) -> Result<typescript::LaunchInfo, String> {
    let root = PathBuf::from(root_path);
    typescript::ts_launch_command(&root)
}
