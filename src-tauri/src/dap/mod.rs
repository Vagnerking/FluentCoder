//! Debug Adapter Protocol infrastructure (roadmap csharp-ide-parity, Fase B).
//!
//! Mirrors `lsp/mod.rs` one-to-one: a dedicated tokio runtime + a table of
//! debug sessions keyed by id, each owning a netcoredbg process proxied through
//! a loopback WebSocket bridge (`dap::bridge`). The frontend speaks raw DAP
//! JSON over the socket (one message per WS text frame; the bridge adds the
//! `Content-Length` framing the adapter's stdio expects).

pub mod bridge;
pub mod netcoredbg;

use bridge::{start_bridge, BridgeHandle, BridgeInfo};
use crate::lsp::process::LspProcess;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tokio::runtime::Runtime;

struct DapSession {
    bridge: BridgeHandle,
}

/// App-wide DAP state: dedicated runtime + active debug sessions by id.
pub struct DapState {
    runtime: Runtime,
    sessions: Mutex<HashMap<String, DapSession>>,
}

impl DapState {
    pub fn new() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build DAP tokio runtime");
        DapState { runtime, sessions: Mutex::new(HashMap::new()) }
    }

    /// Shuts down every active debug session (each bridge kills its adapter).
    /// Called on window close so no netcoredbg is left orphaned.
    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_id, mut session) in sessions.drain() {
                session.bridge.shutdown();
            }
        }
        // Let bridge tasks observe the signal and reap their children (bounded).
        self.runtime.block_on(async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        });
    }
}

impl Default for DapState {
    fn default() -> Self {
        Self::new()
    }
}

/// Downloads/locates netcoredbg and returns the executable path. `async` on
/// purpose: the first-use download must not block the UI thread.
#[tauri::command]
pub async fn dap_ensure_netcoredbg(app: AppHandle) -> Result<String, String> {
    let exe = netcoredbg::ensure_netcoredbg(&app).await?;
    Ok(exe.to_string_lossy().to_string())
}

/// Spawns a debug adapter (`program --interpreter=vscode`) and brings up its
/// bridge. An existing session with the same id is replaced.
#[tauri::command]
pub fn dap_start_session(
    id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    state: State<'_, DapState>,
) -> Result<BridgeInfo, String> {
    let existing = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(mut session) = existing {
        session.bridge.shutdown();
    }

    let cwd_path = PathBuf::from(&cwd);
    let session_id = id.clone();
    let bridge = state.runtime.block_on(async move {
        let mut process = LspProcess::spawn(&program, &args, &cwd_path, &[])
            .map_err(|e| format!("failed to spawn debug adapter: {e}"))?;
        process.forward_stderr(format!("dap:{session_id}"));
        start_bridge(process)
            .await
            .map_err(|e| format!("failed to start DAP bridge: {e}"))
    })?;

    let info = bridge.info();
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(id, DapSession { bridge });
    Ok(info)
}

/// Stops the debug session with the given id (bridge kills the adapter).
#[tauri::command]
pub fn dap_stop_session(id: String, state: State<'_, DapState>) -> Result<(), String> {
    let session = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(mut session) = session {
        session.bridge.shutdown();
    }
    Ok(())
}

/// Builds `csproj` and returns the output assembly path (`TargetPath`) — what
/// netcoredbg launches via `dotnet <dll>`. One MSBuild call does both (with
/// `--getProperty`, the property prints after the build). `async` so the build
/// never blocks the UI thread; a failing build surfaces its stderr tail.
#[tauri::command]
pub async fn dap_resolve_dotnet_target(csproj_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("dotnet");
        cmd.args([
            "build",
            &csproj_path,
            "-c",
            "Debug",
            "--getProperty:TargetPath",
            "-v:quiet",
            "-nologo",
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().map_err(|e| format!("dotnet build: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        // The property is the last non-empty stdout line; build errors also land
        // on stdout with MSBuild, so surface a tail when the path looks wrong.
        let target = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        if !out.status.success() || !target.to_lowercase().ends_with(".dll") {
            let tail: String = stdout.chars().rev().take(600).collect::<String>().chars().rev().collect();
            return Err(format!("build falhou ou TargetPath inválido: {tail}"));
        }
        Ok(target)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A candidate process for "attach": a running `dotnet`/.NET app.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotnetProcess {
    pub pid: u32,
    pub name: String,
}

/// Lists running .NET processes for the attach picker. Best-effort: an error
/// from the OS tool yields an empty list, never a hard failure.
#[tauri::command]
pub fn dap_list_dotnet_processes() -> Vec<DotnetProcess> {
    #[cfg(windows)]
    {
        // `tasklist /FO CSV /NH`: "name","pid","session","sess#","mem"
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/FO", "CSV", "/NH"]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let Ok(out) = cmd.output() else { return Vec::new() };
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .filter_map(|line| {
                let mut cols = line.split("\",\"");
                let name = cols.next()?.trim_start_matches('"').to_string();
                let pid: u32 = cols.next()?.trim().parse().ok()?;
                Some(DotnetProcess { pid, name })
            })
            .filter(|p| p.name.eq_ignore_ascii_case("dotnet.exe"))
            .collect()
    }
    #[cfg(not(windows))]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-eo", "pid=,comm="])
            .output()
        else {
            return Vec::new();
        };
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let pid: u32 = parts.next()?.parse().ok()?;
                let name = parts.next()?.to_string();
                Some(DotnetProcess { pid, name })
            })
            .filter(|p| p.name == "dotnet")
            .collect()
    }
}
