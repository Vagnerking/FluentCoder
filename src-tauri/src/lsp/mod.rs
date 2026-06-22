//! Generic, server-agnostic LSP infrastructure.
//!
//! Mirrors the long-lived-process management style of `terminal.rs`
//! (`Mutex<HashMap<String, _>>` keyed by id), but for language servers: each
//! session owns a spawned process proxied through a local WebSocket bridge.
//!
//! tokio lives **only** here — `terminal.rs` stays synchronous.

pub mod bridge;
pub mod build;
pub mod codec;
pub mod csharp;
pub mod npm_server;
pub mod process;
pub mod razor;
pub mod system_server;
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

// NOTE: these acquisition commands are `async fn` ON PURPOSE. A sync (`fn`)
// Tauri command runs on the UI thread; doing a `block_on` of a slow download /
// `npm install` there froze the whole interface. As async commands they run off
// the UI thread, and we run the actual work on the LSP runtime's dedicated pool
// (where the inner `spawn_blocking`/reqwest already expect a tokio runtime), so
// downloads never block the UI — failures just surface as a rejected promise.

/// Ensures the Roslyn C# server is downloaded/cached and `dotnet` is present.
///
/// Returns the launch command as `"<program>\n<arg1>\n<arg2>…"` (program on the
/// first line). The frontend splits this and feeds it to `lsp_start_server`.
#[tauri::command]
pub async fn lsp_ensure_csharp_server(
    root_path: String,
    state: State<'_, LspState>,
    app: AppHandle,
) -> Result<String, String> {
    let root = PathBuf::from(&root_path);
    let handle = state.runtime.handle().clone();
    let (program, args) = handle
        .spawn(async move { csharp::roslyn_launch_command(&app, &root).await })
        .await
        .map_err(|e| format!("falha ao preparar o servidor C#: {e}"))??;

    let mut lines = vec![program];
    lines.extend(args);
    Ok(lines.join("\n"))
}

/// Resolves the launch command for `typescript-language-server` in a project.
///
/// Returns `{ program, args }`; the frontend forwards it to `lsp_start_server`.
/// Auto-installs the server into the app cache (via npm) when it isn't found in
/// the project or globally, reporting progress through `lsp-download-progress`.
#[tauri::command]
pub async fn lsp_ensure_ts_server(
    root_path: String,
    prefer_editor: bool,
    state: State<'_, LspState>,
    app: AppHandle,
) -> Result<typescript::LaunchInfo, String> {
    let root = PathBuf::from(root_path);
    let handle = state.runtime.handle().clone();
    handle
        .spawn(async move { typescript::resolve_ts_launch(&app, &root, prefer_editor).await })
        .await
        .map_err(|e| format!("falha ao preparar o servidor TypeScript: {e}"))?
}

/// The TypeScript versions available for a project (its own + the editor's), so
/// the UI can show real version numbers in the "Select TS Version" picker.
#[tauri::command]
pub fn lsp_ts_versions(root_path: String, app: AppHandle) -> typescript::TsVersions {
    typescript::ts_versions(&app, &PathBuf::from(root_path))
}

/// Resolves the launch command for an npm-distributed language server (Python,
/// YAML, JSON/HTML/CSS, Bash, Dockerfile, …), installing it into the app cache on
/// first use. The frontend forwards `{ program, args }` to `lsp_start_server`.
#[tauri::command]
pub async fn lsp_ensure_npm_server(
    server_id: String,
    state: State<'_, LspState>,
    app: AppHandle,
) -> Result<npm_server::LaunchInfo, String> {
    let spec = npm_server::spec_for(&server_id)
        .ok_or_else(|| format!("servidor LSP desconhecido: {server_id}"))?;
    let handle = state.runtime.handle().clone();
    handle
        .spawn(async move { npm_server::ensure_npm_server(&app, &spec).await })
        .await
        .map_err(|e| format!("falha ao preparar o servidor de linguagem: {e}"))?
}

/// Resolves the launch command for an SDK-provided language server (Dart, Go, …)
/// from the user's PATH — no download. Errors with an install hint if missing.
#[tauri::command]
pub fn lsp_ensure_system_server(
    server_id: String,
) -> Result<system_server::LaunchInfo, String> {
    let spec = system_server::spec_for(&server_id)
        .ok_or_else(|| format!("servidor LSP desconhecido: {server_id}"))?;
    system_server::resolve_system_server(&spec)
}
