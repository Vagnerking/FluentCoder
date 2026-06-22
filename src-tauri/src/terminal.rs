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

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.cwd(&cwd);
    if let Some(line) = command.as_ref().filter(|l| !l.trim().is_empty()) {
        // -NoExit keeps the prompt after the command finishes; -Command runs it.
        cmd.arg("-NoExit");
        cmd.arg("-Command");
        cmd.arg(line);
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
