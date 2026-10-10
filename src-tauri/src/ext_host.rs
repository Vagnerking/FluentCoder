//! Mini extension host (PoC): processo Node `tools/ext-host/main.js` que roda
//! extensões VS Code instaladas localmente (Claude Code, Codex) e serve as UIs
//! de webview delas num servidor HTTP em 127.0.0.1.
//!
//! O backend só faz o transporte: cada linha JSON do stdout do sidecar vira o
//! evento Tauri `ext-host://message` (payload = a linha crua); o frontend
//! escreve linhas no stdin via `ext_host_send`. O protocolo em si (initialize,
//! loadExtension, resolveView, webviewMessage…) é documentado em
//! `tools/ext-host/main.js` e em `docs/context/extensoes-vscode.md`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const MESSAGE_EVENT: &str = "ext-host://message";
pub const EXIT_EVENT: &str = "ext-host://exit";

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct ExtHostState {
    running: Arc<Mutex<Option<Running>>>,
}

impl ExtHostState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn shutdown_all(&self) {
        if let Ok(mut guard) = self.running.lock() {
            if let Some(Running { mut child, stdin }) = guard.take() {
                // Fechar o stdin faz o host chamar deactivate() das extensões,
                // que encerram os filhos delas (claude / codex app-server).
                drop(stdin);
                let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
                while std::time::Instant::now() < deadline {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtHostInfo {
    /// `false` quando o processo já estava rodando (o frontend não reinicializa).
    pub started: bool,
    pub pid: u32,
    pub data_dir: String,
    pub script: String,
}

/// Localiza `tools/ext-host/main.js`: variável `FLUENT_EXT_HOST_SCRIPT`,
/// recursos empacotados ou (dev) a árvore do repositório.
fn find_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("FLUENT_EXT_HOST_SCRIPT") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("tools").join("ext-host").join("main.js"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("ext-host")
            .join("main.js"),
    );
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.canonicalize().unwrap_or(p))
        .ok_or_else(|| {
            "Host de extensões não encontrado (tools/ext-host/main.js). Este recurso só está disponível em modo de desenvolvimento.".to_string()
        })
}

fn find_node() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("FLUENT_NODE") {
        return Ok(PathBuf::from(p));
    }
    which::which("node").map_err(|_| {
        "Node.js não encontrado no PATH. Instale o Node.js 20+ para usar extensões do VS Code.".to_string()
    })
}

#[tauri::command]
pub fn ext_host_start(app: AppHandle, state: State<'_, ExtHostState>) -> Result<ExtHostInfo, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Falha ao obter a pasta de dados do app: {e}"))?
        .join("ext-host");
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Falha ao criar {}: {e}", data_dir.display()))?;
    let script = find_script(&app)?;

    let mut guard = state
        .running
        .lock()
        .map_err(|e| format!("Falha ao acessar o host de extensões: {e}"))?;
    if let Some(r) = guard.as_mut() {
        if matches!(r.child.try_wait(), Ok(None)) {
            return Ok(ExtHostInfo {
                started: false,
                pid: r.child.id(),
                data_dir: data_dir.to_string_lossy().into_owned(),
                script: script.to_string_lossy().into_owned(),
            });
        }
        *guard = None;
    }

    let node = find_node()?;
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .current_dir(script.parent().unwrap_or(&data_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar o host de extensões ({}): {e}", node.display()))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or("stdin do host indisponível")?;
    let stdout = child.stdout.take().ok_or("stdout do host indisponível")?;
    let stderr = child.stderr.take().ok_or("stderr do host indisponível")?;

    // stdout → evento por linha (JSON cru; o frontend faz o parse).
    let app_out = app.clone();
    let running = state.running.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    let _ = app_out.emit(MESSAGE_EVENT, line);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // Só limpa o estado se ainda for este processo (um restart pode ter trocado).
        if let Ok(mut g) = running.lock() {
            if g.as_ref().map(|r| r.child.id()) == Some(pid) {
                *g = None;
            }
        }
        let _ = app_out.emit(EXIT_EVENT, pid);
    });
    // stderr → log do backend (as extensões escrevem bastante aqui).
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[ext-host:{pid}] {line}");
        }
    });

    *guard = Some(Running { child, stdin });
    Ok(ExtHostInfo {
        started: true,
        pid,
        data_dir: data_dir.to_string_lossy().into_owned(),
        script: script.to_string_lossy().into_owned(),
    })
}

/// Envia uma linha JSON (sem `\n`) ao stdin do host.
#[tauri::command]
pub fn ext_host_send(line: String, state: State<'_, ExtHostState>) -> Result<(), String> {
    if line.contains('\n') {
        return Err("mensagem do host de extensões não pode conter quebra de linha".into());
    }
    let mut guard = state
        .running
        .lock()
        .map_err(|e| format!("Falha ao acessar o host de extensões: {e}"))?;
    let r = guard
        .as_mut()
        .ok_or("Host de extensões não está em execução")?;
    r.stdin
        .write_all(line.as_bytes())
        .and_then(|_| r.stdin.write_all(b"\n"))
        .and_then(|_| r.stdin.flush())
        .map_err(|e| format!("Falha ao escrever no host de extensões: {e}"))
}

#[tauri::command]
pub fn ext_host_stop(state: State<'_, ExtHostState>) {
    state.shutdown_all();
}

/// Só http(s)/mailto saem para o navegador/cliente do sistema.
fn is_safe_external_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && !url.chars().any(|c| c.is_control())
}

/// `vscode.env.openExternal` / links clicados nos webviews das extensões.
#[tauri::command]
pub fn ext_host_open_external(url: String) -> Result<(), String> {
    if !is_safe_external_url(&url) {
        return Err(format!("URL externa recusada: {url}"));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| {
            // Colhe o processo para não deixar zumbi.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
        .map_err(|e| format!("Falha ao abrir {url}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_urls_open_externally() {
        assert!(is_safe_external_url("https://claude.ai/login"));
        assert!(is_safe_external_url("mailto:a@b.c"));
        assert!(!is_safe_external_url("file:///etc/passwd"));
        assert!(!is_safe_external_url("javascript:alert(1)"));
        assert!(!is_safe_external_url("https://x\n--flag"));
    }

    #[test]
    fn dev_script_exists_in_repo() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("ext-host")
            .join("main.js");
        assert!(p.is_file(), "tools/ext-host/main.js deve existir: {}", p.display());
    }
}
