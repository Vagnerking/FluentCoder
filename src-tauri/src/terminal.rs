use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    // The spawned shell. Kept so we can kill it on teardown — `portable-pty` does
    // NOT kill the child on drop, so without this the PowerShell process (and the
    // blocking reader thread) outlive the window and hang the app on close.
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct TerminalState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl TerminalState {
    pub fn new() -> Self {
        TerminalState {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Kills every live PTY child and clears the session table. Called on window
    /// close so no shell process is left orphaned holding the app open.
    pub fn shutdown_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_id, mut session) in sessions.drain() {
                let _ = session.child.kill();
            }
        }
    }
}

/// Builds the PTY shell. Windows runs PowerShell (the original behavior); Linux
/// and macOS run the user's `$SHELL` as a login shell (so PATH entries from the
/// profile — cargo, fnm, dotnet — are present), falling back to `/bin/bash`.
/// With `command`, the shell runs it and then stays open (like `-NoExit`).
fn shell_command(command: Option<&str>) -> CommandBuilder {
    let line = command.filter(|l| !l.trim().is_empty());
    #[cfg(windows)]
    {
        let mut cmd = CommandBuilder::new("powershell.exe");
        if let Some(line) = line {
            // -NoExit keeps the prompt after the command finishes; -Command runs it.
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(line);
        }
        cmd
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        match line {
            Some(line) => {
                // Run the command, then replace the shell with an interactive one
                // so the output stays visible and the session keeps going.
                cmd.arg("-lc");
                cmd.arg(format!("{line}\nexec \"$0\" -l"));
            }
            None => cmd.arg("-l"),
        }
        cmd
    }
}

#[tauri::command]
pub fn term_create(
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    // When set, the PTY launches a shell that runs this command line and keeps
    // the session open afterwards (so the program's output stays visible). When
    // None, it's a plain interactive PowerShell — the original behavior.
    command: Option<String>,
    state: State<'_, TerminalState>,
    ide_bridge: State<'_, crate::agents::ide_bridge::IdeBridgeState>,
    app: AppHandle,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = shell_command(command.as_deref());
    cmd.cwd(&cwd);
    // Igual ao terminal do VS Code: o `claude` iniciado aqui conecta sozinho na
    // ponte IDE (src/agents/ide_bridge.rs). Só com a ponte no ar.
    if let Some(port) = ide_bridge.port() {
        cmd.env("CLAUDE_CODE_SSE_PORT", port.to_string());
        cmd.env("ENABLE_IDE_INTEGRATION", "true");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = id.clone();
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(
                        "term-data",
                        serde_json::json!({ "id": session_id, "data": data }),
                    );
                }
            }
        }
    });

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn term_write(id: String, data: String, state: State<'_, TerminalState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn term_close(id: String, state: State<'_, TerminalState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}
