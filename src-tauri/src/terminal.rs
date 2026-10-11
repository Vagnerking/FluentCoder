use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    // The spawned shell. Kept so we can read its exit code — `portable-pty` does
    // NOT kill the child on drop, so the killer below tears it down on close.
    // `None` when another owner waits on the child (ACP terminals, see
    // `agents::acp_client`), which only lend the PTY to the panel.
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    // Kills the process on teardown — without this the PowerShell process (and
    // the blocking reader thread) outlive the window and hang the app on close.
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
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
                let _ = session.killer.kill();
            }
        }
    }

    /// Registra um PTY criado fora do `term_create` (terminais do cliente ACP):
    /// o painel escreve/redimensiona/fecha pelo mesmo id.
    pub fn insert_external(
        &self,
        id: String,
        writer: Box<dyn Write + Send>,
        master: Box<dyn portable_pty::MasterPty + Send>,
        killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    ) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(id, PtySession { writer, master, child: None, killer });
        }
    }
}

/// Builds the PTY shell. Windows runs PowerShell (the original behavior); Linux
/// and macOS run the user's `$SHELL` as a login shell (so PATH entries from the
/// profile — cargo, fnm, dotnet — are present), falling back to `/bin/bash`.
/// With `command`, the shell runs it and then stays open (like `-NoExit`).
fn shell_command(command: Option<&str>) -> CommandBuilder {
    let line = command.filter(|l| !l.trim().is_empty());
    shell_command_inner(line)
}

/// Opções de um terminal criado por uma extensão VS Code
/// (`window.createTerminal`, ver `src/extensions/terminalBridge.ts`).
#[derive(serde::Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TermSpawnOptions {
    /// Executável no lugar do shell padrão (`shellPath`).
    pub shell_path: Option<String>,
    pub shell_args: Option<Vec<String>>,
    /// Variáveis extras (já com o `environmentVariableCollection` aplicado).
    pub env: Option<std::collections::HashMap<String, String>>,
    /// `strictEnv`: o ambiente é exatamente `env` (sem herdar o do app).
    pub strict_env: Option<bool>,
    /// Ligar a shell integration (OSC 633) quando o shell é bash/zsh/fish sem
    /// argumentos próprios — ver `shell_integration.rs`.
    pub shell_integration: Option<bool>,
}

/// Monta o comando de um terminal de extensão: `shellPath`/`shellArgs` quando
/// informados (executável que precisa existir), senão o shell padrão.
fn extension_command(opts: &TermSpawnOptions, si_dir: Option<&std::path::Path>) -> Result<CommandBuilder, String> {
    if let Some(cmd) = si_dir.and_then(|dir| integrated_shell_command(opts, dir)) {
        return Ok(cmd);
    }
    let mut cmd = match opts.shell_path.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(shell) => {
            let resolved = which::which(shell)
                .map_err(|_| format!("Executável do terminal não encontrado: {shell}"))?;
            let mut c = CommandBuilder::new(resolved);
            for a in opts.shell_args.iter().flatten() {
                c.arg(a);
            }
            c
        }
        None => shell_command_inner(None),
    };
    if opts.strict_env.unwrap_or(false) {
        cmd.env_clear();
    }
    for (k, v) in opts.env.iter().flatten() {
        // Nomes inválidos (vazios, com `=` ou NUL) seriam recusados pelo SO.
        if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
            continue;
        }
        cmd.env(k, v);
    }
    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
    }
    Ok(cmd)
}

/// Shell da extensão com a shell integration (OSC 633) ligada, quando é
/// bash/zsh/fish sem `shellArgs` próprios. `None` = segue o caminho normal.
fn integrated_shell_command(opts: &TermSpawnOptions, dir: &std::path::Path) -> Option<CommandBuilder> {
    if !opts.shell_integration.unwrap_or(false) || opts.shell_args.as_ref().is_some_and(|a| !a.is_empty()) {
        return None;
    }
    let program = match opts.shell_path.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(shell) => which::which(shell).ok()?,
        None => std::path::PathBuf::from(crate::platform::default_shell().program),
    };
    let kind = crate::shell_integration::shell_kind(&program.to_string_lossy())?;
    if let Err(e) = crate::shell_integration::install_scripts(dir) {
        eprintln!("[terminal] shell integration indisponível: {e}");
        return None;
    }
    let user_zdotdir = opts
        .env
        .as_ref()
        .and_then(|e| e.get("ZDOTDIR").cloned())
        .or_else(|| std::env::var("ZDOTDIR").ok());
    let inj = crate::shell_integration::injection(kind, dir, user_zdotdir.as_deref());
    let mut cmd = CommandBuilder::new(program);
    cmd.args(&inj.args);
    if opts.strict_env.unwrap_or(false) {
        cmd.env_clear();
    }
    for (k, v) in opts.env.iter().flatten() {
        if k.is_empty() || k.contains('=') || k.contains('\0') || v.contains('\0') {
            continue;
        }
        cmd.env(k, v);
    }
    for (k, v) in &inj.env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    Some(cmd)
}

fn shell_command_inner(line: Option<&str>) -> CommandBuilder {
    build_shell_command(&crate::platform::default_shell(), line)
}

/// Monta o comando do PTY a partir do shell resolvido pelo adaptador de
/// plataforma (`pwsh`/`powershell` no Windows; `$SHELL`, zsh no macOS, bash no
/// Linux). Puro sobre `ShellSpec`, para ser testável.
fn build_shell_command(shell: &crate::platform::ShellSpec, line: Option<&str>) -> CommandBuilder {
    use crate::platform::ShellKind;
    let mut cmd = CommandBuilder::new(&shell.program);
    match shell.kind {
        ShellKind::Powershell => {
            if let Some(line) = line {
                // -NoExit keeps the prompt after the command finishes; -Command runs it.
                cmd.arg("-NoExit");
                cmd.arg("-Command");
                cmd.arg(line);
            }
        }
        ShellKind::Posix => {
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            match line {
                Some(line) => {
                    // Run the command, then replace the shell with an interactive one
                    // so the output stays visible and the session keeps going.
                    cmd.arg("-lc");
                    cmd.arg(format!("{line}\nexec \"$0\" -l"));
                }
                None => {
                    for a in &shell.args {
                        cmd.arg(a);
                    }
                }
            }
        }
    }
    cmd
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
    // Terminal pedido por uma extensão VS Code (shell/args/env próprios).
    spawn: Option<TermSpawnOptions>,
    state: State<'_, TerminalState>,
    ide_bridge: State<'_, crate::agents::ide_bridge::IdeBridgeState>,
    app: AppHandle,
) -> Result<Option<u32>, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let strict = spawn.as_ref().and_then(|s| s.strict_env).unwrap_or(false);
    let si_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| crate::shell_integration::scripts_dir(&d));
    let mut cmd = match &spawn {
        Some(opts) => extension_command(opts, si_dir.as_deref())?,
        None => shell_command(command.as_deref()),
    };
    cmd.cwd(&cwd);
    // Igual ao terminal do VS Code: o `claude` iniciado aqui conecta sozinho na
    // ponte IDE (src/agents/ide_bridge.rs). Só com a ponte no ar. Num terminal
    // de extensão, o env dela (ex.: CLAUDE_CODE_SSE_PORT da própria extensão)
    // tem precedência.
    if let Some(port) = ide_bridge.port() {
        let ext_env = spawn.as_ref().and_then(|s| s.env.as_ref());
        if !strict && !ext_env.is_some_and(|e| e.contains_key("CLAUDE_CODE_SSE_PORT")) {
            cmd.env("CLAUDE_CODE_SSE_PORT", port.to_string());
            cmd.env("ENABLE_IDE_INTEGRATION", "true");
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id();
    let killer = child.clone_killer();

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
        // Fim da saída = o processo do terminal saiu (ou foi encerrado). Colhe
        // o código de saída se a sessão ainda existe (term_close já a removeu).
        // `try_wait` em poucas tentativas: nunca segura o lock bloqueado.
        let mut code: Option<u32> = None;
        if let Some(st) = app_handle.try_state::<TerminalState>() {
            for _ in 0..20 {
                let status = match st.sessions.lock() {
                    Ok(mut sessions) => match sessions.get_mut(&session_id) {
                        Some(s) => s.child.as_mut().and_then(|c| c.try_wait().ok().flatten()),
                        None => break,
                    },
                    Err(_) => break,
                };
                if let Some(status) = status {
                    code = Some(status.exit_code());
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        let _ = app_handle.emit(
            "term-exit",
            serde_json::json!({ "id": session_id, "code": code }),
        );
    });

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child: Some(child),
            killer,
        },
    );

    Ok(pid)
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
        let _ = session.killer.kill();
    }
    Ok(())
}
