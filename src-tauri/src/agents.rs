use agent_client_protocol::schema::v1::{
    ClientCapabilities, ContentBlock, FileSystemCapabilities, InitializeRequest, NewSessionRequest,
    PermissionOptionKind, PromptRequest, ReadTextFileRequest, ReadTextFileResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate, TextContent,
    WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, ConnectionTo};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpEvent {
    Text { content: String },
    Status { message: String },
    Done { stop_reason: String },
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WorkerKey {
    provider: String,
    root: PathBuf,
}

/// Long-lived provider processes keyed by provider/workspace. Codex uses its
/// official app-server; Claude keeps the ACP adapter.
pub struct AcpState {
    workers: Mutex<HashMap<WorkerKey, mpsc::UnboundedSender<PromptJob>>>,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
        }
    }

    fn worker_for(
        &self,
        key: WorkerKey,
    ) -> Result<(mpsc::UnboundedSender<PromptJob>, bool), String> {
        let mut workers = self
            .workers
            .lock()
            .map_err(|error| format!("Falha ao acessar os processos de agentes: {error}"))?;

        if let Some(worker) = workers.get(&key) {
            if !worker.is_closed() {
                return Ok((worker.clone(), true));
            }
        }

        let (sender, receiver) = mpsc::unbounded_channel();
        let provider = key.provider.clone();
        let root = key.root.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = run_worker(provider, root, receiver).await {
                eprintln!("[agent] worker encerrado: {error}");
            }
        });
        workers.insert(key, sender.clone());
        Ok((sender, false))
    }

    fn stop_workspace(&self, root: &Path) -> Result<(), String> {
        let mut workers = self
            .workers
            .lock()
            .map_err(|error| format!("Falha ao acessar os processos de agentes: {error}"))?;
        workers.retain(|key, _| key.root != root);
        Ok(())
    }

    fn discard_worker(&self, key: &WorkerKey) -> Result<(), String> {
        let mut workers = self
            .workers
            .lock()
            .map_err(|error| format!("Falha ao acessar os processos de agentes: {error}"))?;
        workers.remove(key);
        Ok(())
    }

    pub fn shutdown_all(&self) {
        if let Ok(mut workers) = self.workers.lock() {
            workers.clear();
        }
    }
}

struct PromptJob {
    conversation_id: String,
    context_prompt: String,
    prompt: String,
    mode: AgentMode,
    on_event: Channel<AcpEvent>,
    done: oneshot::Sender<Result<(), String>>,
}

#[derive(Clone)]
struct ActiveRequest {
    mode: AgentMode,
    on_event: Channel<AcpEvent>,
}

struct SessionRuntime {
    session_id: SessionId,
}

/// What the agent is allowed to do for a given send. File callbacks enforce the
/// boundary for every provider; Codex also receives its native sandbox mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentMode {
    /// Read-only: the agent may answer, never write files.
    Ask,
    /// Read-only for code, but may write Markdown (`.md`) plan files.
    Plan,
    /// Read/write inside the workspace. Native provider sandboxes remain active.
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
    conversation_id: String,
    context_prompt: String,
    prompt: String,
    mode: String,
    on_event: Channel<AcpEvent>,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Envie uma mensagem antes de iniciar o agente.".into());
    }
    if conversation_id.trim().is_empty() {
        return Err("A conversa do agente não foi identificada.".into());
    }

    let mode = AgentMode::parse(&mode)?;
    let root = fs::canonicalize(&workspace_root)
        .map_err(|error| format!("Não foi possível validar o workspace: {error}"))?;
    if !root.is_dir() {
        return Err("O workspace informado não é uma pasta.".into());
    }

    let label = provider_label(&provider)?;
    let key = WorkerKey {
        provider: provider.clone(),
        root,
    };
    let (worker, reused) = state.worker_for(key.clone())?;
    let _ = on_event.send(AcpEvent::Status {
        message: if reused {
            format!("Reutilizando o processo {label}…")
        } else if provider == "codex" {
            "Iniciando a conexão direta com o Codex CLI…".into()
        } else {
            format!("Iniciando {label} via ACP…")
        },
    });

    let (done, completed) = oneshot::channel();
    let job = PromptJob {
        conversation_id,
        context_prompt,
        prompt,
        mode,
        on_event: on_event.clone(),
        done,
    };
    if let Err(error) = worker.send(job) {
        state.discard_worker(&key)?;
        let (replacement, _) = state.worker_for(key)?;
        let _ = on_event.send(AcpEvent::Status {
            message: format!("Reiniciando o processo {label} após uma desconexão…"),
        });
        replacement
            .send(error.0)
            .map_err(|_| format!("Não foi possível reiniciar o processo {label}."))?;
    }

    match completed.await {
        Ok(result) => result,
        Err(_) => {
            let message = format!(
                "O processo {label} encerrou durante a resposta. Envie novamente para reiniciá-lo."
            );
            let _ = on_event.send(AcpEvent::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

#[tauri::command]
pub fn acp_stop_workspace(
    workspace_root: String,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    let root = fs::canonicalize(&workspace_root)
        .map_err(|error| format!("Não foi possível validar o workspace: {error}"))?;
    state.stop_workspace(&root)
}

async fn run_worker(
    provider: String,
    root: PathBuf,
    jobs: mpsc::UnboundedReceiver<PromptJob>,
) -> Result<(), String> {
    match provider.as_str() {
        "codex" => run_codex_worker(root, jobs).await,
        "claude" => run_acp_worker(provider, root, jobs).await,
        _ => Err(format!("Provedor desconhecido: {provider}")),
    }
}

struct CodexAppServer {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<AsyncBufReader<ChildStdout>>,
    next_request_id: u64,
}

impl CodexAppServer {
    async fn launch(root: &Path) -> Result<Self, String> {
        let binary = which::which("codex").map_err(|error| {
            format!(
                "Codex CLI não encontrado. Instale/autentique o Codex e confirme que `codex` está no PATH. Detalhes: {error}"
            )
        })?;
        let mut command = Command::new(binary);
        command
            .arg("app-server")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("Falha ao iniciar o Codex CLI: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "O Codex CLI não abriu o canal de entrada.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "O Codex CLI não abriu o canal de saída.".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = AsyncBufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[codex] {line}");
                }
            });
        }

        let mut server = Self {
            child,
            stdin,
            stdout: AsyncBufReader::new(stdout).lines(),
            next_request_id: 1,
        };
        let response = server
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "fluent-coder",
                        "title": "Fluent Coder",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;
        ensure_rpc_success(&response, "inicializar o Codex")?;
        server.send(json!({ "method": "initialized" })).await?;
        Ok(server)
    }

    async fn send(&mut self, message: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&message)
            .map_err(|error| format!("Falha ao serializar uma mensagem do Codex: {error}"))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Falha ao enviar uma mensagem ao Codex: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Falha ao liberar uma mensagem para o Codex: {error}"))
    }

    async fn next_message(&mut self) -> Result<Value, String> {
        let line = self
            .stdout
            .next_line()
            .await
            .map_err(|error| format!("Falha ao ler a resposta do Codex: {error}"))?
            .ok_or_else(|| {
                let status = self
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|status| format!(" ({status})"))
                    .unwrap_or_default();
                format!("O processo do Codex encerrou inesperadamente{status}.")
            })?;
        serde_json::from_str(&line)
            .map_err(|error| format!("O Codex enviou uma mensagem inválida: {error}"))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.send(json!({ "id": id, "method": method, "params": params }))
            .await?;

        loop {
            let message = self.next_message().await?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return Ok(message);
            }
            self.reject_server_request(&message).await?;
        }
    }

    async fn reject_server_request(&mut self, message: &Value) -> Result<(), String> {
        let Some(id) = message.get("id").cloned() else {
            return Ok(());
        };
        if message.get("method").is_none() {
            return Ok(());
        }
        self.send(json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": "Esta solicitação interativa não é suportada pelo Fluent Coder."
            }
        }))
        .await
    }

    async fn start_thread(&mut self, root: &Path, mode: AgentMode) -> Result<String, String> {
        let response = self
            .request(
                "thread/start",
                json!({
                    "cwd": root,
                    "approvalPolicy": "never",
                    "sandbox": codex_sandbox_mode(mode),
                    "ephemeral": true
                }),
            )
            .await?;
        let result = ensure_rpc_success(&response, "criar uma conversa no Codex")?;
        result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "O Codex não retornou o identificador da conversa.".into())
    }

    async fn run_turn(
        &mut self,
        thread_id: &str,
        root: &Path,
        mode: AgentMode,
        prompt: String,
        on_event: &Channel<AcpEvent>,
    ) -> Result<String, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.send(json!({
            "id": id,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "cwd": root,
                "approvalPolicy": "never",
                "sandboxPolicy": codex_sandbox_policy(mode, root),
                "input": [{
                    "type": "text",
                    "text": prompt
                }]
            }
        }))
        .await?;

        let mut acknowledged = false;
        let mut completion: Option<Result<String, String>> = None;
        loop {
            let message = self.next_message().await?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                ensure_rpc_success(&message, "iniciar a resposta do Codex")?;
                acknowledged = true;
            } else if let Some(method) = message.get("method").and_then(Value::as_str) {
                match method {
                    "item/agentMessage/delta" => {
                        if message.pointer("/params/threadId").and_then(Value::as_str)
                            == Some(thread_id)
                        {
                            if let Some(delta) =
                                message.pointer("/params/delta").and_then(Value::as_str)
                            {
                                let _ = on_event.send(AcpEvent::Text {
                                    content: delta.to_owned(),
                                });
                            }
                        }
                    }
                    "turn/completed" => {
                        if message.pointer("/params/threadId").and_then(Value::as_str)
                            == Some(thread_id)
                        {
                            completion = Some(codex_turn_result(&message));
                        }
                    }
                    "error" => {
                        if message.pointer("/params/threadId").and_then(Value::as_str)
                            == Some(thread_id)
                            && !message
                                .pointer("/params/willRetry")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                        {
                            let error = message
                                .pointer("/params/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("O Codex encontrou um erro durante a resposta.");
                            completion = Some(Err(error.to_owned()));
                        }
                    }
                    "item/started" => {
                        let status = match message
                            .pointer("/params/item/type")
                            .and_then(Value::as_str)
                        {
                            Some("commandExecution") => Some("Codex executando uma ferramenta…"),
                            Some("fileChange") => Some("Codex aplicando alterações…"),
                            Some("webSearch") => Some("Codex pesquisando…"),
                            _ => None,
                        };
                        if let Some(message) = status {
                            let _ = on_event.send(AcpEvent::Status {
                                message: message.into(),
                            });
                        }
                    }
                    _ => {}
                }
                self.reject_server_request(&message).await?;
            }

            if acknowledged {
                if let Some(result) = completion.take() {
                    return result;
                }
            }
        }
    }
}

fn ensure_rpc_success<'a>(message: &'a Value, action: &str) -> Result<&'a Value, String> {
    if let Some(error) = message.get("error") {
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("erro desconhecido");
        return Err(format!("Não foi possível {action}: {detail}"));
    }
    message
        .get("result")
        .ok_or_else(|| format!("O Codex não confirmou que conseguiu {action}."))
}

fn codex_sandbox_mode(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Ask | AgentMode::Plan => "read-only",
        AgentMode::Dev => "workspace-write",
    }
}

fn codex_sandbox_policy(mode: AgentMode, root: &Path) -> Value {
    match mode {
        AgentMode::Ask | AgentMode::Plan => json!({
            "type": "readOnly",
            "networkAccess": false
        }),
        AgentMode::Dev => json!({
            "type": "workspaceWrite",
            "writableRoots": [root],
            "networkAccess": false,
            "excludeSlashTmp": false,
            "excludeTmpdirEnvVar": false
        }),
    }
}

fn codex_turn_result(message: &Value) -> Result<String, String> {
    let status = message
        .pointer("/params/turn/status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    match status {
        "completed" => Ok(status.into()),
        "interrupted" => Err("A resposta do Codex foi interrompida.".into()),
        _ => Err(message
            .pointer("/params/turn/error/message")
            .and_then(Value::as_str)
            .unwrap_or("O Codex não conseguiu concluir a resposta.")
            .to_owned()),
    }
}

async fn run_codex_worker(
    root: PathBuf,
    mut jobs: mpsc::UnboundedReceiver<PromptJob>,
) -> Result<(), String> {
    let mut server = match CodexAppServer::launch(&root).await {
        Ok(server) => server,
        Err(message) => {
            // The first request is normally already queued while the CLI starts.
            // Complete it with the real startup error instead of only dropping
            // its oneshot channel and showing a generic disconnect message.
            if let Some(job) = jobs.recv().await {
                let _ = job.on_event.send(AcpEvent::Error {
                    message: message.clone(),
                });
                let _ = job.done.send(Err(message.clone()));
            }
            return Err(message);
        }
    };
    let mut sessions: HashMap<String, String> = HashMap::new();

    while let Some(job) = jobs.recv().await {
        let is_new_session = !sessions.contains_key(&job.conversation_id);
        let result: Result<(), String> = async {
            let thread_id = if let Some(thread_id) = sessions.get(&job.conversation_id) {
                thread_id.clone()
            } else {
                let thread_id = server.start_thread(&root, job.mode).await?;
                sessions.insert(job.conversation_id.clone(), thread_id.clone());
                thread_id
            };
            let _ = job.on_event.send(AcpEvent::Status {
                message: if is_new_session {
                    "Codex conectado. Preparando a conversa…".into()
                } else {
                    "Sessão Codex ativa. Processando a mensagem…".into()
                },
            });

            let prompt = prompt_for_session(is_new_session, &job.context_prompt, &job.prompt);
            let directed_prompt = format!("{}\n\n{}", mode_directive(job.mode), prompt);
            let stop_reason = server
                .run_turn(&thread_id, &root, job.mode, directed_prompt, &job.on_event)
                .await?;
            let _ = job.on_event.send(AcpEvent::Done { stop_reason });
            Ok(())
        }
        .await;

        if let Err(message) = &result {
            let _ = job.on_event.send(AcpEvent::Error {
                message: message.clone(),
            });
        }
        let _ = job.done.send(result);
        if let Some(status) = server
            .child
            .try_wait()
            .map_err(|error| format!("Falha ao consultar o processo do Codex: {error}"))?
        {
            return Err(format!(
                "O processo do Codex encerrou inesperadamente ({status})."
            ));
        }
    }
    Ok(())
}

async fn run_acp_worker(
    provider: String,
    root: PathBuf,
    mut jobs: mpsc::UnboundedReceiver<PromptJob>,
) -> Result<(), String> {
    let agent = provider_agent(&provider)?;
    let active_request: Arc<Mutex<Option<ActiveRequest>>> = Arc::default();
    let notification_request = active_request.clone();
    let read_request = active_request.clone();
    let write_request = active_request.clone();
    let permission_request = active_request.clone();
    let read_root = root.clone();
    let write_root = root.clone();
    let permission_provider = provider.clone();
    let worker_provider = provider.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if let SessionUpdate::AgentMessageChunk(chunk) = notification.update {
                    if let ContentBlock::Text(text) = chunk.content {
                        if let Some(request) = current_request(&notification_request) {
                            let _ = request.on_event.send(AcpEvent::Text { content: text.text });
                        }
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
                let result = if current_request(&read_request).is_some() {
                    read_workspace_text(&read_root, &request.path, request.line, request.limit)
                } else {
                    Err("não há uma solicitação ativa para autorizar a leitura".into())
                };
                match result {
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
                let result = current_request(&write_request)
                    .ok_or_else(|| "não há uma solicitação ativa para autorizar a escrita".into())
                    .and_then(|active| {
                        write_workspace_text(
                            &write_root,
                            &request.path,
                            &request.content,
                            active.mode,
                        )
                    });
                match result {
                    Ok(()) => responder.respond(WriteTextFileResponse::default()),
                    Err(error) => responder.respond_with_internal_error(error),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _connection| {
                let active = current_request(&permission_request);
                let mode = active.as_ref().map(|request| request.mode);
                match mode.and_then(|mode| approve_permission(&request, mode, &permission_provider))
                {
                    Some(outcome) => responder.respond(RequestPermissionResponse::new(outcome)),
                    None => {
                        if let Some(active) = active {
                            let _ = active.on_event.send(AcpEvent::Status {
                                message: format!(
                                    "Operação bloqueada pelo modo {}: {}",
                                    mode_label(active.mode),
                                    permission_title(&request)
                                ),
                            });
                        }
                        responder
                            .respond(RequestPermissionResponse::new(reject_permission(&request)))
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            // Capabilities are negotiated once for this long-lived connection.
            // Per-request mode checks still gate every write in the callbacks.
            let capabilities = ClientCapabilities::new().fs(FileSystemCapabilities::new()
                .read_text_file(true)
                .write_text_file(true));
            let initialize =
                InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities);

            let _ = connection.send_request(initialize).block_task().await?;
            let mut sessions: HashMap<String, SessionRuntime> = HashMap::new();

            while let Some(job) = jobs.recv().await {
                set_current_request(
                    &active_request,
                    Some(ActiveRequest {
                        mode: job.mode,
                        on_event: job.on_event.clone(),
                    }),
                );

                let result = process_job(&connection, &root, &mut sessions, &job)
                    .await
                    .map_err(|error| format_acp_error(&worker_provider, error.to_string()));

                if let Err(message) = &result {
                    let _ = job.on_event.send(AcpEvent::Error {
                        message: message.clone(),
                    });
                }
                let _ = job.done.send(result);
                set_current_request(&active_request, None);
            }
            Ok(())
        })
        .await
        .map_err(|error| format_acp_error(&provider, error.to_string()))
}

async fn process_job(
    connection: &ConnectionTo<Agent>,
    root: &Path,
    sessions: &mut HashMap<String, SessionRuntime>,
    job: &PromptJob,
) -> Result<(), agent_client_protocol::Error> {
    let is_new_session = !sessions.contains_key(&job.conversation_id);
    if is_new_session {
        let response = connection
            .send_request(NewSessionRequest::new(root))
            .block_task()
            .await?;
        sessions.insert(
            job.conversation_id.clone(),
            SessionRuntime {
                session_id: response.session_id,
            },
        );
    }

    let session = sessions
        .get_mut(&job.conversation_id)
        .expect("a sessão ACP deve existir após a criação");

    let _ = job.on_event.send(AcpEvent::Status {
        message: if is_new_session {
            "Agente conectado. Preparando a conversa…".into()
        } else {
            "Sessão ativa. Processando a mensagem…".into()
        },
    });

    // Rebuild the complete context only when the ACP session is new (first
    // message, app restart or worker recovery). A live session receives only the
    // new turn, avoiding duplicated history and prompts that grow every send.
    let prompt = prompt_for_session(is_new_session, &job.context_prompt, &job.prompt);
    let directed_prompt = format!("{}\n\n{}", mode_directive(job.mode), prompt);
    let response = connection
        .send_request(PromptRequest::new(
            session.session_id.clone(),
            vec![ContentBlock::Text(TextContent::new(directed_prompt))],
        ))
        .block_task()
        .await?;

    let _ = job.on_event.send(AcpEvent::Done {
        stop_reason: format!("{:?}", response.stop_reason),
    });
    Ok(())
}

fn prompt_for_session<'a>(
    is_new_session: bool,
    context_prompt: &'a str,
    prompt: &'a str,
) -> &'a str {
    if is_new_session {
        context_prompt
    } else {
        prompt
    }
}

fn current_request(active: &Arc<Mutex<Option<ActiveRequest>>>) -> Option<ActiveRequest> {
    active.lock().ok().and_then(|request| request.clone())
}

fn set_current_request(active: &Arc<Mutex<Option<ActiveRequest>>>, request: Option<ActiveRequest>) {
    if let Ok(mut current) = active.lock() {
        *current = request;
    }
}

fn provider_agent(provider: &str) -> Result<AcpAgent, String> {
    let package = match provider {
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

/// Providers without native modes retain the previous Dev behavior and approve
/// requests. Codex uses native sandbox modes, so requests beyond that sandbox
/// are rejected instead of silently escalating outside the workspace.
fn approve_permission(
    request: &RequestPermissionRequest,
    mode: AgentMode,
    provider: &str,
) -> Option<RequestPermissionOutcome> {
    // Codex handles in-workspace operations through its native read-only/auto
    // sandbox. Any permission request is therefore an escalation beyond that
    // profile and must stay blocked to preserve the workspace boundary.
    if provider == "codex" {
        return None;
    }
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

    let file = fs::File::open(&target)
        .map_err(|error| format!("não foi possível ler o arquivo: {error}"))?;
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
        assert!(provider_agent("claude").is_ok());
        assert!(provider_agent("codex").is_err());
        assert!(provider_agent("other").is_err());
    }

    #[test]
    fn codex_modes_use_native_workspace_sandboxes() {
        assert_eq!(codex_sandbox_mode(AgentMode::Ask), "read-only");
        assert_eq!(codex_sandbox_mode(AgentMode::Plan), "read-only");
        assert_eq!(codex_sandbox_mode(AgentMode::Dev), "workspace-write");
    }

    #[test]
    fn parses_codex_turn_completion() {
        assert_eq!(
            codex_turn_result(&json!({
                "params": { "turn": { "status": "completed" } }
            }))
            .unwrap(),
            "completed"
        );
        assert!(codex_turn_result(&json!({
            "params": {
                "turn": {
                    "status": "failed",
                    "error": { "message": "falhou" }
                }
            }
        }))
        .unwrap_err()
        .contains("falhou"));
    }

    #[test]
    fn live_session_receives_only_the_new_turn() {
        assert_eq!(
            prompt_for_session(true, "contexto completo", "mensagem"),
            "contexto completo"
        );
        assert_eq!(
            prompt_for_session(false, "contexto completo", "mensagem"),
            "mensagem"
        );
    }
}
