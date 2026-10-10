//! Cliente genérico do **Agent Client Protocol** (ACP — agentclientprotocol.com)
//! para os CLIs que falam o protocolo por stdio (Gemini CLI, opencode, Qwen
//! Code, Copilot CLI, Goose…).
//!
//! Fluxo: `initialize` → `session/new` (ou `session/load` para retomar) →
//! `session/prompt`, com o streaming em notificações `session/update` e os
//! pedidos de permissão (`session/request_permission`) virando cartões de
//! aprovação no chat. Um processo por provedor+workspace atende todas as
//! conversas (o ACP multiplexa sessões numa conexão).
//!
//! O cliente oferece `fs/read_text_file`/`fs/write_text_file` (dos buffers do
//! Monaco, com edições desfazíveis) e `terminal/*` (PTY real, visível no painel
//! de terminais) — ver `acp_client.rs`; os pedidos são atendidos em tarefas
//! próprias, sem travar a conexão. Os modos do Fluent Chat são aplicados pelos mecanismos nativos
//! do agente (`configOptions` de categoria `mode` ou `session/set_mode`) e pela
//! política de aprovação — nunca por texto injetado no prompt.

use super::acp_client::ClientServices;
use super::registry::ProviderDescriptor;
use super::{
    approval_label, cap_text, knowledge_mcp_server, new_request_id, prompt_for_session,
    AcpEvent, AgentMode, ApprovalOption, ApprovalReply, FileDiff, ModelInfo,
    PromptJob, ToolCallEvent, UsageInfo,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

const PROTOCOL_VERSION: u64 = 1;
const INIT_TIMEOUT: Duration = Duration::from_secs(45);
const OUTPUT_CAP: usize = 4000;

/// Estado de uma sessão ACP viva neste processo.
#[derive(Debug, Default, Clone)]
struct SessionState {
    session_id: String,
    /// Modos oferecidos (`modes.availableModes` ou `configOptions` de
    /// categoria `mode`): (id/valor, nome).
    modes: Vec<(String, String)>,
    /// `configId` quando os modos vêm de `configOptions` (preferido).
    mode_config_id: Option<String>,
    models: Vec<ModelInfo>,
    current_model: Option<String>,
    model_config_id: Option<String>,
    applied_mode: Option<AgentMode>,
    applied_model: Option<String>,
}

struct AcpConnection {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<AsyncBufReader<ChildStdout>>,
    next_id: u64,
    load_session: bool,
    sessions: HashMap<String, SessionState>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
    /// fs/* e terminal/* atendidos para o agente.
    services: ClientServices,
    /// Respostas das tarefas que atendem pedidos do agente (enviadas pelo loop).
    out_tx: mpsc::UnboundedSender<Value>,
    out_rx: Option<mpsc::UnboundedReceiver<Value>>,
}

impl Drop for AcpConnection {
    fn drop(&mut self) {
        self.services.shutdown();
    }
}

/// Contexto de uma chamada: para onde vão os eventos, como responder pedidos
/// de permissão e se a chamada pode ser cancelada.
struct CallCtx<'a> {
    job: Option<&'a PromptJob>,
    provider_id: &'a str,
    session_id: Option<String>,
    /// `false` durante o replay do `session/load` (o histórico já está na UI).
    emit_updates: bool,
    cancellable: bool,
    cancel_sent: bool,
    replies_tx: mpsc::UnboundedSender<ApprovalReply>,
    replies_rx: mpsc::UnboundedReceiver<ApprovalReply>,
    /// Pedidos de permissão aguardando o usuário: request_id → id JSON-RPC.
    pending: HashMap<String, Value>,
    got_output: bool,
}

impl<'a> CallCtx<'a> {
    fn new(job: Option<&'a PromptJob>, provider_id: &'a str) -> Self {
        let (replies_tx, replies_rx) = mpsc::unbounded_channel();
        Self {
            job,
            provider_id,
            session_id: None,
            emit_updates: false,
            cancellable: false,
            cancel_sent: false,
            replies_tx,
            replies_rx,
            pending: HashMap::new(),
            got_output: false,
        }
    }

    fn emit(&self, event: AcpEvent) {
        if let Some(job) = self.job {
            let _ = job.on_event.send(event);
        }
    }
}

/// Decisão automática de um pedido de permissão conforme o modo.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum PermissionPolicy {
    Allow,
    Reject,
    AskUser,
}

/// Política de permissão por modo (o equivalente ACP dos modos nativos):
/// - Bypass: tudo permitido;
/// - Perguntar/Planejar: leitura pura — escrita/comandos negados, o resto pergunta;
/// - Editar: edições permitidas, comandos negados (igual ao Claude/Codex);
/// - Agente: tudo vira cartão de aprovação.
pub(crate) fn permission_policy(mode: AgentMode, tool_kind: &str) -> PermissionPolicy {
    let writes = matches!(tool_kind, "edit" | "delete" | "move");
    let executes = tool_kind == "execute";
    match mode {
        AgentMode::Bypass => PermissionPolicy::Allow,
        AgentMode::Ask | AgentMode::Plan if writes || executes => PermissionPolicy::Reject,
        AgentMode::Edit if writes => PermissionPolicy::Allow,
        AgentMode::Edit if executes => PermissionPolicy::Reject,
        _ => PermissionPolicy::AskUser,
    }
}

/// Escolhe o modo nativo do agente que corresponde ao modo do Fluent Chat,
/// casando id/nome por vocabulário conhecido (Claude/Gemini/Qwen/opencode…).
pub(crate) fn pick_native_mode(mode: AgentMode, available: &[(String, String)]) -> Option<String> {
    let candidates: &[&str] = match mode {
        AgentMode::Ask => &["ask", "read-only", "readonly", "read_only", "chat"],
        AgentMode::Plan => &["plan", "architect", "planning"],
        AgentMode::Edit => &["acceptedits", "accept_edits", "auto_edit", "autoedit", "auto-edit", "edit", "code"],
        AgentMode::Auto => &["default", "auto", "agent", "build", "normal"],
        AgentMode::Bypass => &[
            "bypasspermissions",
            "bypass",
            "yolo",
            "full-access",
            "full_access",
            "dangerously-skip-permissions",
        ],
    };
    let normalize = |value: &str| value.trim().to_lowercase().replace(' ', "-");
    for candidate in candidates {
        if let Some((id, _)) = available
            .iter()
            .find(|(id, name)| normalize(id) == *candidate || normalize(name) == *candidate)
        {
            return Some(id.clone());
        }
    }
    None
}

/// Converte o conteúdo de uma notificação `session/update` em eventos do chat.
pub(crate) fn map_session_update(update: &Value) -> Vec<AcpEvent> {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "agent_message_chunk" => content_text(update.get("content"))
            .map(|content| vec![AcpEvent::Text { content }])
            .unwrap_or_default(),
        "agent_thought_chunk" => content_text(update.get("content"))
            .map(|content| vec![AcpEvent::Thought { content }])
            .unwrap_or_default(),
        "tool_call" | "tool_call_update" => map_tool_call(update)
            .map(|call| vec![AcpEvent::ToolCall { call }])
            .unwrap_or_default(),
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if entries.is_empty() {
                return vec![];
            }
            let done = entries
                .iter()
                .all(|entry| entry.get("status").and_then(Value::as_str) == Some("completed"));
            let detail = entries
                .iter()
                .map(|entry| {
                    let mark = match entry.get("status").and_then(Value::as_str) {
                        Some("completed") => "[x]",
                        Some("in_progress") => "[~]",
                        _ => "[ ]",
                    };
                    format!(
                        "{mark} {}",
                        entry.get("content").and_then(Value::as_str).unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            vec![AcpEvent::ToolCall {
                call: ToolCallEvent {
                    id: "plan".into(),
                    kind: Some("plan".into()),
                    title: Some("Plano".into()),
                    status: Some(if done { "completed" } else { "in_progress" }.into()),
                    detail: Some(detail),
                    ..Default::default()
                },
            }]
        }
        "usage_update" => {
            let cost = update.get("cost").and_then(|cost| {
                cost.as_f64()
                    .or_else(|| cost.get("amount").and_then(Value::as_f64))
            });
            vec![AcpEvent::Usage {
                usage: UsageInfo {
                    context_used: update.get("used").and_then(Value::as_u64),
                    context_window: update.get("size").and_then(Value::as_u64),
                    cost_usd: cost,
                    ..Default::default()
                },
            }]
        }
        _ => vec![],
    }
}

fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    match content.get("type").and_then(Value::as_str) {
        Some("text") => content
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned),
        Some("resource_link") => content
            .get("uri")
            .and_then(Value::as_str)
            .map(|uri| format!("[{uri}]({uri})")),
        _ => None,
    }
}

/// `tool_call`/`tool_call_update` (ou o `toolCall` de um pedido de permissão)
/// → evento de chamada de ferramenta.
pub(crate) fn map_tool_call(value: &Value) -> Option<ToolCallEvent> {
    let id = value.get("toolCallId").and_then(Value::as_str)?.to_owned();
    let mut call = ToolCallEvent {
        id,
        kind: value.get("kind").and_then(Value::as_str).map(str::to_owned),
        title: value.get("title").and_then(Value::as_str).map(str::to_owned),
        status: value.get("status").and_then(Value::as_str).map(str::to_owned),
        ..Default::default()
    };
    if let Some(locations) = value.get("locations").and_then(Value::as_array) {
        call.locations = locations
            .iter()
            .filter_map(|location| {
                let path = location.get("path").and_then(Value::as_str)?;
                Some(match location.get("line").and_then(Value::as_u64) {
                    Some(line) => format!("{path}:{line}"),
                    None => path.to_owned(),
                })
            })
            .collect();
    }
    if let Some(raw) = value.get("rawInput").filter(|raw| !raw.is_null()) {
        call.detail = Some(match raw.get("command") {
            Some(Value::String(command)) => command.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
            _ => cap_text(&raw.to_string(), 1000),
        });
    }
    let mut output = Vec::new();
    if let Some(items) = value.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("diff") => {
                    if let Some(path) = item.get("path").and_then(Value::as_str) {
                        call.diffs.push(FileDiff {
                            path: path.to_owned(),
                            old_text: item
                                .get("oldText")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            new_text: item
                                .get("newText")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            unified: None,
                        });
                    }
                }
                Some("content") => {
                    if let Some(text) = content_text(item.get("content")) {
                        output.push(text);
                    }
                }
                _ => {}
            }
        }
    }
    if !output.is_empty() {
        call.output = Some(cap_text(&output.join("\n"), OUTPUT_CAP));
    }
    Some(call)
}

/// Lê `modes`/`models`/`configOptions` da resposta de `session/new|load`.
fn read_session_capabilities(state: &mut SessionState, result: &Value) {
    if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
        for option in options {
            let category = option.get("category").and_then(Value::as_str);
            let config_id = option.get("id").and_then(Value::as_str).map(str::to_owned);
            let values: Vec<(String, String)> = option
                .get("options")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| {
                            let id = value.get("value").and_then(Value::as_str)?;
                            let name = value.get("name").and_then(Value::as_str).unwrap_or(id);
                            Some((id.to_owned(), name.to_owned()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            match category {
                Some("mode") => {
                    state.modes = values;
                    state.mode_config_id = config_id;
                }
                Some("model") => {
                    state.models = values
                        .into_iter()
                        .map(|(id, label)| ModelInfo { id, label })
                        .collect();
                    state.model_config_id = config_id;
                    state.current_model = option
                        .get("currentValue")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                _ => {}
            }
        }
    }
    if state.modes.is_empty() {
        if let Some(modes) = result.pointer("/modes/availableModes").and_then(Value::as_array) {
            state.modes = modes
                .iter()
                .filter_map(|mode| {
                    let id = mode.get("id").and_then(Value::as_str)?;
                    let name = mode.get("name").and_then(Value::as_str).unwrap_or(id);
                    Some((id.to_owned(), name.to_owned()))
                })
                .collect();
        }
    }
    if state.models.is_empty() {
        if let Some(models) = result
            .pointer("/models/availableModels")
            .and_then(Value::as_array)
        {
            state.models = models
                .iter()
                .filter_map(|model| {
                    let id = model.get("modelId").and_then(Value::as_str)?;
                    let label = model.get("name").and_then(Value::as_str).unwrap_or(id);
                    Some(ModelInfo {
                        id: id.to_owned(),
                        label: label.to_owned(),
                    })
                })
                .collect();
            state.current_model = result
                .pointer("/models/currentModelId")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
    }
}

fn rpc_error_message(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("erro desconhecido");
    match error.get("data") {
        Some(Value::String(data)) if !data.is_empty() => format!("{message} ({data})"),
        _ => message.to_owned(),
    }
}

fn is_auth_error(error: &Value) -> bool {
    error.get("code").and_then(Value::as_i64) == Some(-32000)
        || error
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.to_lowercase().contains("auth"))
}

/// Erro de uma chamada: a resposta de erro JSON-RPC (para decidir fallbacks)
/// ou uma falha de transporte/processo.
enum CallError {
    Rpc(Value),
    Fatal(String),
}

impl CallError {
    fn message(&self, action: &str) -> String {
        match self {
            CallError::Rpc(error) => format!("Não foi possível {action}: {}", rpc_error_message(error)),
            CallError::Fatal(message) => message.clone(),
        }
    }
}

impl AcpConnection {
    async fn launch(desc: &ProviderDescriptor, root: &Path) -> Result<Self, String> {
        match Self::launch_with(desc, root, &desc.args).await {
            Ok(connection) => Ok(connection),
            Err(error) if !desc.fallback_args.is_empty() => {
                eprintln!(
                    "[acp:{}] initialize falhou com {:?}, tentando {:?}: {error}",
                    desc.id, desc.args, desc.fallback_args
                );
                Self::launch_with(desc, root, &desc.fallback_args)
                    .await
                    .map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }

    async fn launch_with(
        desc: &ProviderDescriptor,
        root: &Path,
        args: &[String],
    ) -> Result<Self, String> {
        let binary = which::which(&desc.binary).map_err(|_| {
            format!(
                "{} não encontrado. Instale com `{}` e confirme que `{}` está no PATH.",
                desc.label, desc.install_hint, desc.binary
            )
        })?;
        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &desc.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Falha ao iniciar o {}: {error}", desc.label))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("O {} não abriu o canal de entrada.", desc.label))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("O {} não abriu o canal de saída.", desc.label))?;
        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::default();
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            let id = desc.id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = AsyncBufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[acp:{id}] {line}");
                    if let Ok(mut tail) = tail.lock() {
                        if tail.len() >= 8 {
                            tail.remove(0);
                        }
                        tail.push(line);
                    }
                }
            });
        }

        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let mut connection = Self {
            child,
            stdin,
            stdout: AsyncBufReader::new(stdout).lines(),
            next_id: 1,
            load_session: false,
            sessions: HashMap::new(),
            stderr_tail,
            services: ClientServices::new(root),
            out_tx,
            out_rx: Some(out_rx),
        };
        let mut ctx = CallCtx::new(None, &desc.id);
        let init = connection.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": ClientServices::capabilities(),
                "clientInfo": {
                    "name": "fluent-coder",
                    "title": "Fluent Coder",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
            &mut ctx,
        );
        let result = match tokio::time::timeout(INIT_TIMEOUT, init).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                return Err(format!(
                    "{}{}",
                    error.message(&format!("inicializar o {}", desc.label)),
                    connection.stderr_suffix()
                ))
            }
            Err(_) => {
                return Err(format!(
                    "O {} não respondeu à inicialização a tempo.{}",
                    desc.label,
                    connection.stderr_suffix()
                ))
            }
        };
        connection.load_session = result
            .pointer("/agentCapabilities/loadSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(connection)
    }

    fn stderr_suffix(&self) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .map(|lines| lines.join(" | "))
            .unwrap_or_default();
        if tail.trim().is_empty() {
            String::new()
        } else {
            format!(" Detalhes: {tail}")
        }
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    async fn send(&mut self, message: Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(&message)
            .map_err(|error| format!("Falha ao serializar uma mensagem do agente: {error}"))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Falha ao enviar uma mensagem ao agente: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Falha ao liberar uma mensagem para o agente: {error}"))
    }

    async fn next_message(&mut self) -> Result<Value, String> {
        loop {
            let line = self
                .stdout
                .next_line()
                .await
                .map_err(|error| format!("Falha ao ler a resposta do agente: {error}"))?;
            let Some(line) = line else {
                let status = self
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|status| format!(" ({status})"))
                    .unwrap_or_default();
                return Err(format!(
                    "O agente encerrou inesperadamente{status}.{}",
                    self.stderr_suffix()
                ));
            };
            if line.trim().is_empty() {
                continue;
            }
            // Linhas que não são JSON (logs no stdout) são ignoradas.
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                return Ok(value);
            }
        }
    }

    /// Faz uma chamada JSON-RPC e, enquanto espera a resposta, atende as
    /// notificações e pedidos do agente (streaming, permissões, fs/terminal).
    async fn call(
        &mut self,
        method: &str,
        params: Value,
        ctx: &mut CallCtx<'_>,
    ) -> Result<Value, CallError> {
        // O receptor das respostas de fs/terminal sai do `self` durante a
        // chamada (o `select!` não aceita dois empréstimos mutáveis de `self`).
        let mut out_rx = match self.out_rx.take() {
            Some(rx) => rx,
            None => return Err(CallError::Fatal("chamada ACP reentrante".into())),
        };
        let result = self.call_inner(method, params, ctx, &mut out_rx).await;
        self.out_rx = Some(out_rx);
        result
    }

    async fn call_inner(
        &mut self,
        method: &str,
        params: Value,
        ctx: &mut CallCtx<'_>,
        out_rx: &mut mpsc::UnboundedReceiver<Value>,
    ) -> Result<Value, CallError> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
            .map_err(CallError::Fatal)?;

        let cancel = ctx.job.map(|job| Arc::clone(&job.cancel));
        let cancellable = ctx.cancellable;
        let cancelled = async {
            match (&cancel, cancellable) {
                (Some(cancel), true) => cancel.notified().await,
                _ => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(cancelled);

        loop {
            let message = tokio::select! {
                _ = &mut cancelled, if !ctx.cancel_sent => {
                    ctx.cancel_sent = true;
                    ctx.emit(AcpEvent::Status { message: "Interrompendo o agente…".into() });
                    self.cancel_pending(ctx).await.map_err(CallError::Fatal)?;
                    if let Some(session_id) = ctx.session_id.clone() {
                        self.send(json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": { "sessionId": session_id }
                        }))
                        .await
                        .map_err(CallError::Fatal)?;
                    }
                    continue;
                }
                Some(reply) = ctx.replies_rx.recv() => {
                    self.answer_permission(ctx, reply).await.map_err(CallError::Fatal)?;
                    continue;
                }
                Some(response) = out_rx.recv() => {
                    self.send(response).await.map_err(CallError::Fatal)?;
                    continue;
                }
                message = self.next_message() => message.map_err(CallError::Fatal)?,
            };

            let has_method = message.get("method").and_then(Value::as_str);
            match (message.get("id"), has_method) {
                (Some(response_id), None) => {
                    if response_id.as_u64() == Some(id) {
                        if let Some(error) = message.get("error") {
                            return Err(CallError::Rpc(error.clone()));
                        }
                        return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                (Some(request_id), Some(method)) => {
                    let request_id = request_id.clone();
                    if method == "session/request_permission" {
                        self.handle_permission(ctx, request_id, &message["params"])
                            .await
                            .map_err(CallError::Fatal)?;
                    } else if ClientServices::handles(method) {
                        // fs/* e terminal/*: atendidos numa tarefa (ex.:
                        // wait_for_exit não pode travar o streaming).
                        let services = self.services.clone();
                        let out = self.out_tx.clone();
                        let method = method.to_owned();
                        let params = message.get("params").cloned().unwrap_or(Value::Null);
                        tokio::spawn(async move {
                            let reply = match services.handle(&method, &params).await {
                                Ok(result) => json!({ "jsonrpc": "2.0", "id": request_id, "result": result }),
                                Err(e) => json!({ "jsonrpc": "2.0", "id": request_id, "error": { "code": e.code, "message": e.message } }),
                            };
                            let _ = out.send(reply);
                        });
                    } else {
                        // Método que o cliente não oferece: "não suportado".
                        self.send(json!({
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "error": { "code": -32601, "message": format!("Método não suportado pelo Fluent Coder: {method}") }
                        }))
                        .await
                        .map_err(CallError::Fatal)?;
                    }
                }
                (None, Some("session/update")) => {
                    let params = &message["params"];
                    let same_session = ctx.session_id.as_deref().is_some_and(|session| {
                        params.get("sessionId").and_then(Value::as_str) == Some(session)
                    });
                    if same_session && ctx.emit_updates {
                        for event in map_session_update(&params["update"]) {
                            ctx.got_output = true;
                            ctx.emit(event);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    async fn handle_permission(
        &mut self,
        ctx: &mut CallCtx<'_>,
        rpc_id: Value,
        params: &Value,
    ) -> Result<(), String> {
        let options: Vec<(String, String, String)> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let id = option.get("optionId").and_then(Value::as_str)?;
                        let name = option.get("name").and_then(Value::as_str).unwrap_or(id);
                        let kind = option.get("kind").and_then(Value::as_str).unwrap_or("allow_once");
                        Some((id.to_owned(), name.to_owned(), kind.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
        let tool_kind = tool_call
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("other")
            .to_owned();

        let Some(job) = ctx.job.filter(|_| !ctx.cancel_sent) else {
            return self.reply_permission(rpc_id, None).await;
        };
        let pick = |kinds: &[&str]| {
            kinds.iter().find_map(|kind| {
                options
                    .iter()
                    .find(|(_, _, option_kind)| option_kind == kind)
                    .map(|(id, _, _)| id.clone())
            })
        };
        let automatic = match permission_policy(job.mode, &tool_kind) {
            PermissionPolicy::Allow => pick(&["allow_once", "allow_always"]),
            PermissionPolicy::Reject => pick(&["reject_once", "reject_always"]),
            PermissionPolicy::AskUser => None,
        };
        if let Some(option_id) = automatic {
            return self.reply_permission(rpc_id, Some(&option_id)).await;
        }

        let request_id = new_request_id(ctx.provider_id);
        let call = map_tool_call(&tool_call).unwrap_or_default();
        job.approvals.register(&request_id, ctx.replies_tx.clone());
        ctx.pending.insert(request_id.clone(), rpc_id);
        ctx.emit(AcpEvent::Approval {
            request_id,
            title: call.title.clone().unwrap_or_else(|| "Permitir esta ação?".into()),
            detail: call.detail.clone(),
            tool_kind,
            options: options
                .into_iter()
                .map(|(id, name, kind)| ApprovalOption {
                    label: match kind.as_str() {
                        "allow_once" | "allow_always" | "reject_once" | "reject_always" => {
                            approval_label(&kind).to_owned()
                        }
                        _ => name,
                    },
                    id,
                    kind,
                })
                .collect(),
            diffs: call.diffs,
        });
        Ok(())
    }

    async fn answer_permission(
        &mut self,
        ctx: &mut CallCtx<'_>,
        reply: ApprovalReply,
    ) -> Result<(), String> {
        let Some(rpc_id) = ctx.pending.remove(&reply.request_id) else {
            return Ok(());
        };
        ctx.emit(AcpEvent::ApprovalResolved {
            request_id: reply.request_id,
        });
        self.reply_permission(rpc_id, Some(&reply.option_id)).await
    }

    async fn reply_permission(&mut self, rpc_id: Value, option_id: Option<&str>) -> Result<(), String> {
        let outcome = match option_id {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        self.send(json!({ "jsonrpc": "2.0", "id": rpc_id, "result": { "outcome": outcome } }))
            .await
    }

    /// No cancelamento, todo pedido pendente recebe `cancelled` (exigência do
    /// protocolo) e o cartão some da UI.
    async fn cancel_pending(&mut self, ctx: &mut CallCtx<'_>) -> Result<(), String> {
        let pending: Vec<(String, Value)> = ctx.pending.drain().collect();
        for (request_id, rpc_id) in pending {
            if let Some(job) = ctx.job {
                job.approvals.forget(&request_id);
            }
            ctx.emit(AcpEvent::ApprovalResolved { request_id });
            self.reply_permission(rpc_id, None).await?;
        }
        Ok(())
    }
}

/// Servidores MCP passados ao agente: o "cérebro" do editor (grafo de
/// conhecimento), igual ao injetado no Claude e no Codex.
fn mcp_servers(root: &Path) -> Value {
    match knowledge_mcp_server(root) {
        Some((command, args)) => json!([{
            "name": "fluent-knowledge",
            "command": command,
            "args": args,
            "env": []
        }]),
        None => json!([]),
    }
}

pub(crate) async fn run_worker(
    desc: ProviderDescriptor,
    root: PathBuf,
    mut jobs: mpsc::UnboundedReceiver<PromptJob>,
) -> Result<(), String> {
    let mut connection: Option<AcpConnection> = None;
    while let Some(job) = jobs.recv().await {
        if connection.as_mut().is_some_and(|conn| !conn.is_alive()) {
            connection = None;
        }
        let result = async {
            if connection.is_none() {
                connection = Some(AcpConnection::launch(&desc, &root).await?);
            }
            let conn = connection.as_mut().expect("conexão ACP recém-criada");
            run_job(conn, &desc, &root, &job).await
        }
        .await;

        if let Err(message) = &result {
            let _ = job.on_event.send(AcpEvent::Error {
                message: message.clone(),
            });
            if connection.as_mut().is_some_and(|conn| !conn.is_alive()) {
                connection = None;
            }
        }
        let _ = job.done.send(result);
    }
    Ok(())
}

async fn open_session(
    conn: &mut AcpConnection,
    desc: &ProviderDescriptor,
    root: &Path,
    job: &PromptJob,
) -> Result<(SessionState, bool), String> {
    if let Some(saved) = job
        .native_session_id
        .as_deref()
        .filter(|_| conn.load_session)
    {
        // Retomada nativa: o agente reenvia o histórico como session/update,
        // que ignoramos (a UI já mostra a conversa).
        let mut ctx = CallCtx::new(Some(job), &desc.id);
        ctx.session_id = Some(saved.to_owned());
        ctx.emit_updates = false;
        match conn
            .call(
                "session/load",
                json!({ "sessionId": saved, "cwd": root, "mcpServers": mcp_servers(root) }),
                &mut ctx,
            )
            .await
        {
            Ok(result) => {
                let mut state = SessionState {
                    session_id: saved.to_owned(),
                    ..Default::default()
                };
                read_session_capabilities(&mut state, &result);
                let _ = job.on_event.send(AcpEvent::Status {
                    message: format!("Conversa retomada no {}.", desc.label),
                });
                return Ok((state, false));
            }
            Err(CallError::Fatal(message)) => return Err(message),
            Err(CallError::Rpc(error)) => {
                eprintln!("[acp:{}] session/load falhou: {}", desc.id, rpc_error_message(&error));
            }
        }
    }

    let mut ctx = CallCtx::new(Some(job), &desc.id);
    let result = conn
        .call(
            "session/new",
            json!({ "cwd": root, "mcpServers": mcp_servers(root) }),
            &mut ctx,
        )
        .await
        .map_err(|error| match &error {
            CallError::Rpc(rpc) if is_auth_error(rpc) => format!(
                "O {} precisa de login. Rode `{}` no terminal para autenticar e envie de novo.",
                desc.label, desc.binary
            ),
            _ => error.message(&format!("criar uma conversa no {}", desc.label)),
        })?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("O {} não retornou o identificador da sessão.", desc.label))?
        .to_owned();
    let mut state = SessionState {
        session_id,
        ..Default::default()
    };
    read_session_capabilities(&mut state, &result);
    Ok((state, true))
}

async fn apply_session_settings(
    conn: &mut AcpConnection,
    desc: &ProviderDescriptor,
    state: &mut SessionState,
    job: &PromptJob,
) -> Result<(), String> {
    if state.applied_mode != Some(job.mode) {
        if let Some(native) = pick_native_mode(job.mode, &state.modes) {
            let mut ctx = CallCtx::new(Some(job), &desc.id);
            let call = match &state.mode_config_id {
                Some(config_id) => conn
                    .call(
                        "session/set_config_option",
                        json!({ "sessionId": state.session_id, "configId": config_id, "value": native }),
                        &mut ctx,
                    )
                    .await,
                None => conn
                    .call(
                        "session/set_mode",
                        json!({ "sessionId": state.session_id, "modeId": native }),
                        &mut ctx,
                    )
                    .await,
            };
            match call {
                Ok(_) => {}
                Err(CallError::Fatal(message)) => return Err(message),
                Err(CallError::Rpc(error)) => eprintln!(
                    "[acp:{}] não aplicou o modo {native}: {}",
                    desc.id,
                    rpc_error_message(&error)
                ),
            }
        }
        state.applied_mode = Some(job.mode);
    }

    let wanted = job.model.trim();
    if !wanted.is_empty()
        && state.applied_model.as_deref() != Some(wanted)
        && state.current_model.as_deref() != Some(wanted)
        && state.models.iter().any(|model| model.id == wanted)
    {
        let mut ctx = CallCtx::new(Some(job), &desc.id);
        let call = match &state.model_config_id {
            Some(config_id) => conn
                .call(
                    "session/set_config_option",
                    json!({ "sessionId": state.session_id, "configId": config_id, "value": wanted }),
                    &mut ctx,
                )
                .await,
            None => conn
                .call(
                    "session/set_model",
                    json!({ "sessionId": state.session_id, "modelId": wanted }),
                    &mut ctx,
                )
                .await,
        };
        match call {
            Ok(_) => state.applied_model = Some(wanted.to_owned()),
            Err(CallError::Fatal(message)) => return Err(message),
            Err(CallError::Rpc(error)) => eprintln!(
                "[acp:{}] não aplicou o modelo {wanted}: {}",
                desc.id,
                rpc_error_message(&error)
            ),
        }
    }
    Ok(())
}

async fn run_job(
    conn: &mut AcpConnection,
    desc: &ProviderDescriptor,
    root: &Path,
    job: &PromptJob,
) -> Result<(), String> {
    let (mut state, is_new) = match conn.sessions.remove(&job.conversation_id) {
        Some(state) => (state, false),
        None => open_session(conn, desc, root, job).await?,
    };
    let _ = job.on_event.send(AcpEvent::Session {
        session_id: state.session_id.clone(),
    });
    if !state.models.is_empty() {
        let _ = job.on_event.send(AcpEvent::Models {
            models: state.models.clone(),
            current: state.current_model.clone(),
        });
    }
    let outcome = async {
        apply_session_settings(conn, desc, &mut state, job).await?;
        let _ = job.on_event.send(AcpEvent::Status {
            message: format!("{} pensando…", desc.label),
        });
        let prompt = prompt_for_session(is_new, &job.context_prompt, &job.prompt);
        let mut ctx = CallCtx::new(Some(job), &desc.id);
        ctx.session_id = Some(state.session_id.clone());
        ctx.emit_updates = true;
        ctx.cancellable = true;
        let result = conn
            .call(
                "session/prompt",
                json!({
                    "sessionId": state.session_id,
                    "prompt": [{ "type": "text", "text": prompt }]
                }),
                &mut ctx,
            )
            .await;
        // Pedidos que ficaram pendentes (o agente encerrou o turno sem esperar
        // a resposta) saem da UI.
        for request_id in ctx.pending.keys() {
            job.approvals.forget(request_id);
            let _ = job.on_event.send(AcpEvent::ApprovalResolved {
                request_id: request_id.clone(),
            });
        }
        let result =
            result.map_err(|error| error.message(&format!("concluir a resposta do {}", desc.label)))?;
        let stop_reason = result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn");
        let stop_reason = if ctx.cancel_sent || stop_reason == "cancelled" {
            "Cancelled"
        } else {
            stop_reason
        };
        if stop_reason == "refusal" && !ctx.got_output {
            return Err(format!("O {} recusou o pedido.", desc.label));
        }
        let _ = job.on_event.send(AcpEvent::Done {
            stop_reason: stop_reason.to_owned(),
        });
        Ok(())
    }
    .await;
    // A sessão continua viva neste processo mesmo após erro de turno.
    conn.sessions.insert(job.conversation_id.clone(), state);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::registry::fixture_descriptor;
    use crate::agents::{ApprovalBroker, EventSink, RunOptions};
    use tokio::sync::{oneshot, Notify};

    fn modes(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(id, name)| ((*id).to_owned(), (*name).to_owned()))
            .collect()
    }

    #[test]
    fn maps_fluent_modes_to_native_modes() {
        let claude_like = modes(&[
            ("default", "Always Ask"),
            ("acceptEdits", "Accept Edits"),
            ("plan", "Plan Mode"),
            ("bypassPermissions", "Bypass Permissions"),
        ]);
        assert_eq!(pick_native_mode(AgentMode::Plan, &claude_like).as_deref(), Some("plan"));
        assert_eq!(pick_native_mode(AgentMode::Edit, &claude_like).as_deref(), Some("acceptEdits"));
        assert_eq!(pick_native_mode(AgentMode::Auto, &claude_like).as_deref(), Some("default"));
        assert_eq!(
            pick_native_mode(AgentMode::Bypass, &claude_like).as_deref(),
            Some("bypassPermissions")
        );
        assert_eq!(pick_native_mode(AgentMode::Ask, &claude_like), None);

        let gemini_like = modes(&[("default", "Default"), ("auto_edit", "Auto Edit"), ("yolo", "YOLO")]);
        assert_eq!(pick_native_mode(AgentMode::Edit, &gemini_like).as_deref(), Some("auto_edit"));
        assert_eq!(pick_native_mode(AgentMode::Bypass, &gemini_like).as_deref(), Some("yolo"));
    }

    #[test]
    fn permission_policy_follows_the_mode() {
        assert_eq!(permission_policy(AgentMode::Bypass, "execute"), PermissionPolicy::Allow);
        assert_eq!(permission_policy(AgentMode::Ask, "edit"), PermissionPolicy::Reject);
        assert_eq!(permission_policy(AgentMode::Plan, "execute"), PermissionPolicy::Reject);
        assert_eq!(permission_policy(AgentMode::Ask, "fetch"), PermissionPolicy::AskUser);
        assert_eq!(permission_policy(AgentMode::Edit, "edit"), PermissionPolicy::Allow);
        assert_eq!(permission_policy(AgentMode::Edit, "execute"), PermissionPolicy::Reject);
        assert_eq!(permission_policy(AgentMode::Auto, "edit"), PermissionPolicy::AskUser);
    }

    #[test]
    fn maps_message_and_thought_chunks() {
        assert_eq!(
            map_session_update(&json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "Olá" }
            })),
            vec![AcpEvent::Text { content: "Olá".into() }]
        );
        assert_eq!(
            map_session_update(&json!({
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "hmm" }
            })),
            vec![AcpEvent::Thought { content: "hmm".into() }]
        );
        assert!(map_session_update(&json!({ "sessionUpdate": "available_commands_update" })).is_empty());
    }

    #[test]
    fn maps_tool_calls_with_diffs_and_locations() {
        let events = map_session_update(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "title": "Editar main.rs",
            "kind": "edit",
            "status": "pending",
            "locations": [{ "path": "/w/main.rs", "line": 3 }],
            "rawInput": { "command": ["cargo", "test"] },
            "content": [
                { "type": "diff", "path": "/w/main.rs", "oldText": "a", "newText": "b" },
                { "type": "content", "content": { "type": "text", "text": "ok" } }
            ]
        }));
        let AcpEvent::ToolCall { call } = &events[0] else { panic!("esperava toolCall") };
        assert_eq!(call.id, "call_1");
        assert_eq!(call.kind.as_deref(), Some("edit"));
        assert_eq!(call.locations, vec!["/w/main.rs:3".to_string()]);
        assert_eq!(call.detail.as_deref(), Some("cargo test"));
        assert_eq!(call.diffs[0].old_text.as_deref(), Some("a"));
        assert_eq!(call.output.as_deref(), Some("ok"));
    }

    #[test]
    fn maps_plan_and_usage() {
        let plan = map_session_update(&json!({
            "sessionUpdate": "plan",
            "entries": [
                { "content": "Ler", "status": "completed", "priority": "high" },
                { "content": "Editar", "status": "pending", "priority": "high" }
            ]
        }));
        let AcpEvent::ToolCall { call } = &plan[0] else { panic!() };
        assert_eq!(call.kind.as_deref(), Some("plan"));
        assert_eq!(call.status.as_deref(), Some("in_progress"));
        assert!(call.detail.as_deref().unwrap().contains("[x] Ler"));

        let usage = map_session_update(&json!({
            "sessionUpdate": "usage_update", "used": 1200, "size": 200000, "cost": { "amount": 0.01, "currency": "USD" }
        }));
        assert_eq!(
            usage,
            vec![AcpEvent::Usage {
                usage: UsageInfo {
                    context_used: Some(1200),
                    context_window: Some(200000),
                    cost_usd: Some(0.01),
                    ..Default::default()
                }
            }]
        );
    }

    #[test]
    fn reads_config_options_before_legacy_modes() {
        let mut state = SessionState::default();
        read_session_capabilities(
            &mut state,
            &json!({
                "sessionId": "s",
                "modes": { "currentModeId": "x", "availableModes": [{ "id": "legacy", "name": "Legacy" }] },
                "configOptions": [
                    { "id": "mode", "category": "mode", "type": "select", "currentValue": "default",
                      "options": [{ "value": "default", "name": "Default" }, { "value": "plan", "name": "Plan" }] },
                    { "id": "model", "category": "model", "type": "select", "currentValue": "m1",
                      "options": [{ "value": "m1", "name": "Modelo 1" }] }
                ]
            }),
        );
        assert_eq!(state.mode_config_id.as_deref(), Some("mode"));
        assert_eq!(state.modes.len(), 2);
        assert_eq!(state.models[0].label, "Modelo 1");
        assert_eq!(state.current_model.as_deref(), Some("m1"));
    }

    // ---- Ponta a ponta contra o agente falso (tools/acp-fixture) ----

    fn fixture() -> Option<ProviderDescriptor> {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("acp-fixture")
            .join("fake-agent.mjs");
        if which::which("node").is_err() || !script.is_file() {
            eprintln!("node ou fixture ausente — teste ACP ponta a ponta ignorado");
            return None;
        }
        Some(fixture_descriptor(script))
    }

    struct Turn {
        events: Arc<Mutex<Vec<AcpEvent>>>,
        done: oneshot::Receiver<Result<(), String>>,
    }

    fn send_job(
        jobs: &mpsc::UnboundedSender<PromptJob>,
        conversation: &str,
        prompt: &str,
        mode: AgentMode,
        native_session_id: Option<String>,
        cancel: &Arc<Notify>,
        broker: &Arc<ApprovalBroker>,
        auto_reply: Option<&'static str>,
    ) -> Turn {
        let events: Arc<Mutex<Vec<AcpEvent>>> = Arc::default();
        let sink_events = Arc::clone(&events);
        let reply_broker = Arc::clone(broker);
        let sink = EventSink::from_fn(move |event| {
            if let (AcpEvent::Approval { request_id, .. }, Some(option)) = (&event, auto_reply) {
                let broker = Arc::clone(&reply_broker);
                let request_id = request_id.clone();
                // Responde fora do callback, como o frontend faria.
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    broker.resolve(&request_id, option).unwrap();
                });
            }
            sink_events.lock().unwrap().push(event);
        });
        let (done_tx, done) = oneshot::channel();
        jobs.send(PromptJob {
            conversation_id: conversation.into(),
            context_prompt: format!("CONTEXTO\n{prompt}"),
            prompt: prompt.into(),
            mode,
            model: String::new(),
            native_session_id,
            options: RunOptions::default(),
            on_event: sink,
            cancel: Arc::clone(cancel),
            approvals: Arc::clone(broker),
            done: done_tx,
        })
        .unwrap();
        Turn { events, done }
    }

    fn text_of(events: &[AcpEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                AcpEvent::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect()
    }

    fn session_of(events: &[AcpEvent]) -> Option<String> {
        events.iter().find_map(|event| match event {
            AcpEvent::Session { session_id } => Some(session_id.clone()),
            _ => None,
        })
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fake_agent_end_to_end() {
        let Some(desc) = fixture() else { return };
        let root = std::env::temp_dir().join(format!("fluent-acp-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let (jobs_tx, jobs_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run_worker(desc, root.clone(), jobs_rx));
        let cancel = Arc::new(Notify::new());
        let broker = Arc::new(ApprovalBroker::default());

        // 1) Turno simples: sessão nova recebe o contexto completo, com
        //    streaming de raciocínio, ferramenta e texto.
        let turn = send_job(&jobs_tx, "c1", "olá", AgentMode::Auto, None, &cancel, &broker, None);
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        let session = session_of(&events).expect("session id");
        assert!(text_of(&events).contains("Recebido: CONTEXTO\nolá"), "{events:?}");
        assert!(events.iter().any(|event| matches!(event, AcpEvent::Thought { .. })));
        assert!(events.iter().any(|event| matches!(event, AcpEvent::ToolCall { call } if call.kind.as_deref() == Some("read"))));
        assert!(events.iter().any(|event| matches!(event, AcpEvent::Usage { .. })));
        assert!(events.iter().any(|event| matches!(event, AcpEvent::Done { stop_reason } if stop_reason == "end_turn")));
        // O servidor MCP de conhecimento foi entregue ao agente.
        assert!(text_of(&events).contains("mcp=fluent-knowledge"), "{events:?}");

        // 2) Mesma conversa: só a nova mensagem (sessão viva no processo).
        let turn = send_job(&jobs_tx, "c1", "de novo", AgentMode::Auto, Some(session.clone()), &cancel, &broker, None);
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        assert!(text_of(&events).contains("Recebido: de novo"));
        assert!(!text_of(&events).contains("CONTEXTO"));

        // 3) Pedido de permissão no modo Agente → cartão; o usuário permite.
        let turn = send_job(&jobs_tx, "c1", "editar arquivo", AgentMode::Auto, Some(session.clone()), &cancel, &broker, Some("allow"));
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        let approval = events.iter().find_map(|event| match event {
            AcpEvent::Approval { options, diffs, .. } => Some((options.clone(), diffs.clone())),
            _ => None,
        });
        let (options, diffs) = approval.expect("cartão de aprovação");
        assert_eq!(options[0].label, "Permitir uma vez");
        assert_eq!(diffs[0].new_text.as_deref(), Some("novo"));
        assert!(text_of(&events).contains("permissão: allow"), "{events:?}");
        assert!(broker.pending_ids().is_empty());

        // 4) Modo Perguntar: a edição é negada automaticamente, sem cartão.
        let turn = send_job(&jobs_tx, "c1", "editar arquivo", AgentMode::Ask, Some(session.clone()), &cancel, &broker, None);
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        assert!(!events.iter().any(|event| matches!(event, AcpEvent::Approval { .. })));
        assert!(text_of(&events).contains("permissão: reject"), "{events:?}");
        assert!(text_of(&events).contains("modo=read-only"), "{events:?}");

        // 5) Cancelamento: o pedido pendente recebe `cancelled` e o turno
        //    termina como Cancelled.
        let turn = send_job(&jobs_tx, "c1", "editar arquivo", AgentMode::Auto, Some(session.clone()), &cancel, &broker, None);
        for _ in 0..200 {
            if turn.events.lock().unwrap().iter().any(|event| matches!(event, AcpEvent::Approval { .. })) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cancel.notify_one();
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        assert!(events.iter().any(|event| matches!(event, AcpEvent::ApprovalResolved { .. })));
        assert!(events.iter().any(|event| matches!(event, AcpEvent::Done { stop_reason } if stop_reason == "Cancelled")));

        // 6) Outra conversa retoma uma sessão salva via session/load (sem
        //    reenviar o contexto e sem vazar o replay para a UI).
        let turn = send_job(&jobs_tx, "c2", "retomar", AgentMode::Auto, Some(session.clone()), &cancel, &broker, None);
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        assert_eq!(session_of(&events).as_deref(), Some(session.as_str()));
        assert!(!text_of(&events).contains("HISTÓRICO"), "replay vazou: {events:?}");
        assert!(text_of(&events).contains("Recebido: retomar"));

        // 7) Capacidades de cliente: o agente escreve/lê pelo fs/* (escrita fora
        //    do workspace recusada) e roda um comando pelo terminal/* (PTY real,
        //    código de saída e saída capturada).
        let turn = send_job(&jobs_tx, "c1", "testar cliente", AgentMode::Auto, Some(session.clone()), &cancel, &broker, None);
        turn.done.await.unwrap().unwrap();
        let events = turn.events.lock().unwrap().clone();
        let text = text_of(&events);
        assert!(text.contains(r#"cliente: fs=ok:"linha 2\n":fora=recusado"#), "{text}");
        assert!(text.contains(r#"terminal=exit:5:"do terminal ok""#), "{text}");

        drop(jobs_tx);
        worker.await.unwrap().unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
