//! SSH/SFTP remote workspaces — issue #8.
//!
//! Lets the editor work in a remote folder over SSH/SFTP, including editing,
//! terminal, search, Git and selected language servers. Server keys follow TOFU:
//! unknown hosts are recorded in `~/.ssh/known_hosts`, known keys must match and
//! changed keys are rejected. Crypto uses `ring` (no NASM/OpenSSL dependency).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::lsp::bridge::BridgeInfo;
use crate::lsp::codec;
use futures_util::{SinkExt, StreamExt};
use russh::client;
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// Verifies the server host key against `~/.ssh/known_hosts`:
/// - known and matching → accept;
/// - unknown host → trust on first use (record it), then accept;
/// - **changed** key → reject (possible MITM). `key_changed` is shared with the
///   connect flow so it can surface a clear security error instead of a generic
///   auth failure.
struct HostKeyHandler {
    host: String,
    port: u16,
    key_changed: Arc<std::sync::atomic::AtomicBool>,
}

impl client::Handler for HostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                // known_hosts exists but has no entry for this host yet.
                Ok(russh::keys::known_hosts::learn_known_hosts(
                    &self.host,
                    self.port,
                    server_public_key,
                )
                .is_ok())
            }
            Err(russh::keys::Error::IO(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                // First connection and no known_hosts file yet: trust only if
                // the key can be recorded successfully. Otherwise fail closed.
                Ok(russh::keys::known_hosts::learn_known_hosts(
                    &self.host,
                    self.port,
                    server_public_key,
                )
                .is_ok())
            }
            Err(russh::keys::Error::KeyChanged { .. }) => {
                self.key_changed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(false)
            }
            // Corrupt/unreadable known_hosts or an unavailable home directory
            // must never silently disable host verification.
            Err(_) => Ok(false),
        }
    }
}

/// One live SSH connection: the client handle (multiplexes SFTP, exec and PTY
/// channels over a single TCP session) plus an SFTP session for file operations.
struct Connection {
    /// Opens new channels (exec/PTY) and keeps the SSH session alive.
    handle: client::Handle<HostKeyHandler>,
    sftp: SftpSession,
}

/// A live remote terminal: a PTY-backed shell channel driven by a background
/// task. The task owns the SSH channel; these senders feed it input/resize and
/// the abort handle tears it down on close.
struct RemoteTerminal {
    /// The connection this terminal belongs to (so disconnect can reap it).
    conn_id: String,
    stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    resize_tx: mpsc::UnboundedSender<(u32, u32)>,
    task: AbortHandle,
}

/// A remote language server: its PTY-less exec channel runs the server on the
/// host while a local WebSocket bridge proxies LSP traffic to monaco. The abort
/// handle tears down the bridge task (dropping the channel kills the server).
struct RemoteLspBridge {
    /// The connection this bridge belongs to (so disconnect can reap it).
    conn_id: String,
    task: AbortHandle,
}

/// App-managed SSH connections + remote terminals + remote LSP bridges, keyed by
/// ids handed to the frontend.
pub struct SshState {
    conns: Mutex<HashMap<String, Arc<Connection>>>,
    terminals: Mutex<HashMap<String, RemoteTerminal>>,
    lsp_bridges: Mutex<HashMap<String, RemoteLspBridge>>,
    next_id: AtomicU64,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            lsp_bridges: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Drops every connection/terminal/LSP bridge on app teardown. Sync so it can
    /// run from the `RunEvent` teardown alongside the other states.
    pub fn shutdown_all(&self) {
        if let Ok(mut terminals) = self.terminals.try_lock() {
            for (_id, term) in terminals.drain() {
                term.task.abort();
            }
        }
        if let Ok(mut bridges) = self.lsp_bridges.try_lock() {
            for (_id, bridge) in bridges.drain() {
                bridge.task.abort();
            }
        }
        if let Ok(mut conns) = self.conns.try_lock() {
            conns.clear();
        }
    }
}

/// How to authenticate: a password, a private-key file (optionally encrypted),
/// or the running SSH agent.
enum AuthMethod {
    Password(String),
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

/// Tries every identity in the SSH agent against the host. Generic over the
/// agent transport so it works for the Windows named pipe / Pageant / Unix socket
/// (their concrete stream types differ).
async fn agent_auth_loop<R>(
    handle: &mut client::Handle<HostKeyHandler>,
    user: &str,
    mut agent: russh::keys::agent::client::AgentClient<R>,
) -> Result<russh::client::AuthResult, String>
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("Falha ao consultar o agente SSH: {e}"))?;
    if identities.is_empty() {
        return Err("O agente SSH não tem nenhuma chave carregada.".to_string());
    }
    for identity in identities {
        if let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = identity {
            if let Ok(result) = handle
                .authenticate_publickey_with(user, key, None, &mut agent)
                .await
            {
                if result.success() {
                    return Ok(result);
                }
            }
        }
    }
    Err("Nenhuma chave do agente SSH foi aceita pelo host.".to_string())
}

/// Authenticates via the platform's SSH agent (OpenSSH named pipe → Pageant on
/// Windows; `SSH_AUTH_SOCK` elsewhere).
async fn authenticate_with_agent(
    handle: &mut client::Handle<HostKeyHandler>,
    user: &str,
) -> Result<russh::client::AuthResult, String> {
    use russh::keys::agent::client::AgentClient;
    #[cfg(windows)]
    {
        if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            return agent_auth_loop(handle, user, agent).await;
        }
        let agent = AgentClient::connect_pageant()
            .await
            .map_err(|e| format!("Nenhum agente SSH disponível (OpenSSH/Pageant): {e}"))?;
        agent_auth_loop(handle, user, agent).await
    }
    #[cfg(not(windows))]
    {
        let agent = AgentClient::connect_env()
            .await
            .map_err(|e| format!("Nenhum agente SSH (SSH_AUTH_SOCK): {e}"))?;
        agent_auth_loop(handle, user, agent).await
    }
}

/// Connect + authenticate + open an SFTP subsystem against `host:port`.
async fn open_connection(
    host: &str,
    port: u16,
    user: &str,
    auth: AuthMethod,
) -> Result<Connection, String> {
    let key_changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = HostKeyHandler {
        host: host.to_string(),
        port,
        key_changed: Arc::clone(&key_changed),
    };
    let config = Arc::new(client::Config::default());
    let mut handle = client::connect(config, (host, port), handler)
        .await
        .map_err(|e| {
            if key_changed.load(std::sync::atomic::Ordering::SeqCst) {
                format!(
                    "A chave do host {host} MUDOU desde a última conexão — possível ataque \
                     (man-in-the-middle). Se a mudança for legítima, remova a entrada antiga \
                     de ~/.ssh/known_hosts e tente de novo."
                )
            } else {
                format!("Falha ao conectar em {host}:{port}: {e}")
            }
        })?;

    let authenticated = match auth {
        AuthMethod::Password(password) => handle
            .authenticate_password(user, password)
            .await
            .map_err(|e| format!("Erro na autenticação por senha: {e}"))?,
        AuthMethod::KeyFile { path, passphrase } => {
            let key = russh::keys::load_secret_key(&path, passphrase.as_deref())
                .map_err(|e| format!("Não foi possível carregar a chave '{path}': {e}"))?;
            handle
                .authenticate_publickey(
                    user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|e| format!("Erro na autenticação por chave: {e}"))?
        }
        AuthMethod::Agent => authenticate_with_agent(&mut handle, user).await?,
    };
    if !authenticated.success() {
        return Err("Autenticação SSH recusada (usuário/senha/chave/agente).".to_string());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Falha ao abrir canal SSH: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Falha ao iniciar SFTP: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("Falha ao iniciar a sessão SFTP: {e}"))?;

    Ok(Connection { handle, sftp })
}

/// Joins a POSIX dir + name (remote paths are always `/`-separated).
fn join_posix(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn remote_project_dir(root: &str) -> String {
    let base = root.trim_end_matches('/');
    if base.is_empty() {
        "/.project".to_string()
    } else {
        join_posix(base, ".project")
    }
}

fn remote_project_file(root: &str, name: &str) -> String {
    join_posix(&remote_project_dir(root), name)
}

fn remote_agent_cache_dir(home: &str, root: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(root.trim_end_matches('/').as_bytes());
    let workspace_id = format!("{digest:x}");
    let app_dir = join_posix(home.trim_end_matches('/'), ".fluent-coder");
    join_posix(&join_posix(&app_dir, "workspaces"), &workspace_id[..16])
}

async fn remote_agent_cache_file(sftp: &SftpSession, root: &str) -> Result<String, String> {
    let home = sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("Falha ao localizar a pasta pessoal remota: {e}"))?;
    Ok(join_posix(
        &remote_agent_cache_dir(&home, root),
        "agents.json",
    ))
}

fn directory_chain(path: &str) -> Vec<String> {
    let absolute = path.starts_with('/');
    let mut current = String::new();
    let mut chain = Vec::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        if absolute && current.is_empty() {
            current.push('/');
            current.push_str(part);
        } else if current.is_empty() {
            current.push_str(part);
        } else {
            current.push('/');
            current.push_str(part);
        }
        chain.push(current.clone());
    }
    chain
}

/// SFTP exposes only single-level mkdir. Verify every path component so a
/// failed `.project` creation is reported at its real location instead of
/// surfacing later as an opaque "No such file" from the write call.
async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    for dir in directory_chain(path) {
        match sftp.try_exists(dir.clone()).await {
            Ok(true) => {
                let metadata = sftp
                    .metadata(dir.clone())
                    .await
                    .map_err(|e| format!("Falha ao verificar a pasta remota '{dir}': {e}"))?;
                if !metadata.is_dir() {
                    return Err(format!(
                        "'{dir}' existe no host remoto, mas não é uma pasta."
                    ));
                }
            }
            Ok(false) => {
                if let Err(error) = sftp.create_dir(dir.as_str()).await {
                    // Another window may have created it between exists + mkdir.
                    if !sftp.try_exists(dir.clone()).await.unwrap_or(false) {
                        return Err(format!("Falha ao criar a pasta remota '{dir}': {error}"));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "Falha ao verificar a pasta remota '{dir}': {error}"
                ));
            }
        }
    }
    Ok(())
}

async fn write_remote_file(sftp: &SftpSession, path: &str, contents: &[u8]) -> Result<(), String> {
    ensure_remote_dir(sftp, posix_dirname(path)).await?;
    sftp.write(path, contents)
        .await
        .map_err(|e| format!("Falha ao salvar '{path}': {e}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectArgs {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    /// Authenticate through the running SSH agent instead of a password/key.
    pub use_agent: Option<bool>,
}

/// A remote directory entry, mirroring the local `RawDirEntry` the explorer uses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Connects to a host and returns a connection id the frontend uses for
/// subsequent remote FS calls.
#[tauri::command]
pub async fn ssh_connect(
    args: SshConnectArgs,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let port = args.port.unwrap_or(22);
    let auth = if args.use_agent.unwrap_or(false) {
        AuthMethod::Agent
    } else if let Some(password) = args.password.filter(|p| !p.is_empty()) {
        AuthMethod::Password(password)
    } else if let Some(path) = args.key_path.filter(|p| !p.is_empty()) {
        AuthMethod::KeyFile {
            path,
            passphrase: args.key_passphrase.filter(|p| !p.is_empty()),
        }
    } else {
        return Err(
            "Informe uma senha, o caminho de uma chave privada, ou use o agente SSH.".to_string(),
        );
    };

    let conn = open_connection(&args.host, port, &args.user, auth).await?;
    let id = format!("ssh-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    state.conns.lock().await.insert(id.clone(), Arc::new(conn));
    Ok(id)
}

/// Looks up a live connection by id.
async fn get_conn(state: &State<'_, SshState>, conn_id: &str) -> Result<Arc<Connection>, String> {
    state
        .conns
        .lock()
        .await
        .get(conn_id)
        .cloned()
        .ok_or_else(|| "Conexão SSH não encontrada (reconecte).".to_string())
}

/// Lists the immediate children of a remote directory over SFTP.
#[tauri::command]
pub async fn ssh_list_dir(
    conn_id: String,
    path: String,
    state: State<'_, SshState>,
) -> Result<Vec<RemoteEntry>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let dir = path.trim_end_matches('/').to_string();
    let dir = if dir.is_empty() { "/".to_string() } else { dir };

    let entries = conn
        .sftp
        .read_dir(&dir)
        .await
        .map_err(|e| format!("Falha ao listar '{dir}': {e}"))?;

    let mut out = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        out.push(RemoteEntry {
            path: join_posix(&dir, &name),
            is_dir: entry.file_type().is_dir(),
            name,
        });
    }
    Ok(out)
}

/// Reads a remote text file over SFTP.
#[tauri::command]
pub async fn ssh_read_file(
    conn_id: String,
    path: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let bytes = conn
        .sftp
        .read(&path)
        .await
        .map_err(|e| format!("Falha ao ler '{path}': {e}"))?;
    String::from_utf8(bytes).map_err(|_| "Arquivo não é texto UTF-8.".to_string())
}

/// Reads a remote binary file (image/video/audio) as a base64 `data:` URL, so
/// the WebView can render it via the media preview — the remote counterpart of
/// `read_file_base64`.
#[tauri::command]
pub async fn ssh_read_file_base64(
    conn_id: String,
    path: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    // Refuse oversized files BEFORE downloading them over SFTP.
    if let Ok(meta) = conn.sftp.metadata(path.clone()).await {
        if meta.len() > crate::fs_commands::MAX_PREVIEW_BYTES {
            return Err(format!(
                "Arquivo muito grande para pré-visualizar ({} MB).",
                meta.len() / 1_048_576
            ));
        }
    }
    let bytes = conn
        .sftp
        .read(&path)
        .await
        .map_err(|e| format!("Falha ao abrir '{path}': {e}"))?;
    Ok(crate::fs_commands::data_url(&path, &bytes))
}

/// Closes a connection: reaps its terminals, then drops the SSH session.
#[tauri::command]
pub async fn ssh_disconnect(conn_id: String, state: State<'_, SshState>) -> Result<(), String> {
    {
        let mut terminals = state.terminals.lock().await;
        terminals.retain(|_, term| {
            if term.conn_id == conn_id {
                term.task.abort();
                false
            } else {
                true
            }
        });
    }
    {
        let mut bridges = state.lsp_bridges.lock().await;
        bridges.retain(|_, bridge| {
            if bridge.conn_id == conn_id {
                bridge.task.abort();
                false
            } else {
                true
            }
        });
    }
    state.conns.lock().await.remove(&conn_id);
    Ok(())
}

/// Resolves a remote path to its canonical absolute form (e.g. `.` → the home
/// directory). Used by the remote folder browser to start from an absolute path.
#[tauri::command]
pub async fn ssh_canonicalize(
    conn_id: String,
    path: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    conn.sftp
        .canonicalize(path)
        .await
        .map_err(|e| format!("Falha ao resolver caminho: {e}"))
}

// ---- Path helpers (remote paths are POSIX) ----

/// Last segment of a POSIX path (`/a/b/c` → `c`).
fn posix_basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// Parent of a POSIX path (`/a/b/c` → `/a/b`; root/relative handled).
fn posix_dirname(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/",
        Some(i) => &trimmed[..i],
        None => ".",
    }
}

/// Splits a filename into (stem, extension-with-dot) for collision suffixing.
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// Single-quotes a string for safe interpolation into a remote shell command.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Returns `parent/name`, suffixing ` 1`, ` 2`… on collision (mirrors the local
/// explorer's non-destructive create/copy/move).
async fn unique_path(sftp: &SftpSession, parent: &str, name: &str) -> String {
    let first = join_posix(parent, name);
    if !sftp.try_exists(first.clone()).await.unwrap_or(false) {
        return first;
    }
    let (stem, ext) = split_name(name);
    let mut n = 1;
    loop {
        let candidate = join_posix(parent, &format!("{stem} {n}{ext}"));
        if !sftp.try_exists(candidate.clone()).await.unwrap_or(false) {
            return candidate;
        }
        n += 1;
    }
}

// ---- Phase 2: remote editing over SFTP ----

/// Writes (creating/truncating) a remote text file.
#[tauri::command]
pub async fn ssh_write_file(
    conn_id: String,
    path: String,
    contents: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    conn.sftp
        .write(path.as_str(), contents.as_bytes())
        .await
        .map_err(|e| format!("Falha ao salvar '{path}': {e}"))
}

/// Creates an empty remote file under `parent`, returning the resolved entry.
#[tauri::command]
pub async fn ssh_create_file(
    conn_id: String,
    parent: String,
    name: String,
    state: State<'_, SshState>,
) -> Result<RemoteEntry, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let path = unique_path(&conn.sftp, &parent, &name).await;
    conn.sftp
        .write(path.as_str(), b"")
        .await
        .map_err(|e| format!("Falha ao criar arquivo: {e}"))?;
    Ok(RemoteEntry {
        name: posix_basename(&path).to_string(),
        path,
        is_dir: false,
    })
}

/// Creates a remote directory under `parent`, returning the resolved entry.
#[tauri::command]
pub async fn ssh_create_folder(
    conn_id: String,
    parent: String,
    name: String,
    state: State<'_, SshState>,
) -> Result<RemoteEntry, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let path = unique_path(&conn.sftp, &parent, &name).await;
    conn.sftp
        .create_dir(path.as_str())
        .await
        .map_err(|e| format!("Falha ao criar pasta: {e}"))?;
    Ok(RemoteEntry {
        name: posix_basename(&path).to_string(),
        path,
        is_dir: true,
    })
}

/// Renames a remote file/folder in place.
#[tauri::command]
pub async fn ssh_rename(
    conn_id: String,
    path: String,
    new_name: String,
    state: State<'_, SshState>,
) -> Result<RemoteEntry, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let parent = posix_dirname(&path);
    let new_path = join_posix(parent, &new_name);
    if new_path != path
        && conn
            .sftp
            .try_exists(new_path.clone())
            .await
            .unwrap_or(false)
    {
        return Err(format!("Já existe '{new_name}' nesta pasta."));
    }
    let is_dir = conn
        .sftp
        .metadata(path.clone())
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    conn.sftp
        .rename(path.clone(), new_path.clone())
        .await
        .map_err(|e| format!("Falha ao renomear: {e}"))?;
    Ok(RemoteEntry {
        name: new_name,
        path: new_path,
        is_dir,
    })
}

/// Moves a remote file/folder into `dest_parent` (collision-safe).
#[tauri::command]
pub async fn ssh_move(
    conn_id: String,
    src: String,
    dest_parent: String,
    state: State<'_, SshState>,
) -> Result<RemoteEntry, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let is_dir = conn
        .sftp
        .metadata(src.clone())
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    let dest = unique_path(&conn.sftp, &dest_parent, posix_basename(&src)).await;
    conn.sftp
        .rename(src, dest.clone())
        .await
        .map_err(|e| format!("Falha ao mover: {e}"))?;
    Ok(RemoteEntry {
        name: posix_basename(&dest).to_string(),
        path: dest,
        is_dir,
    })
}

/// Recursively deletes a remote path (SFTP has no recursive remove).
fn remove_recursive<'a>(
    sftp: &'a SftpSession,
    path: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let is_dir = sftp
            .metadata(path.clone())
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir {
            let entries = sftp
                .read_dir(path.clone())
                .await
                .map_err(|e| format!("Falha ao listar '{path}': {e}"))?;
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                remove_recursive(sftp, join_posix(&path, &name)).await?;
            }
            sftp.remove_dir(path.clone())
                .await
                .map_err(|e| format!("Falha ao remover pasta '{path}': {e}"))
        } else {
            sftp.remove_file(path.clone())
                .await
                .map_err(|e| format!("Falha ao remover '{path}': {e}"))
        }
    })
}

/// Deletes a remote file/folder (recursive — permanent, no remote recycle bin).
#[tauri::command]
pub async fn ssh_delete(
    conn_id: String,
    path: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    remove_recursive(&conn.sftp, path).await
}

/// Recursively copies a remote file/folder.
fn copy_recursive<'a>(
    sftp: &'a SftpSession,
    src: String,
    dest: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        let is_dir = sftp
            .metadata(src.clone())
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        if is_dir {
            sftp.create_dir(dest.as_str())
                .await
                .map_err(|e| format!("Falha ao criar '{dest}': {e}"))?;
            let entries = sftp
                .read_dir(src.clone())
                .await
                .map_err(|e| format!("Falha ao listar '{src}': {e}"))?;
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                copy_recursive(sftp, join_posix(&src, &name), join_posix(&dest, &name)).await?;
            }
            Ok(())
        } else {
            let bytes = sftp
                .read(src.as_str())
                .await
                .map_err(|e| format!("Falha ao ler '{src}': {e}"))?;
            sftp.write(dest.as_str(), &bytes)
                .await
                .map_err(|e| format!("Falha ao escrever '{dest}': {e}"))
        }
    })
}

/// Copies a remote file/folder into `dest_parent` (collision-safe).
#[tauri::command]
pub async fn ssh_copy(
    conn_id: String,
    src: String,
    dest_parent: String,
    state: State<'_, SshState>,
) -> Result<RemoteEntry, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let dest = unique_path(&conn.sftp, &dest_parent, posix_basename(&src)).await;
    copy_recursive(&conn.sftp, src.clone(), dest.clone()).await?;
    let is_dir = conn
        .sftp
        .metadata(dest.clone())
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    Ok(RemoteEntry {
        name: posix_basename(&dest).to_string(),
        path: dest,
        is_dir,
    })
}

// ---- Phase 3: remote terminal (PTY over an SSH channel) ----

/// Opens a PTY-backed remote shell and bridges it to the frontend using the same
/// `term-data` events the local PTY emits, so the xterm UI is host-agnostic.
#[tauri::command]
pub async fn ssh_term_create(
    conn_id: String,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    state: State<'_, SshState>,
    app: AppHandle,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    let channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Falha ao abrir canal do terminal: {e}"))?;
    channel
        .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("Falha ao alocar PTY remoto: {e}"))?;

    // Start the shell ALREADY in the workspace directory. Rather than typing a
    // `cd` into an interactive shell (which the shell would echo, cluttering the
    // output), we exec a login shell after cd-ing: the `cd` is part of the launch
    // command line, not stdin, so it never appears — the terminal just opens in
    // the right folder, like a freshly-spawned local shell.
    if cwd.is_empty() || cwd == "." {
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("Falha ao iniciar shell remoto: {e}"))?;
    } else {
        let launch = format!(
            "cd {} 2>/dev/null; exec \"${{SHELL:-/bin/bash}}\" -l",
            shell_quote(&cwd)
        );
        channel
            .exec(true, launch.as_bytes())
            .await
            .map_err(|e| format!("Falha ao iniciar shell remoto: {e}"))?;
    }

    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();
    let term_id = id.clone();
    let app_handle = app.clone();
    let mut channel = channel;

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let _ = app_handle
                            .emit("term-data", serde_json::json!({ "id": term_id, "data": text }));
                    }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                Some(input) = stdin_rx.recv() => {
                    if channel.data(&input[..]).await.is_err() {
                        break;
                    }
                }
                Some((c, r)) = resize_rx.recv() => {
                    let _ = channel.window_change(c, r, 0, 0).await;
                }
            }
        }
        let _ = app_handle.emit("term-exit", serde_json::json!({ "id": term_id }));
    });

    state.terminals.lock().await.insert(
        id,
        RemoteTerminal {
            conn_id,
            stdin_tx,
            resize_tx,
            task: task.abort_handle(),
        },
    );
    Ok(())
}

/// Sends keystrokes to a remote terminal.
#[tauri::command]
pub async fn ssh_term_write(
    id: String,
    data: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if let Some(term) = state.terminals.lock().await.get(&id) {
        let _ = term.stdin_tx.send(data.into_bytes());
    }
    Ok(())
}

/// Resizes a remote terminal's PTY.
#[tauri::command]
pub async fn ssh_term_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if let Some(term) = state.terminals.lock().await.get(&id) {
        let _ = term.resize_tx.send((cols as u32, rows as u32));
    }
    Ok(())
}

/// Closes a remote terminal (aborts its task, which drops the SSH channel).
#[tauri::command]
pub async fn ssh_term_close(id: String, state: State<'_, SshState>) -> Result<(), String> {
    if let Some(term) = state.terminals.lock().await.remove(&id) {
        term.task.abort();
    }
    Ok(())
}

// ---- Saved hosts (parse ~/.ssh/config, like VS Code / Zed) ----

/// A host entry parsed from `~/.ssh/config`.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedHost {
    /// The `Host` alias (what the user typed `ssh <alias>`).
    pub label: String,
    /// Resolved `HostName` (falls back to the alias).
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// User home dir (`USERPROFILE` on Windows, `HOME` elsewhere).
fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// Expands a leading `~/` to the user's home directory.
fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// Parses the `Host`/`HostName`/`User`/`Port`/`IdentityFile` directives from an
/// ssh config. Wildcard hosts (`Host *`) are skipped.
fn parse_ssh_config(content: &str) -> Vec<SavedHost> {
    let mut hosts = Vec::new();
    let mut current: Option<SavedHost> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let value = rest.trim().trim_start_matches('=').trim();
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                if let Some(h) = current.take() {
                    hosts.push(h);
                }
                let alias = value
                    .split_whitespace()
                    .find(|a| !a.contains('*') && !a.contains('?'));
                current = alias.map(|a| SavedHost {
                    label: a.to_string(),
                    host: a.to_string(),
                    user: None,
                    port: None,
                    identity_file: None,
                });
            }
            "hostname" => {
                if let Some(h) = current.as_mut() {
                    h.host = value.to_string();
                }
            }
            "user" => {
                if let Some(h) = current.as_mut() {
                    h.user = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(h) = current.as_mut() {
                    h.port = value.parse().ok();
                }
            }
            "identityfile" => {
                if let Some(h) = current.as_mut() {
                    h.identity_file = Some(expand_tilde(value));
                }
            }
            _ => {}
        }
    }
    if let Some(h) = current.take() {
        hosts.push(h);
    }
    hosts
}

/// Lists hosts saved in `~/.ssh/config` (empty when there's no config).
#[tauri::command]
pub async fn ssh_list_saved_hosts() -> Result<Vec<SavedHost>, String> {
    let Some(home) = home_dir() else {
        return Ok(Vec::new());
    };
    let config_path = home.join(".ssh").join("config");
    match tokio::fs::read_to_string(&config_path).await {
        Ok(content) => Ok(parse_ssh_config(&content)),
        Err(_) => Ok(Vec::new()),
    }
}

// ---- Remote exec (backs search; reusable by future remote git) ----

/// Output of a one-shot remote command.
struct ExecOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Runs `command` on the remote over a fresh exec channel and collects stdout,
/// stderr and the exit code.
async fn exec_capture(conn: &Connection, command: &str) -> Result<ExecOutput, String> {
    let mut channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Falha ao abrir canal: {e}"))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("Falha ao executar comando remoto: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = 0;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, .. }) => stderr.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status as i32,
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code,
    })
}

// ---- Phase 4: remote search (grep over an exec channel, VS Code-style) ----

/// Heavy dirs always pruned from a remote `grep`, mirroring the local search.
const REMOTE_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "vendor",
];

/// Caps to keep a runaway grep from flooding the UI.
const MAX_REMOTE_MATCHES: usize = 5000;
/// Truncate very long lines (same budget as the local search).
const MAX_LINE_LEN: usize = 400;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshLineMatch {
    line: u64,
    text: String,
    ranges: Vec<[u32; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshFileMatches {
    path: String,
    name: String,
    matches: Vec<SshLineMatch>,
}

/// Mirrors `search::SearchEvent`'s wire format so the same frontend handler works.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshSearchEvent {
    Matches {
        file: SshFileMatches,
    },
    Done {
        limit_hit: bool,
        cancelled: bool,
        elapsed_ms: u64,
        total_matches: usize,
        total_files: usize,
    },
}

/// Builds the Rust regex used to compute highlight ranges on each matched line.
fn build_range_regex(
    query: &str,
    options: &crate::search::SearchOptions,
) -> Result<regex::Regex, String> {
    let base = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{base})\b")
    } else {
        base
    };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| format!("Expressão de busca inválida: {e}"))
}

/// Char-offset highlight ranges of every match within `text` (clamped to the
/// truncated line length).
fn line_ranges(re: &regex::Regex, text: &str) -> Vec<[u32; 2]> {
    let mut ranges = Vec::new();
    for m in re.find_iter(text) {
        let start = text[..m.start()].chars().count() as u32;
        let end = text[..m.end()].chars().count() as u32;
        ranges.push([start, end]);
    }
    ranges
}

/// Builds the remote `grep` command line honoring the search options.
fn build_grep_command(root: &str, query: &str, options: &crate::search::SearchOptions) -> String {
    let mut cmd = String::from("grep -rnI --color=never");
    if !options.case_sensitive {
        cmd.push_str(" -i");
    }
    if options.whole_word {
        cmd.push_str(" -w");
    }
    cmd.push_str(if options.regex { " -E" } else { " -F" });
    for dir in REMOTE_SKIP_DIRS {
        cmd.push_str(&format!(" --exclude-dir={}", shell_quote(dir)));
    }
    for g in &options.include_globs {
        if !g.trim().is_empty() {
            cmd.push_str(&format!(" --include={}", shell_quote(g)));
        }
    }
    for g in &options.exclude_globs {
        if !g.trim().is_empty() {
            cmd.push_str(&format!(" --exclude={}", shell_quote(g)));
        }
    }
    // `-e <pat>` so patterns starting with `-` aren't read as flags.
    cmd.push_str(&format!(
        " -e {} -- {}",
        shell_quote(query),
        shell_quote(root)
    ));
    cmd
}

/// Streams a recursive remote search over SFTP's host using `grep`. Emits the
/// same events as the local search so the SearchPanel renders it unchanged.
#[tauri::command]
pub async fn ssh_search(
    conn_id: String,
    root: String,
    query: String,
    options: crate::search::SearchOptions,
    on_event: tauri::ipc::Channel<SshSearchEvent>,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        let _ = on_event.send(SshSearchEvent::Done {
            limit_hit: false,
            cancelled: false,
            elapsed_ms: 0,
            total_matches: 0,
            total_files: 0,
        });
        return Ok(());
    }

    let conn = get_conn(&state, &conn_id).await?;
    let re = build_range_regex(&query, &options)?;
    let command = build_grep_command(&root, &query, &options);
    let output = exec_capture(&conn, &command).await?;
    // grep exit codes: 0 = matches, 1 = none, 2 = error (bad path/permission).
    // All are tolerated — a best-effort search just yields fewer/no results.
    let _ = output.code;

    let mut total_matches = 0usize;
    let mut total_files = 0usize;
    let mut limit_hit = false;
    let mut current_path: Option<String> = None;
    let mut current: Vec<SshLineMatch> = Vec::new();

    let flush = |path: Option<String>,
                 matches: Vec<SshLineMatch>,
                 ev: &tauri::ipc::Channel<SshSearchEvent>| {
        if let Some(p) = path {
            if !matches.is_empty() {
                let name = posix_basename(&p).to_string();
                let _ = ev.send(SshSearchEvent::Matches {
                    file: SshFileMatches {
                        path: p,
                        name,
                        matches,
                    },
                });
            }
        }
    };

    for raw in output.stdout.lines() {
        // grep -rn format: `path:line:text`.
        let Some((path, after)) = raw.split_once(':') else {
            continue;
        };
        let Some((line_str, text)) = after.split_once(':') else {
            continue;
        };
        let Ok(line) = line_str.parse::<u64>() else {
            continue;
        };

        if current_path.as_deref() != Some(path) {
            let prev = current_path.replace(path.to_string());
            let batch = std::mem::take(&mut current);
            if prev.is_some() {
                total_files += 1;
            }
            flush(prev, batch, &on_event);
        }

        let mut text = text.to_string();
        if text.chars().count() > MAX_LINE_LEN {
            text = text.chars().take(MAX_LINE_LEN).collect();
        }
        let ranges = line_ranges(&re, &text);
        current.push(SshLineMatch { line, text, ranges });
        total_matches += 1;
        if total_matches >= MAX_REMOTE_MATCHES {
            limit_hit = true;
            break;
        }
    }
    // Flush the final file.
    if current_path.is_some() {
        total_files += 1;
    }
    flush(current_path, current, &on_event);

    let _ = on_event.send(SshSearchEvent::Done {
        limit_hit,
        cancelled: false,
        elapsed_ms: 0,
        total_matches,
        total_files,
    });
    Ok(())
}

// ---- Remote context graph (SSH parity for the Obsidian-style graph view) ----

/// Record separator used to frame each file in the graph dump stream. Chosen to
/// be vanishingly unlikely to occur at the start of a source line.
const GRAPH_NODE_MARKER: &str = "\n<<<FCNODE>>>";

/// `-name a -o -name b …` expression for the heavy + hidden dirs to prune in a
/// remote `find`, shared by the graph/knowledge dump and the Quick Open lister.
fn remote_prune_names() -> String {
    let mut prune = String::new();
    for (i, dir) in REMOTE_SKIP_DIRS.iter().enumerate() {
        if i > 0 {
            prune.push_str(" -o");
        }
        prune.push_str(&format!(" -name {}", shell_quote(dir)));
    }
    // Also prune hidden directories ('.?*' excludes "." and "..").
    prune.push_str(" -o -name '.?*'");
    prune
}

/// Builds the `find … | cat` one-liner that streams every graphable file as
/// `\n<<<FCNODE>>><rel>\n<content>` records. Heavy + hidden dirs are pruned, big
/// files skipped, and the file count capped — mirroring the local graph walk
/// (`graph::MAX_PARSE_SIZE` = 1_500_000, `graph::MAX_NODES` = 4000).
fn build_graph_dump_command(root: &str) -> String {
    let prune = remote_prune_names();

    let exts = [
        "*.md",
        "*.markdown",
        "*.mdx",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.jsx",
        "*.mjs",
        "*.cjs",
        "*.rs",
    ];
    let mut names = String::new();
    for (i, e) in exts.iter().enumerate() {
        if i > 0 {
            names.push_str(" -o");
        }
        names.push_str(&format!(" -name {}", shell_quote(e)));
    }

    format!(
        "cd {root} 2>/dev/null && find . -type d \\({prune} \\) -prune -o -type f \\({names} \\) -size -1500000c -print | head -n 4000 | while IFS= read -r f; do printf '\\n<<<FCNODE>>>%s\\n' \"${{f#./}}\"; cat -- \"$f\" 2>/dev/null; done",
        root = shell_quote(root),
    )
}

/// Parses the framed dump stream into `(rel, content)` pairs for the graph engine.
fn parse_graph_dump(stdout: &str) -> Vec<crate::graph::RawFile> {
    let mut files = Vec::new();
    for chunk in stdout.split(GRAPH_NODE_MARKER) {
        if chunk.is_empty() {
            continue;
        }
        let (rel, content) = chunk.split_once('\n').unwrap_or((chunk, ""));
        let rel = rel.trim();
        if rel.is_empty() {
            continue;
        }
        files.push(crate::graph::RawFile {
            rel: rel.to_string(),
            content: content.to_string(),
        });
    }
    files
}

/// Builds the context graph for a REMOTE workspace: streams the host's markdown +
/// code files in one exec, then runs the same link/import engine on them. The
/// heavy file I/O happens host-side, so it's fast even on big remote trees.
#[tauri::command]
pub async fn ssh_build_context_graph(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<crate::graph::GraphData, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let command = build_graph_dump_command(&root);
    let output = exec_capture(&conn, &command).await?;
    let files = parse_graph_dump(&output.stdout);
    Ok(crate::graph::build_context_graph_from_files(&root, files))
}

/// Remote twin of `build_knowledge_index`: streams the host's files (same dump as
/// the graph) and builds the richer index that backs the backlinks panel + RAG.
#[tauri::command]
pub async fn ssh_build_knowledge_index(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<crate::graph::KnowledgeIndex, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let output = exec_capture(&conn, &build_graph_dump_command(&root)).await?;
    let files = parse_graph_dump(&output.stdout);
    Ok(crate::graph::build_knowledge_index_from_files(&root, files))
}

/// Remote twin of `build_context_bundle` (RAG-lite): streams the host's files and
/// assembles the seed file + its graph neighbours as one markdown bundle.
#[tauri::command]
pub async fn ssh_build_context_bundle(
    conn_id: String,
    root: String,
    path: String,
    depth: usize,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let output = exec_capture(&conn, &build_graph_dump_command(&root)).await?;
    let files = parse_graph_dump(&output.stdout);
    crate::graph::context_bundle_from_files(&root, files, &path, depth, 60_000)
}

/// Remote twin of `list_project_files` (Quick Open / Ctrl+P): one `find` lists
/// every file host-side (no contents read), capped like the local walk.
#[tauri::command]
pub async fn ssh_list_project_files(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<Vec<crate::file_index::ProjectFile>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let prune = remote_prune_names();
    let command = format!(
        "cd {root} 2>/dev/null && find . -type d \\({prune} \\) -prune -o -type f -print | head -n 20000",
        root = shell_quote(&root),
    );
    let output = exec_capture(&conn, &command).await?;
    let base = root.trim_end_matches('/');
    let mut out = Vec::new();
    for raw in output.stdout.lines() {
        let rel = raw.trim().trim_start_matches("./");
        if rel.is_empty() {
            continue;
        }
        let name = posix_basename(rel).to_string();
        out.push(crate::file_index::ProjectFile::new(
            format!("{base}/{rel}"),
            name,
            rel.to_string(),
        ));
    }
    Ok(out)
}

// ---- Phase 5: remote git (drives the host's `git` CLI over an exec channel) ----

/// Runs `git -C <root> <args>` on the remote, returning stdout on success or the
/// stderr/stdout as an error on a non-zero exit (mirrors the local `run_git`).
async fn exec_git(conn: &Connection, root: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = format!("git -C {}", shell_quote(root));
    for a in args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    let output = exec_capture(conn, &cmd).await?;
    if output.code == 0 {
        Ok(output.stdout)
    } else {
        let msg = if output.stderr.trim().is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        Err(msg.trim().to_string())
    }
}

// ---- Remote git: history, blame, stash, discard (SSH parity for GitPanel) ----
//
// Each mirrors its local `git.rs` twin's arguments over `exec_git` and reuses the
// SAME parser (`git::parse_log_records` / `parse_blame` / `parse_stash_list`), so
// the GitPanel renders remote history/blame/stash identically to local.

/// Record format shared by the repo-wide and per-file remote logs (matches
/// `git.rs`): unit-separated fields, record-separated rows.
const REMOTE_LOG_FORMAT: &str = "--pretty=format:%H\x1f%h\x1f%an\x1f%ar\x1f%s\x1e";

#[tauri::command]
pub async fn ssh_git_log(
    conn_id: String,
    root: String,
    limit: u32,
    state: State<'_, SshState>,
) -> Result<Vec<crate::git::GitCommit>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    if exec_git(&conn, &root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(Vec::new());
    }
    let n = format!("-{limit}");
    let out = exec_git(&conn, &root, &["log", &n, "--no-color", REMOTE_LOG_FORMAT]).await?;
    crate::git::parse_log_records(&out)
}

#[tauri::command]
pub async fn ssh_git_log_file(
    conn_id: String,
    root: String,
    file: String,
    limit: u32,
    state: State<'_, SshState>,
) -> Result<Vec<crate::git::GitCommit>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    if exec_git(&conn, &root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(Vec::new());
    }
    let n = format!("-{limit}");
    let out = exec_git(
        &conn,
        &root,
        &[
            "log",
            &n,
            "--no-color",
            "--follow",
            REMOTE_LOG_FORMAT,
            "--",
            &file,
        ],
    )
    .await?;
    crate::git::parse_log_records(&out)
}

#[tauri::command]
pub async fn ssh_git_blame(
    conn_id: String,
    root: String,
    file: String,
    state: State<'_, SshState>,
) -> Result<Vec<crate::git::BlameHunk>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    if exec_git(&conn, &root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(Vec::new());
    }
    let out = exec_git(&conn, &root, &["blame", "--porcelain", "-M", "--", &file]).await?;
    Ok(crate::git::parse_blame(&out))
}

#[tauri::command]
pub async fn ssh_git_stash_list(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<Vec<crate::git::GitStashEntry>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    if exec_git(&conn, &root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(Vec::new());
    }
    let out = exec_git(&conn, &root, &["stash", "list", "--format=%gd\x1f%s"]).await?;
    Ok(crate::git::parse_stash_list(&out))
}

#[tauri::command]
pub async fn ssh_git_stash_push(
    conn_id: String,
    root: String,
    message: Option<String>,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let msg = message.unwrap_or_default();
    let mut args: Vec<&str> = vec!["stash", "push", "-u"];
    if !msg.trim().is_empty() {
        args.push("-m");
        args.push(&msg);
    }
    exec_git(&conn, &root, &args).await
}

#[tauri::command]
pub async fn ssh_git_stash_apply(
    conn_id: String,
    root: String,
    index: u32,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(
        &conn,
        &root,
        &["stash", "apply", &format!("stash@{{{index}}}")],
    )
    .await
}

#[tauri::command]
pub async fn ssh_git_stash_pop(
    conn_id: String,
    root: String,
    index: u32,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(
        &conn,
        &root,
        &["stash", "pop", &format!("stash@{{{index}}}")],
    )
    .await
}

#[tauri::command]
pub async fn ssh_git_stash_drop(
    conn_id: String,
    root: String,
    index: u32,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(
        &conn,
        &root,
        &["stash", "drop", &format!("stash@{{{index}}}")],
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_discard_file(
    conn_id: String,
    root: String,
    file: String,
    untracked: bool,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    if untracked {
        exec_git(&conn, &root, &["clean", "-f", "--", &file])
            .await
            .map(|_| ())
    } else {
        exec_git(
            &conn,
            &root,
            &[
                "restore",
                "--staged",
                "--worktree",
                "--source=HEAD",
                "--",
                &file,
            ],
        )
        .await
        .map(|_| ())
    }
}

#[tauri::command]
pub async fn ssh_git_discard_all(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(
        &conn,
        &root,
        &[
            "restore",
            "--staged",
            "--worktree",
            "--source=HEAD",
            "--",
            ".",
        ],
    )
    .await?;
    exec_git(&conn, &root, &["clean", "-fd"]).await.map(|_| ())
}

// ---- Remote run configurations (Run/Debug panel parity over SSH) ----

/// Detects run suggestions on the host (one exec: lockfile/Cargo flags + the
/// `package.json` body), reusing the local `runner::detect_configs` logic.
#[tauri::command]
pub async fn ssh_run_configs_detect(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<Vec<crate::runner::RunConfig>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let cmd = format!(
        "cd {root} 2>/dev/null; test -f pnpm-lock.yaml && echo FCRUN:pnpm; test -f yarn.lock && echo FCRUN:yarn; test -f Cargo.toml && echo FCRUN:cargo; echo FCRUN:PKG; cat package.json 2>/dev/null",
        root = shell_quote(&root),
    );
    let out = exec_capture(&conn, &cmd).await?.stdout;
    let (flags, pkg) = out.split_once("FCRUN:PKG\n").unwrap_or((out.as_str(), ""));
    let (mut pnpm, mut yarn, mut has_cargo) = (false, false, false);
    for line in flags.lines() {
        match line.trim() {
            "FCRUN:pnpm" => pnpm = true,
            "FCRUN:yarn" => yarn = true,
            "FCRUN:cargo" => has_cargo = true,
            _ => {}
        }
    }
    let runner = if pnpm {
        "pnpm"
    } else if yarn {
        "yarn"
    } else {
        "npm"
    };
    let pkg_json = if pkg.trim().is_empty() {
        None
    } else {
        Some(pkg)
    };
    Ok(crate::runner::detect_configs(pkg_json, runner, has_cargo))
}

/// Reads the saved `.project/run.json` on the host (empty when absent).
#[tauri::command]
pub async fn ssh_run_configs_load(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<Vec<crate::runner::RunConfig>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let path = remote_project_file(&root, "run.json");
    match conn.sftp.read(&path).await {
        Ok(bytes) => crate::runner::parse_run_file(&String::from_utf8_lossy(&bytes)),
        Err(_) => Ok(Vec::new()),
    }
}

/// Persists run configs to `.project/run.json` on the host (creating `.project`).
#[tauri::command]
pub async fn ssh_run_configs_save(
    conn_id: String,
    root: String,
    configs: Vec<crate::runner::RunConfig>,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    let dir = remote_project_dir(&root);
    ensure_remote_dir(&conn.sftp, &dir).await?;
    let json = crate::runner::serialize_run_file(configs)?;
    let path = remote_project_file(&root, "run.json");
    conn.sftp
        .write(path.as_str(), json.as_bytes())
        .await
        .map_err(|e| format!("Falha ao salvar '{path}': {e}"))
}

// ---- Remote agent config (.project/agents.json) over SFTP ----
//
// The agent itself can't run against a remote workspace yet (it executes
// locally — see the frontend guard), but its config + history persist in the
// workspace, so we load/save them on the host like any other `.project` file.

/// Reads `<root>/.project/agents.json` on the host; empty store when absent.
#[tauri::command]
pub async fn ssh_agents_load(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<serde_json::Value, String> {
    let conn = get_conn(&state, &conn_id).await?;
    let project_path = remote_project_file(&root, "agents.json");
    let bytes = match conn.sftp.read(&project_path).await {
        Ok(bytes) => Some(bytes),
        Err(_) => {
            let fallback_path = remote_agent_cache_file(&conn.sftp, &root).await?;
            conn.sftp.read(&fallback_path).await.ok()
        }
    };
    let Some(bytes) = bytes else {
        return Ok(crate::agents::empty_store());
    };
    let raw = String::from_utf8_lossy(&bytes);
    if raw.trim().is_empty() {
        return Ok(crate::agents::empty_store());
    }
    serde_json::from_str(&raw).map_err(|e| format!("O arquivo de agentes está inválido: {e}"))
}

/// Persists the agent store to `<root>/.project/agents.json` on the host.
#[tauri::command]
pub async fn ssh_agents_save(
    conn_id: String,
    root: String,
    store: serde_json::Value,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    let json = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("Falha ao serializar os agentes: {e}"))?;
    let project_path = remote_project_file(&root, "agents.json");
    let project_error = match write_remote_file(&conn.sftp, &project_path, json.as_bytes()).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    let fallback_path = remote_agent_cache_file(&conn.sftp, &root).await?;
    write_remote_file(&conn.sftp, &fallback_path, json.as_bytes())
        .await
        .map_err(|fallback_error| {
            format!(
                "Não foi possível salvar os agentes no projeto ({project_error}) nem na pasta pessoal remota ({fallback_error})."
            )
        })
}

/// Working-tree status on the remote (decorations + SCM list).
#[tauri::command]
pub async fn ssh_git_status(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<crate::git::GitStatus, String> {
    let conn = get_conn(&state, &conn_id).await?;
    if exec_git(&conn, &root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(crate::git::empty_status());
    }
    let raw = exec_git(&conn, &root, &["status", "--porcelain=v2", "--branch"]).await?;
    let mut status = crate::git::parse_status_v2(&raw);
    if status.branch == "(detached)" {
        if let Ok(sha) = exec_git(&conn, &root, &["rev-parse", "--short", "HEAD"]).await {
            status.branch = format!("({}…)", sha.trim());
        }
    }
    Ok(status)
}

/// Current branch name on the remote (status bar), or null when not a repo.
#[tauri::command]
pub async fn ssh_git_branch(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<Option<String>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    match exec_git(&conn, &root, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Ok(out) => {
            let b = out.trim();
            if b.is_empty() {
                Ok(None)
            } else if b == "HEAD" {
                // Detached: show a short sha.
                let sha = exec_git(&conn, &root, &["rev-parse", "--short", "HEAD"]).await?;
                Ok(Some(format!("({}…)", sha.trim())))
            } else {
                Ok(Some(b.to_string()))
            }
        }
        Err(_) => Ok(None),
    }
}

/// Local branches on the remote (branch picker).
#[tauri::command]
pub async fn ssh_git_branches(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<Vec<crate::git::GitBranchInfo>, String> {
    let conn = get_conn(&state, &conn_id).await?;
    if exec_git(&conn, &root, &["rev-parse", "--is-inside-work-tree"])
        .await
        .is_err()
    {
        return Ok(Vec::new());
    }
    let fmt = format!("--format={}", crate::git::BRANCHES_FORMAT);
    let raw = exec_git(
        &conn,
        &root,
        &["for-each-ref", "--sort=-committerdate", "refs/heads", &fmt],
    )
    .await?;
    Ok(crate::git::parse_branches(&raw))
}

#[tauri::command]
pub async fn ssh_git_checkout(
    conn_id: String,
    root: String,
    branch: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["checkout", &branch])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_create_branch(
    conn_id: String,
    root: String,
    name: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["checkout", "-b", &name])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_stage(
    conn_id: String,
    root: String,
    file: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["add", "--", &file])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_unstage(
    conn_id: String,
    root: String,
    file: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["reset", "--", &file])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_stage_all(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["add", "-A"]).await.map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_commit(
    conn_id: String,
    root: String,
    message: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A mensagem de commit não pode estar vazia.".to_string());
    }
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["commit", "-m", &message])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn ssh_git_fetch(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["fetch"]).await
}

#[tauri::command]
pub async fn ssh_git_pull(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["pull"]).await
}

#[tauri::command]
pub async fn ssh_git_push(
    conn_id: String,
    root: String,
    state: State<'_, SshState>,
) -> Result<String, String> {
    let conn = get_conn(&state, &conn_id).await?;
    exec_git(&conn, &root, &["push"]).await
}

// ---- Phase 6: remote LSP (run the server on the host, tunnel its stdio over an
// SSH exec channel into a local WebSocket — same contract as `lsp_start_server`) ----

/// Starts a language server ON THE REMOTE and bridges its stdio to a local
/// WebSocket, returning the `{ port, token }` monaco connects to. `command` is a
/// full shell command run on the host (e.g. `typescript-language-server --stdio`).
/// The server binary must already exist on the remote (acquisition is the
/// caller's concern — like the local Roslyn/TS resolver).
#[tauri::command]
pub async fn ssh_lsp_start(
    conn_id: String,
    id: String,
    command: String,
    cwd: String,
    state: State<'_, SshState>,
) -> Result<BridgeInfo, String> {
    if let Some(old) = state.lsp_bridges.lock().await.remove(&id) {
        old.task.abort();
    }

    let conn = get_conn(&state, &conn_id).await?;
    let channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Falha ao abrir canal do LSP: {e}"))?;
    // Run in the workspace dir. The caller's `command` should `exec` the final
    // server binary so EOF/signals on channel close reach it (not just the shell).
    let remote_cmd = if cwd.is_empty() || cwd == "." {
        command
    } else {
        format!("cd {} && {}", shell_quote(&cwd), command)
    };
    channel
        .exec(true, remote_cmd.as_bytes())
        .await
        .map_err(|e| format!("Falha ao iniciar o LSP remoto: {e}"))?;
    let stream = channel.into_stream();

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Falha ao abrir a ponte LSP: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = Uuid::new_v4().to_string();
    let task_token = token.clone();

    let task = tokio::spawn(async move {
        if let Ok((tcp, _addr)) = listener.accept().await {
            if let Err(e) = serve_remote_lsp(tcp, &task_token, stream).await {
                eprintln!("[ssh:lsp] erro na ponte: {e}");
            }
        }
    });

    state.lsp_bridges.lock().await.insert(
        id,
        RemoteLspBridge {
            conn_id,
            task: task.abort_handle(),
        },
    );
    Ok(BridgeInfo { port, token })
}

/// Stops a remote LSP bridge (aborting drops the channel → kills the server).
#[tauri::command]
pub async fn ssh_lsp_stop(id: String, state: State<'_, SshState>) -> Result<(), String> {
    if let Some(bridge) = state.lsp_bridges.lock().await.remove(&id) {
        bridge.task.abort();
    }
    Ok(())
}

/// Proxies one token-authenticated WS connection to the remote server's stdio
/// over `stream` (the SSH channel), framing with the shared LSP codec.
// The handshake callback's `Err` (an `http::Response`) is fixed by tungstenite,
// so it can't be boxed — allow the large-error lint here.
#[allow(clippy::result_large_err)]
async fn serve_remote_lsp<S>(
    tcp: tokio::net::TcpStream,
    expected_token: &str,
    stream: S,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let mut authorized = false;
    let callback = |req: &Request, response: Response| {
        let ok = req
            .uri()
            .query()
            .unwrap_or("")
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .any(|(k, v)| k == "token" && v == expected_token);
        if ok {
            authorized = true;
            Ok(response)
        } else {
            Err(Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Some("invalid token".to_string()))
                .expect("rejection response"))
        }
    };

    let ws = tokio_tungstenite::accept_hdr_async(tcp, callback).await?;
    if !authorized {
        return Ok(());
    }

    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = tokio::io::BufReader::new(read_half);
    let (mut ws_sink, mut ws_stream) = ws.split();

    // remote server stdout -> ws (client)
    let to_ws = async move {
        while let Ok(Some(json)) = codec::read_message(&mut reader).await {
            if ws_sink.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
    };

    // ws (client) -> remote server stdin
    let to_srv = async move {
        while let Some(Ok(msg)) = ws_stream.next().await {
            match msg {
                Message::Text(text) => {
                    if codec::write_message(&mut write_half, &text).await.is_err() {
                        break;
                    }
                }
                Message::Binary(bytes) => {
                    if let Ok(text) = String::from_utf8(bytes) {
                        if codec::write_message(&mut write_half, &text).await.is_err() {
                            break;
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = to_ws => {}
        _ = to_srv => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_posix_separates_with_slash() {
        assert_eq!(join_posix("/home/user", "file.txt"), "/home/user/file.txt");
    }

    #[test]
    fn join_posix_does_not_double_trailing_slash() {
        assert_eq!(join_posix("/", "etc"), "/etc");
        assert_eq!(join_posix("/var/", "log"), "/var/log");
    }

    #[test]
    fn join_posix_handles_relative_root() {
        // Empty/relative roots (home shorthand) still produce a usable path.
        assert_eq!(join_posix(".", "src"), "./src");
    }

    #[test]
    fn project_paths_handle_root_and_trailing_slashes() {
        assert_eq!(remote_project_dir("/"), "/.project");
        assert_eq!(remote_project_dir("/home/dev/"), "/home/dev/.project");
        assert_eq!(
            remote_project_file("/home/dev", "agents.json"),
            "/home/dev/.project/agents.json"
        );
    }

    #[test]
    fn agent_cache_is_stable_and_scoped_by_workspace() {
        let first = remote_agent_cache_dir("/home/rafael", "/srv/project");
        let same = remote_agent_cache_dir("/home/rafael/", "/srv/project/");
        let other = remote_agent_cache_dir("/home/rafael", "/srv/other");

        assert_eq!(first, same);
        assert_ne!(first, other);
        assert!(first.starts_with("/home/rafael/.fluent-coder/workspaces/"));
        assert_eq!(first.rsplit('/').next().unwrap().len(), 16);
    }

    #[test]
    fn directory_chain_builds_each_sftp_mkdir_level() {
        assert_eq!(
            directory_chain("/home/dev/.project"),
            vec!["/home", "/home/dev", "/home/dev/.project"]
        );
        assert_eq!(
            directory_chain("workspace/.project"),
            vec!["workspace", "workspace/.project"]
        );
    }

    #[test]
    fn posix_basename_and_dirname() {
        assert_eq!(posix_basename("/a/b/c.txt"), "c.txt");
        assert_eq!(posix_basename("/a/b/"), "b");
        assert_eq!(posix_dirname("/a/b/c.txt"), "/a/b");
        assert_eq!(posix_dirname("/top"), "/");
        assert_eq!(posix_dirname("rel"), ".");
    }

    #[test]
    fn split_name_separates_extension() {
        assert_eq!(split_name("file.txt"), ("file", ".txt"));
        assert_eq!(split_name("noext"), ("noext", ""));
        assert_eq!(split_name(".bashrc"), (".bashrc", ""));
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("/a/b"), "'/a/b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn build_grep_command_honors_options() {
        let opts = crate::search::SearchOptions {
            case_sensitive: false,
            whole_word: true,
            regex: false,
            ..Default::default()
        };
        let cmd = build_grep_command("/srv/app", "to do", &opts);
        assert!(cmd.contains(" -i"));
        assert!(cmd.contains(" -w"));
        assert!(cmd.contains(" -F")); // literal
        assert!(cmd.contains("--exclude-dir='node_modules'"));
        assert!(cmd.contains("-e 'to do'"));
        assert!(cmd.contains("-- '/srv/app'"));
    }

    #[test]
    fn line_ranges_finds_char_offsets() {
        let opts = crate::search::SearchOptions::default();
        let re = build_range_regex("ção", &opts).unwrap();
        // Accented chars before the match must count as chars, not bytes.
        let ranges = line_ranges(&re, "a função ção");
        assert_eq!(ranges.last().copied(), Some([9, 12]));
    }

    #[test]
    fn parse_ssh_config_reads_host_blocks() {
        let cfg = "\
# comment
Host prod
    HostName 10.0.0.1
    User deploy
    Port 2222

Host *.internal
    User shared

Host gh
    HostName github.com
";
        let hosts = parse_ssh_config(cfg);
        // The wildcard block (`Host *.internal`) is skipped, leaving 2 hosts.
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].label, "prod");
        assert_eq!(hosts[0].host, "10.0.0.1");
        assert_eq!(hosts[0].user.as_deref(), Some("deploy"));
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[1].label, "gh");
        assert_eq!(hosts[1].host, "github.com");
    }
}
