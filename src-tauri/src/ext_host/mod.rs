//! Mini extension host (PoC): processo Node `tools/ext-host/main.js` que roda
//! extensões VS Code instaladas localmente (Claude Code, Codex) e serve as UIs
//! de webview delas num servidor HTTP em 127.0.0.1.
//!
//! O backend só faz o transporte: cada linha JSON do stdout do sidecar vira o
//! evento Tauri `ext-host://message` (payload = a linha crua); o frontend
//! escreve linhas no stdin via `ext_host_send`. O protocolo em si (initialize,
//! loadExtension, resolveView, webviewMessage…) é documentado em
//! `tools/ext-host/main.js` e em `docs/context/extensoes-vscode.md`.
//!
//! Exceção ao "só transporte": linhas `{"event":"secrets",…}` são atendidas
//! aqui (cofre do SO, `secrets.rs`) e nunca chegam ao frontend.

pub mod deep_link;
pub mod node;
pub mod secrets;

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
    node: String,
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
            if let Some(Running { mut child, stdin, .. }) = guard.take() {
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
                kill_process_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// SIGKILL no grupo do host (ele é o líder: `process_group(0)` no spawn).
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    if let Ok(pgid) = libc::pid_t::try_from(pid) {
        unsafe {
            libc::killpg(pgid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtHostInfo {
    /// `false` quando o processo já estava rodando (o frontend não reinicializa).
    pub started: bool,
    pub pid: u32,
    pub data_dir: String,
    /// Pasta de extensões gerenciada pelo app (`<app_data>/extensions`).
    pub extensions_dir: String,
    pub script: String,
    /// Executável do Node usado (diagnóstico na saída "Extensões").
    pub node: String,
    /// Backend de `context.secrets`: "keyring" (cofre do SO via Rust).
    pub secrets: &'static str,
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
            "Host de extensões não encontrado (tools/ext-host/main.js). A instalação do Fluent Coder parece incompleta: reinstale o app ou defina FLUENT_EXT_HOST_SCRIPT.".to_string()
        })
}

/// Escreve uma linha no stdin do sidecar em execução (se houver).
fn write_line(running: &Arc<Mutex<Option<Running>>>, line: &str) -> Result<(), String> {
    let mut guard = running
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

/// Linhas do stdout que o Rust atende sozinho (não vão ao frontend).
fn intercept_line(line: &str, running: &Arc<Mutex<Option<Running>>>) -> bool {
    if !line.starts_with(secrets::LINE_PREFIX) {
        return false;
    }
    match serde_json::from_str::<secrets::SecretRequest>(line) {
        Ok(req) => {
            let running = running.clone();
            // O cofre pode demorar (desbloqueio do keyring): fora do leitor.
            std::thread::spawn(move || {
                let result = secrets::handle(&req);
                let _ = write_line(&running, &secrets::respond_line(req.request_id, result));
            });
        }
        Err(e) => eprintln!("[ext-host] pedido de segredo inválido: {e}"),
    }
    true
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
    let extensions_dir = crate::extensions::managed_dir(&app)?.to_string_lossy().into_owned();

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
                extensions_dir: extensions_dir.clone(),
                script: script.to_string_lossy().into_owned(),
                node: r.node.clone(),
                secrets: "keyring",
            });
        }
        *guard = None;
    }

    let node = node::find_node()?;
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
    // Unix: o host lidera um grupo de processos próprio, para que encerrar o
    // grupo leve junto os filhos das extensões (claude, codex app-server) —
    // sem isso eles ficavam órfãos quando o host era morto.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
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
                // Só objetos JSON (o protocolo); o resto é ruído e é descartado.
                Ok(line) if line.starts_with('{') => {
                    if !intercept_line(&line, &running) {
                        let _ = app_out.emit(MESSAGE_EVENT, line);
                    }
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

    let node_str = node.to_string_lossy().into_owned();
    *guard = Some(Running { child, stdin, node: node_str.clone() });
    Ok(ExtHostInfo {
        started: true,
        pid,
        data_dir: data_dir.to_string_lossy().into_owned(),
        extensions_dir,
        script: script.to_string_lossy().into_owned(),
        node: node_str,
        secrets: "keyring",
    })
}

/// Envia uma linha JSON (sem `\n`) ao stdin do host. O frontend só manda
/// objetos JSON de protocolo (`{"id"?, "method", "params"}`).
#[tauri::command]
pub fn ext_host_send(line: String, state: State<'_, ExtHostState>) -> Result<(), String> {
    validate_outgoing(&line)?;
    write_line(&state.running, &line)
}

/// Limite por mensagem app → host (webviews mandam anexos/imagens em base64).
const MAX_LINE: usize = 64 * 1024 * 1024;

fn validate_outgoing(line: &str) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("mensagem do host de extensões não pode conter quebra de linha".into());
    }
    if line.len() > MAX_LINE {
        return Err("mensagem grande demais para o host de extensões".into());
    }
    if !line.starts_with('{') || !line.contains("\"method\"") {
        return Err("mensagem inválida para o host de extensões".into());
    }
    Ok(())
}

#[tauri::command]
pub fn ext_host_stop(state: State<'_, ExtHostState>) {
    state.shutdown_all();
}

/// Só http(s)/mailto saem para o navegador/cliente do sistema.
#[cfg(test)]
fn is_safe_external_url(url: &str) -> bool {
    crate::platform::is_safe_external_url(url)
}

/// `vscode.env.openExternal` / links clicados nos webviews das extensões.
/// A abertura em si (allowlist + rundll32/open/xdg-open) é do adaptador de
/// plataforma; `async` para nunca esperar processo na main thread.
#[tauri::command]
pub async fn ext_host_open_external(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::platform::open_external_url(&url))
        .await
        .map_err(|e| format!("open_external join error: {e}"))?
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
    fn outgoing_lines_are_validated() {
        assert!(validate_outgoing(r#"{"id":1,"method":"initialize","params":{}}"#).is_ok());
        assert!(validate_outgoing("{\"method\":\"x\"}\n{\"method\":\"y\"}").is_err());
        assert!(validate_outgoing("not json").is_err());
        assert!(validate_outgoing(r#"{"event":"secrets"}"#).is_err());
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
