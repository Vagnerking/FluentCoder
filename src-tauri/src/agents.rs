use agent_client_protocol::schema::v1::{
    ClientCapabilities, ContentBlock, FileSystemCapabilities, InitializeRequest, NewSessionRequest,
    PermissionOptionKind, PromptRequest, ReadTextFileRequest, ReadTextFileResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, TextContent,
    WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Notify;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpEvent {
    Text { content: String },
    Status { message: String },
    Done { stop_reason: String },
    Error { message: String },
}

/// Cancellation handle for the in-flight ACP prompt. The UI's `agentBusy` is
/// global — only one prompt runs at a time — so a single shared `Notify` is
/// enough: `acp_prompt` races the connect future against `cancel.notified()`,
/// and `acp_cancel` wakes that waiter. When the cancel branch wins, the connect
/// future is dropped, and the SDK's `ChildGuard` kills the adapter subprocess on
/// drop. This is provider-independent: it works even for adapters (like Codex's)
/// that keep their stdio process alive after sending `Done`, or that ignore the
/// protocol-level `$/cancel_request`.
pub struct AcpState {
    cancel: Arc<Notify>,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(Notify::new()),
        }
    }
}

impl Default for AcpState {
    fn default() -> Self {
        Self::new()
    }
}

/// What the agent is allowed to do for a given send. Enforced here on the client
/// side (read/write capability + permission outcomes) so it doesn't rely on each
/// provider exposing matching native modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMode {
    /// Read-only: the agent may answer, never write files.
    Ask,
    /// Read-only for code, but may write Markdown (`.md`) plan files.
    Plan,
    /// Full read/write; permission requests are auto-approved (bypass).
    Dev,
}

impl AgentMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ask" => Ok(Self::Ask),
            "plan" => Ok(Self::Plan),
            "dev" => Ok(Self::Dev),
            other => Err(format!("Modo de agente desconhecido: {other}")),
        }
    }

    /// Whether the agent may write any file at all in this mode.
    fn can_write(self) -> bool {
        matches!(self, Self::Plan | Self::Dev)
    }

    /// Whether a write to `path` is allowed under this mode's policy.
    fn allows_write_to(self, path: &Path) -> bool {
        match self {
            Self::Ask => false,
            // Plan may only produce Markdown plan files.
            Self::Plan => path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md")),
            Self::Dev => true,
        }
    }
}

fn agents_file(root: &str) -> Result<PathBuf, String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Não foi possível validar o workspace: {error}"))?;
    if !canonical_root.is_dir() {
        return Err("O workspace informado não é uma pasta.".into());
    }
    Ok(canonical_root.join(".project").join("agents.json"))
}

#[tauri::command]
pub fn agents_load(root: String) -> Result<Value, String> {
    let path = agents_file(&root)?;
    if !path.exists() {
        return Ok(empty_store());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Falha ao ler os agentes locais: {error}"))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("O arquivo de agentes está inválido: {error}"))
}

#[tauri::command]
pub fn agents_save(root: String, store: Value) -> Result<(), String> {
    let path = agents_file(&root)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Não foi possível localizar a pasta .project.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Falha ao criar a pasta .project: {error}"))?;
    let json = serde_json::to_string_pretty(&store)
        .map_err(|error| format!("Falha ao serializar os agentes: {error}"))?;
    fs::write(path, json).map_err(|error| format!("Falha ao salvar os agentes: {error}"))
}

#[tauri::command]
pub async fn acp_prompt(
    provider: String,
    workspace_root: String,
    prompt: String,
    mode: String,
    on_event: Channel<AcpEvent>,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Envie uma mensagem antes de iniciar o agente.".into());
    }

    // Arm cancellation before any work starts. Creating the `Notified` future up
    // front means a cancel that races in right after this point is still caught
    // by the `select!` below, rather than being missed.
    let cancel = Arc::clone(&state.cancel);
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);

    let mode = AgentMode::parse(&mode)?;
    let root = fs::canonicalize(&workspace_root)
        .map_err(|error| format!("Não foi possível validar o workspace: {error}"))?;
    if !root.is_dir() {
        return Err("O workspace informado não é uma pasta.".into());
    }

    let agent = provider_agent(&provider)?;
    let notification_channel = on_event.clone();
    let read_root = root.clone();
    let write_root = root.clone();
    let permission_channel = on_event.clone();
    let prompt_channel = on_event.clone();

    let _ = on_event.send(AcpEvent::Status {
        message: if provider == "codex" {
            "Iniciando Codex via ACP… A primeira execução pode baixar o adaptador.".to_string()
        } else {
            format!("Iniciando {} via ACP…", provider_label(&provider)?)
        },
    });

    let run = agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if let SessionUpdate::AgentMessageChunk(chunk) = notification.update {
                    if let ContentBlock::Text(text) = chunk.content {
                        let _ = notification_channel.send(AcpEvent::Text { content: text.text });
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: ReadTextFileRequest, responder, _connection| {
                // Reads that fail (outside the workspace, missing, non-UTF8…) must
                // surface as a protocol error — never as fabricated file content,
                // which would mask the denial and feed the agent garbage.
                match read_workspace_text(
                    &read_root,
                    &request.path,
                    request.line,
                    request.limit,
                ) {
                    Ok(content) => responder.respond(ReadTextFileResponse::new(content)),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WriteTextFileRequest, responder, _connection| {
                // Mode policy gates every write: Ask rejects all, Plan only `.md`,
                // Dev anything inside the workspace. Path is re-validated here so
                // the agent can't escape the root regardless of mode.
                match write_workspace_text(&write_root, &request.path, &request.content, mode) {
                    Ok(()) => responder.respond(WriteTextFileResponse::default()),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                match approve_permission(&request, mode) {
                    Some(outcome) => responder
                        .respond(RequestPermissionResponse::new(outcome)),
                    None => {
                        let _ = permission_channel.send(AcpEvent::Status {
                            message: format!(
                                "Operação bloqueada pelo modo {}: {}",
                                mode_label(mode),
                                permission_title(&request)
                            ),
                        });
                        responder.respond(RequestPermissionResponse::new(reject_permission(
                            &request,
                        )))
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            let capabilities = ClientCapabilities::new().fs(FileSystemCapabilities::new()
                .read_text_file(true)
                .write_text_file(mode.can_write()));
            let initialize =
                InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities);

            let _ = connection.send_request(initialize).block_task().await?;

            let session = connection
                .send_request(NewSessionRequest::new(root))
                .block_task()
                .await?;

            let _ = prompt_channel.send(AcpEvent::Status {
                message: "Agente conectado. Processando a mensagem…".into(),
            });

            let directed_prompt = format!("{}\n\n{}", mode_directive(mode), prompt);
            let response = connection
                .send_request(PromptRequest::new(
                    session.session_id,
                    vec![ContentBlock::Text(TextContent::new(directed_prompt))],
                ))
                .block_task()
                .await?;

            let _ = prompt_channel.send(AcpEvent::Done {
                stop_reason: format!("{:?}", response.stop_reason),
            });
            Ok(())
        });

    // Race the agent run against a cancel signal. If cancel wins, `run` is
    // dropped here — tearing down the connection and killing the adapter
    // subprocess — and we report a clean stop instead of an error.
    tokio::select! {
        result = run => result.map_err(|error| {
            let message = format_acp_error(&provider, error.to_string());
            let _ = on_event.send(AcpEvent::Error {
                message: message.clone(),
            });
            message
        }),
        _ = &mut cancelled => {
            let _ = on_event.send(AcpEvent::Done {
                stop_reason: "Cancelled".to_string(),
            });
            Ok(())
        }
    }
}

/// Cancels the in-flight ACP prompt, if any. Waking the `Notify` makes the
/// `select!` in `acp_prompt` drop the agent future, which kills the adapter
/// subprocess. A no-op when nothing is running (no waiter to notify).
#[tauri::command]
pub fn acp_cancel(state: State<'_, AcpState>) {
    state.cancel.notify_waiters();
}

fn provider_agent(provider: &str) -> Result<AcpAgent, String> {
    let package = match provider {
        "codex" => Ok("@zed-industries/codex-acp@0.16.0"),
        "claude" => Ok("@agentclientprotocol/claude-agent-acp@0.48.0"),
        _ => Err(format!("Provedor ACP desconhecido: {provider}")),
    }?;

    let cache = std::env::temp_dir().join("fluent-coder-acp-npx");
    fs::create_dir_all(&cache)
        .map_err(|error| format!("Não foi possível preparar o cache ACP: {error}"))?;
    let cache = cache.to_string_lossy().to_string();

    #[cfg(windows)]
    let args = vec![
        "cmd.exe".to_string(),
        "/d".to_string(),
        "/s".to_string(),
        "/c".to_string(),
        "npx".to_string(),
        "-y".to_string(),
        "--cache".to_string(),
        cache,
        package.to_string(),
    ];
    #[cfg(not(windows))]
    let args = vec![
        "npx".to_string(),
        "-y".to_string(),
        "--cache".to_string(),
        cache,
        package.to_string(),
    ];

    AcpAgent::from_args(args).map_err(|error| error.to_string())
}

fn provider_label(provider: &str) -> Result<&'static str, String> {
    match provider {
        "codex" => Ok("Codex"),
        "claude" => Ok("Claude"),
        _ => Err(format!("Provedor ACP desconhecido: {provider}")),
    }
}

fn permission_title(request: &RequestPermissionRequest) -> String {
    request
        .tool_call
        .fields
        .title
        .clone()
        .unwrap_or_else(|| "ferramenta solicitada pelo agente".into())
}

fn reject_permission(request: &RequestPermissionRequest) -> RequestPermissionOutcome {
    let rejected = request.options.iter().find(|option| {
        matches!(
            option.kind,
            PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways
        )
    });
    rejected.map_or(RequestPermissionOutcome::Cancelled, |option| {
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone()))
    })
}

/// In Dev mode every permission is auto-approved (bypass); other modes return
/// `None` so the caller rejects. Returns the "allow" outcome to send back.
fn approve_permission(
    request: &RequestPermissionRequest,
    mode: AgentMode,
) -> Option<RequestPermissionOutcome> {
    if mode != AgentMode::Dev {
        return None;
    }
    let allowed = request.options.iter().find(|option| {
        matches!(
            option.kind,
            PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways
        )
    })?;
    Some(RequestPermissionOutcome::Selected(
        SelectedPermissionOutcome::new(allowed.option_id.clone()),
    ))
}

fn mode_label(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Ask => "Ask",
        AgentMode::Plan => "Plan",
        AgentMode::Dev => "Dev",
    }
}

/// System directive prepended to the prompt so the agent's behavior matches the
/// client-enforced policy (and the agent doesn't waste a turn attempting writes
/// the client will reject).
fn mode_directive(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Ask => {
            "MODO ASK (somente leitura): responda e explique. Você NÃO pode criar, \
             editar ou apagar arquivos; qualquer tentativa de escrita será rejeitada."
        }
        AgentMode::Plan => {
            "MODO PLAN: investigue e produza um plano. Você só pode escrever arquivos \
             Markdown (.md) contendo o plano; qualquer outra escrita será rejeitada."
        }
        AgentMode::Dev => {
            "MODO DEV: você pode ler, criar, editar e apagar arquivos do workspace \
             para implementar o que for pedido."
        }
    }
}

/// Writes `content` to `path` after enforcing the workspace boundary and the
/// mode's write policy. New files are allowed (only the parent dir must exist
/// and be inside the workspace).
fn write_workspace_text(
    workspace_root: &Path,
    requested_path: &Path,
    content: &str,
    mode: AgentMode,
) -> Result<(), String> {
    if !mode.can_write() {
        return Err(format!(
            "o modo {} é somente leitura; escrita rejeitada",
            mode_label(mode)
        ));
    }
    if !mode.allows_write_to(requested_path) {
        return Err(format!(
            "o modo {} só permite escrever arquivos .md de plano",
            mode_label(mode)
        ));
    }

    // The file may not exist yet, so validate the parent dir (which must) rather
    // than the file itself, then rebuild the full target from the canonical dir.
    let parent = requested_path
        .parent()
        .ok_or_else(|| "path de escrita inválido".to_string())?;
    let file_name = requested_path
        .file_name()
        .ok_or_else(|| "path de escrita sem nome de arquivo".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("diretório de destino inacessível: {error}"))?;
    if !canonical_parent.starts_with(workspace_root) {
        return Err("o path de escrita está fora do workspace aberto".into());
    }

    let target = canonical_parent.join(file_name);
    fs::write(&target, content)
        .map_err(|error| format!("não foi possível escrever o arquivo: {error}"))
}

fn read_workspace_text(
    workspace_root: &Path,
    requested_path: &Path,
    line: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    let target = fs::canonicalize(requested_path)
        .map_err(|error| format!("arquivo inacessível: {error}"))?;
    if !target.starts_with(workspace_root) {
        return Err("o path solicitado está fora do workspace aberto".into());
    }
    if !target.is_file() {
        return Err("o path solicitado não é um arquivo".into());
    }

    let file =
        fs::File::open(&target).map_err(|error| format!("não foi possível ler o arquivo: {error}"))?;
    read_lines(BufReader::new(file), line, limit)
}

/// Streams the requested line window without materializing the whole file, so an
/// agent reading one line of a huge log/artifact can't OOM the editor. Non-UTF8
/// content is reported as an error instead of being lossily coerced.
fn read_lines<R: BufRead>(
    reader: R,
    line: Option<u32>,
    limit: Option<u32>,
) -> Result<String, String> {
    let start = line.unwrap_or(1).saturating_sub(1) as usize;
    let max = limit.map_or(usize::MAX, |value| value as usize);

    let mut selected = Vec::new();
    for (index, entry) in reader.lines().enumerate() {
        if index < start {
            // Still surface a read/decoding failure even while skipping ahead.
            entry.map_err(decode_error)?;
            continue;
        }
        if selected.len() >= max {
            break;
        }
        selected.push(entry.map_err(decode_error)?);
    }
    Ok(selected.join("\n"))
}

fn decode_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::InvalidData {
        "o arquivo não está em UTF-8 e não pode ser lido como texto".into()
    } else {
        format!("não foi possível ler o arquivo: {error}")
    }
}

fn empty_store() -> Value {
    json!({
        "version": 1,
        "agents": [],
        "conversations": []
    })
}

fn format_acp_error(provider: &str, error: String) -> String {
    format!(
        "Falha ao iniciar {} via ACP. Confirme que Node.js/npx está disponível e que o provedor está autenticado. Detalhes: {error}",
        provider_label(provider).unwrap_or("o provedor")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("fluent-coder-agents-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn slices_requested_file_lines() {
        let reader = BufReader::new("a\nb\nc\nd".as_bytes());
        assert_eq!(read_lines(reader, Some(2), Some(2)).unwrap(), "b\nc");
    }

    #[test]
    fn reports_non_utf8_content_as_error() {
        // 0xFF is never valid in a UTF-8 stream.
        let reader = BufReader::new(&[0xFFu8, 0xFE, b'\n'][..]);
        let error = read_lines(reader, None, None).unwrap_err();
        assert!(error.contains("UTF-8"));
    }

    #[test]
    fn refuses_reads_outside_workspace() {
        let root = temp_workspace();
        let outside = root.parent().unwrap().join("fluent-coder-outside.txt");
        fs::write(&outside, "segredo").unwrap();

        let result = read_workspace_text(&fs::canonicalize(&root).unwrap(), &outside, None, None);

        assert!(result.unwrap_err().contains("fora do workspace"));
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ask_mode_rejects_every_write() {
        let root = fs::canonicalize(temp_workspace()).unwrap();
        let target = root.join("notes.md");
        let result = write_workspace_text(&root, &target, "x", AgentMode::Ask);
        assert!(result.unwrap_err().contains("somente leitura"));
        assert!(!target.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plan_mode_allows_only_markdown() {
        let root = fs::canonicalize(temp_workspace()).unwrap();

        let md = root.join("plano.md");
        write_workspace_text(&root, &md, "# Plano", AgentMode::Plan).unwrap();
        assert_eq!(fs::read_to_string(&md).unwrap(), "# Plano");

        let code = root.join("main.rs");
        let result = write_workspace_text(&root, &code, "fn main() {}", AgentMode::Plan);
        assert!(result.unwrap_err().contains(".md"));
        assert!(!code.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dev_mode_writes_any_file_inside_workspace() {
        let root = fs::canonicalize(temp_workspace()).unwrap();
        let target = root.join("src.ts");
        write_workspace_text(&root, &target, "export {}", AgentMode::Dev).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "export {}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dev_mode_refuses_writes_outside_workspace() {
        let root = fs::canonicalize(temp_workspace()).unwrap();
        let outside = root.parent().unwrap().join("fluent-coder-escape.ts");
        let result = write_workspace_text(&root, &outside, "x", AgentMode::Dev);
        assert!(result.unwrap_err().contains("fora do workspace"));
        assert!(!outside.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persists_agents_inside_project_folder() {
        let root = temp_workspace();
        agents_save(
            root.to_string_lossy().to_string(),
            json!({"version": 1, "agents": [{"id": "a"}], "conversations": []}),
        )
        .unwrap();

        let loaded = agents_load(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(loaded["agents"][0]["id"], "a");
        assert!(root.join(".project").join("agents.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn provider_registry_supports_required_adapters() {
        assert!(provider_agent("codex").is_ok());
        assert!(provider_agent("claude").is_ok());
        assert!(provider_agent("other").is_err());
    }
}
