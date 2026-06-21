//! New-window support.
//!
//! Unlike a second Tauri `WebviewWindow` (which would share this process's Rust
//! backend — LSP servers, terminals and the search index all in one state), a new
//! window here is a **separate OS process**: a fresh instance of the executable.
//! That isolates each project's servers/terminals, like VSCode's multi-process
//! windows, at the cost of a second process (which the user explicitly wants).

/// Launches a fresh, isolated instance of the editor (new process + window).
/// Passes `--new` so that instance starts empty instead of restoring the session.
#[tauri::command]
pub fn open_new_window() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("não foi possível localizar o executável: {e}"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--new");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS: the new instance is independent of this one, so
        // closing this window never takes the new project's window down with it.
        cmd.creation_flags(0x0000_0008);
    }
    cmd.spawn()
        .map_err(|e| format!("não foi possível abrir uma nova janela: {e}"))?;
    Ok(())
}

/// True when this instance was launched as a fresh window (`--new`), so the UI
/// starts empty instead of reopening the last folder.
#[tauri::command]
pub fn is_fresh_window() -> bool {
    std::env::args().any(|arg| arg == "--new")
}
