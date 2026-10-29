//! Codex pelo `codex app-server` oficial (JSON-RPC por stdio) — o mesmo
//! protocolo da extensão IDE do Codex. As threads são persistidas pelo próprio
//! CLI (rollouts em `~/.codex/sessions`), então uma conversa é retomada com
//! `thread/resume` em vez de reenviar o histórico — e o histórico sobrevive a
//! reinícios do app.
//!
//! Escalações do modo Agente (`approvalPolicy: on-request`) chegam como
//! requests do servidor (`item/commandExecution/requestApproval`,
//! `item/fileChange/requestApproval`) e viram cartões de aprovação no chat.

use super::{
    cap_text, default_approval_options, knowledge_mcp_server, new_request_id, prompt_for_session,
    AcpEvent, AgentMode, ApprovalReply, FileDiff, PromptJob, RunOptions, ToolCallEvent, UsageInfo,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

const OUTPUT_CAP: usize = 4000;

pub(crate) struct CodexAppServer {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<AsyncBufReader<ChildStdout>>,
    next_request_id: u64,
}

/// Argumentos `-c` que registram o servidor MCP de conhecimento do editor no
/// app-server (mesmo formato do `config.toml`: `mcp_servers.<nome>.*`). Os
/// valores são TOML; strings/arrays JSON são TOML válido.
fn knowledge_mcp_overrides(root: &Path) -> Vec<String> {
    let Some((command, args)) = knowledge_mcp_server(root) else {
        return Vec::new();
    };
    let command = serde_json::to_string(&command.to_string_lossy()).unwrap_or_default();
    let args = serde_json::to_string(&args).unwrap_or_default();
    vec![
        "-c".into(),
        format!("mcp_servers.fluent_knowledge.command={command}"),
        "-c".into(),
        format!("mcp_servers.fluent_knowledge.args={args}"),
    ]
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
            .args(knowledge_mcp_overrides(root))
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
                format!("O Codex encerrou inesperadamente{status}.")
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

    /// Inicia uma thread NOVA e persistente (o Codex grava o rollout em disco,
    /// o que alimenta o histórico e permite `thread/resume` depois).
    async fn start_thread(
        &mut self,
        root: &Path,
        mode: AgentMode,
        model: &str,
    ) -> Result<String, String> {
        let mut params = json!({
            "cwd": root,
            "approvalPolicy": codex_approval_policy(mode),
            "sandbox": codex_sandbox_mode(mode)
        });
        if !model.trim().is_empty() {
            params["model"] = json!(model);
        }
        let response = self.request("thread/start", params).await?;
        let result = ensure_rpc_success(&response, "criar uma conversa no Codex")?;
        result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| "O Codex não retornou o identificador da conversa.".into())
    }

    /// Retoma uma thread persistida em execuções anteriores (mesmo depois de
    /// reiniciar o app ou o app-server). O histórico volta do rollout do CLI.
    async fn resume_thread(&mut self, thread_id: &str, mode: AgentMode) -> Result<(), String> {
        let response = self
            .request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "approvalPolicy": codex_approval_policy(mode),
                    "sandbox": codex_sandbox_mode(mode)
                }),
            )
            .await?;
        ensure_rpc_success(&response, "retomar a conversa no Codex")?;
        Ok(())
    }

    async fn interrupt_turn(&mut self, thread_id: &str, turn_id: &str) -> Result<u64, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.send(json!({
            "id": id,
            "method": "turn/interrupt",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id
            }
        }))
        .await?;
        Ok(id)
    }

    async fn run_turn(
        &mut self,
        thread_id: &str,
        root: &Path,
        job: &PromptJob,
        prompt: String,
    ) -> Result<String, String> {
        let on_event = &job.on_event;
        let id = self.next_request_id;
        self.next_request_id += 1;
        let mut params = json!({
            "threadId": thread_id,
            "cwd": root,
            "approvalPolicy": codex_approval_policy(job.mode),
            "sandboxPolicy": codex_sandbox_policy(job.mode, root, &job.options),
            "input": [{
                "type": "text",
                "text": prompt
            }]
        });
        if !job.model.trim().is_empty() {
            params["model"] = json!(job.model);
        }
        self.send(json!({
            "id": id,
            "method": "turn/start",
            "params": params
        }))
        .await?;

        let mut acknowledged = false;
        let mut completion: Option<Result<String, String>> = None;
        let mut turn_id: Option<String> = None;
        let mut cancel_requested = false;
        let mut interrupt_request_id: Option<u64> = None;
        let mut announced_thinking = false;
        let cancelled = job.cancel.notified();
        tokio::pin!(cancelled);
        let (replies_tx, mut replies_rx) = mpsc::unbounded_channel::<ApprovalReply>();
        // request_id do cartão → pedido do servidor aguardando decisão.
        let mut pending: HashMap<String, PendingApproval> = HashMap::new();
        // Alterações de arquivo vistas em `item/started` (para o cartão do
        // `fileChange/requestApproval`, que não traz o diff).
        let mut file_changes: HashMap<String, Vec<FileDiff>> = HashMap::new();

        loop {
            let message = tokio::select! {
                _ = &mut cancelled, if !cancel_requested => {
                    cancel_requested = true;
                    let _ = on_event.send(AcpEvent::Status {
                        message: "Interrompendo o Codex…".into(),
                    });
                    for (request_id, approval) in pending.drain() {
                        job.approvals.forget(&request_id);
                        let _ = on_event.send(AcpEvent::ApprovalResolved { request_id });
                        self.send(approval.response("cancel")).await?;
                    }
                    if let Some(active_turn_id) = turn_id.as_deref() {
                        interrupt_request_id =
                            Some(self.interrupt_turn(thread_id, active_turn_id).await?);
                    }
                    continue;
                }
                Some(reply) = replies_rx.recv() => {
                    if let Some(approval) = pending.remove(&reply.request_id) {
                        let _ = on_event.send(AcpEvent::ApprovalResolved {
                            request_id: reply.request_id.clone(),
                        });
                        self.send(approval.response(&reply.option_id)).await?;
                    }
                    continue;
                }
                message = self.next_message() => message?,
            };

            if message.get("id").and_then(Value::as_u64) == Some(id)
                && message.get("method").is_none()
            {
                let result = ensure_rpc_success(&message, "iniciar a resposta do Codex")?;
                turn_id = result
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                acknowledged = true;
                if cancel_requested && interrupt_request_id.is_none() {
                    let active_turn_id = turn_id.as_deref().ok_or_else(|| {
                        "O Codex não retornou o turno ativo para cancelamento.".to_string()
                    })?;
                    interrupt_request_id =
                        Some(self.interrupt_turn(thread_id, active_turn_id).await?);
                }
            } else if interrupt_request_id.is_some_and(|interrupt_id| {
                message.get("id").and_then(Value::as_u64) == Some(interrupt_id)
                    && message.get("method").is_none()
            }) {
                ensure_rpc_success(&message, "interromper a resposta do Codex")?;
            } else if let Some(method) = message.get("method").and_then(Value::as_str) {
                let same_thread =
                    message.pointer("/params/threadId").and_then(Value::as_str) == Some(thread_id);
                if message.get("id").is_some() {
                    // Request do servidor: aprovação interativa ou recusa.
                    match approval_card(&message, &file_changes) {
                        Some(card) if !cancel_requested => {
                            let request_id = new_request_id("codex");
                            job.approvals.register(&request_id, replies_tx.clone());
                            let _ = on_event.send(AcpEvent::Approval {
                                request_id: request_id.clone(),
                                title: card.title,
                                detail: card.detail,
                                tool_kind: card.tool_kind,
                                options: default_approval_options(true),
                                diffs: card.diffs,
                            });
                            let _ = on_event.send(AcpEvent::Status {
                                message: "Aguardando sua aprovação…".into(),
                            });
                            pending.insert(
                                request_id,
                                PendingApproval {
                                    rpc_id: message["id"].clone(),
                                    legacy: card.legacy,
                                },
                            );
                        }
                        Some(card) => {
                            let approval = PendingApproval {
                                rpc_id: message["id"].clone(),
                                legacy: card.legacy,
                            };
                            self.send(approval.response("cancel")).await?;
                        }
                        None => self.reject_server_request(&message).await?,
                    }
                    continue;
                }
                match method {
                    // Resumo do raciocínio em streaming (e o raciocínio bruto,
                    // quando a conta o expõe) — o frontend mostra o texto ao
                    // vivo enquanto o modelo pensa, em vez de tela parada.
                    "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" if same_thread => {
                        if let Some(delta) = message.pointer("/params/delta").and_then(Value::as_str) {
                            let _ = on_event.send(AcpEvent::Thought {
                                content: delta.to_owned(),
                            });
                        }
                    }
                    // Nova seção do resumo: vira quebra de parágrafo no texto
                    // pensado (a primeira seção não precisa de separador).
                    "item/reasoning/summaryPartAdded" if same_thread => {
                        if message
                            .pointer("/params/summaryIndex")
                            .and_then(Value::as_u64)
                            .is_some_and(|index| index > 0)
                        {
                            let _ = on_event.send(AcpEvent::Thought {
                                content: "\n\n".into(),
                            });
                        }
                    }
                    "item/agentMessage/delta" if same_thread => {
                        if let Some(delta) = message.pointer("/params/delta").and_then(Value::as_str) {
                            let _ = on_event.send(AcpEvent::Text {
                                content: delta.to_owned(),
                            });
                        }
                    }
                    "turn/completed" if same_thread => {
                        completion = Some(if cancel_requested {
                            Ok("Cancelled".into())
                        } else {
                            codex_turn_result(&message)
                        });
                    }
                    "thread/tokenUsage/updated" if same_thread => {
                        if let Some(usage) = codex_usage(&message["params"]) {
                            let _ = on_event.send(AcpEvent::Usage { usage });
                        }
                    }
                    "serverRequest/resolved" => {
                        let resolved = message.pointer("/params/requestId").cloned();
                        let keys: Vec<String> = pending
                            .iter()
                            .filter(|(_, approval)| Some(&approval.rpc_id) == resolved.as_ref())
                            .map(|(key, _)| key.clone())
                            .collect();
                        for request_id in keys {
                            pending.remove(&request_id);
                            job.approvals.forget(&request_id);
                            let _ = on_event.send(AcpEvent::ApprovalResolved { request_id });
                        }
                    }
                    "error" if same_thread => {
                        if !message
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
                    "item/started" | "item/completed" if same_thread => {
                        let item = &message["params"]["item"];
                        if method == "item/started" {
                            let status = match item.get("type").and_then(Value::as_str) {
                                Some("commandExecution") => Some("Codex executando uma ferramenta…"),
                                Some("fileChange") => Some("Codex aplicando alterações…"),
                                Some("webSearch") => Some("Codex pesquisando…"),
                                Some("reasoning") if !announced_thinking => {
                                    announced_thinking = true;
                                    Some("Codex pensando…")
                                }
                                _ => None,
                            };
                            if let Some(message) = status {
                                let _ = on_event.send(AcpEvent::Status {
                                    message: message.into(),
                                });
                            }
                        }
                        if let Some(call) = codex_tool_call(item) {
                            if item.get("type").and_then(Value::as_str) == Some("fileChange") {
                                file_changes.insert(call.id.clone(), call.diffs.clone());
                            }
                            let _ = on_event.send(AcpEvent::ToolCall { call });
                        }
                    }
                    _ => {}
                }
            }

            if acknowledged {
                if let Some(result) = completion.take() {
                    for (request_id, _) in pending.drain() {
                        job.approvals.forget(&request_id);
                        let _ = on_event.send(AcpEvent::ApprovalResolved { request_id });
                    }
                    return result;
                }
            }
        }
    }
}

/// Um request de aprovação do servidor aguardando a decisão do usuário.
struct PendingApproval {
    rpc_id: Value,
    /// Requests v1 (`execCommandApproval`/`applyPatchApproval`) usam o enum
    /// `ReviewDecision` em snake_case.
    legacy: bool,
}

impl PendingApproval {
    fn response(&self, option_id: &str) -> Value {
        let decision = if self.legacy {
            match option_id {
                "allow_once" => json!("approved"),
                "allow_always" => json!("approved_for_session"),
                "cancel" => json!("abort"),
                _ => json!({ "denied": { "rejection": "O usuário negou no Fluent Chat." } }),
            }
        } else {
            match option_id {
                "allow_once" => json!("accept"),
                "allow_always" => json!("acceptForSession"),
                "cancel" => json!("cancel"),
                _ => json!("decline"),
            }
        };
        json!({ "id": self.rpc_id, "result": { "decision": decision } })
    }
}

/// Conteúdo do cartão de um request de aprovação do servidor.
#[derive(Debug, PartialEq)]
struct ApprovalCard {
    title: String,
    detail: Option<String>,
    tool_kind: String,
    diffs: Vec<FileDiff>,
    legacy: bool,
}

/// Interpreta um request de aprovação do app-server; `None` para requests que
/// não são aprovações (esses continuam sendo recusados).
fn approval_card(message: &Value, file_changes: &HashMap<String, Vec<FileDiff>>) -> Option<ApprovalCard> {
    let params = &message["params"];
    let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_owned);
    let with_reason = |base: Option<String>| -> Option<String> {
        match (base, text("reason")) {
            (Some(base), Some(reason)) => Some(format!("{base}\n\nMotivo: {reason}")),
            (Some(base), None) => Some(base),
            (None, reason) => reason,
        }
    };
    match message.get("method").and_then(Value::as_str)? {
        "item/commandExecution/requestApproval" => {
            let command = text("command").map(|command| match text("cwd") {
                Some(cwd) => format!("{command}\n(em {cwd})"),
                None => command,
            });
            Some(ApprovalCard {
                title: "Executar comando?".into(),
                detail: with_reason(command),
                tool_kind: "execute".into(),
                diffs: vec![],
                legacy: false,
            })
        }
        "item/fileChange/requestApproval" => {
            let item_id = text("itemId").unwrap_or_default();
            let diffs = file_changes.get(&item_id).cloned().unwrap_or_default();
            let files = diffs
                .iter()
                .map(|diff| diff.path.clone())
                .collect::<Vec<_>>()
                .join("\n");
            Some(ApprovalCard {
                title: "Aplicar alterações?".into(),
                detail: with_reason((!files.is_empty()).then_some(files)),
                tool_kind: "edit".into(),
                diffs,
                legacy: false,
            })
        }
        "execCommandApproval" => {
            let command = params
                .get("command")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                });
            Some(ApprovalCard {
                title: "Executar comando?".into(),
                detail: with_reason(command),
                tool_kind: "execute".into(),
                diffs: vec![],
                legacy: true,
            })
        }
        "applyPatchApproval" => Some(ApprovalCard {
            title: "Aplicar alterações?".into(),
            detail: with_reason(params.get("fileChanges").and_then(Value::as_object).map(
                |changes| changes.keys().cloned().collect::<Vec<_>>().join("\n"),
            )),
            tool_kind: "edit".into(),
            diffs: vec![],
            legacy: true,
        }),
        _ => None,
    }
}

/// `item/started|completed` de ferramenta → cartão no transcript.
fn codex_tool_call(item: &Value) -> Option<ToolCallEvent> {
    let id = item.get("id").and_then(Value::as_str)?.to_owned();
    let status = item.get("status").and_then(Value::as_str).map(|status| {
        match status {
            "inProgress" => "in_progress",
            "completed" => "completed",
            _ => "failed",
        }
        .to_owned()
    });
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => {
            let command = item.get("command").and_then(Value::as_str).unwrap_or("");
            let mut output = item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .map(|output| cap_text(output, OUTPUT_CAP));
            if let Some(code) = item.get("exitCode").and_then(Value::as_i64) {
                if code != 0 {
                    output = Some(format!(
                        "{}\n(código de saída {code})",
                        output.unwrap_or_default()
                    ));
                }
            }
            Some(ToolCallEvent {
                id,
                kind: Some("execute".into()),
                title: Some("Executar comando".into()),
                status,
                detail: Some(command.to_owned()),
                output,
                ..Default::default()
            })
        }
        "fileChange" => {
            let diffs: Vec<FileDiff> = item
                .get("changes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|change| {
                    Some(FileDiff {
                        path: change.get("path").and_then(Value::as_str)?.to_owned(),
                        unified: change
                            .get("diff")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        ..Default::default()
                    })
                })
                .collect();
            let title = match diffs.as_slice() {
                [single] => format!(
                    "Editar {}",
                    single.path.rsplit(['/', '\\']).next().unwrap_or(&single.path)
                ),
                many => format!("Editar {} arquivos", many.len()),
            };
            Some(ToolCallEvent {
                id,
                kind: Some("edit".into()),
                title: Some(title),
                status,
                locations: diffs.iter().map(|diff| diff.path.clone()).collect(),
                diffs,
                ..Default::default()
            })
        }
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("ferramenta");
            let output = item
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    item.pointer("/result/content")
                        .and_then(Value::as_array)
                        .map(|blocks| {
                            blocks
                                .iter()
                                .filter_map(|block| block.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                })
                .filter(|text| !text.is_empty())
                .map(|text| cap_text(&text, OUTPUT_CAP));
            Some(ToolCallEvent {
                id,
                kind: Some("other".into()),
                title: Some(format!("{server}: {tool}")),
                status,
                detail: item
                    .get("arguments")
                    .filter(|args| !args.is_null())
                    .map(|args| cap_text(&args.to_string(), 1000)),
                output,
                ..Default::default()
            })
        }
        "webSearch" => Some(ToolCallEvent {
            id,
            kind: Some("fetch".into()),
            title: Some(format!(
                "Pesquisar \"{}\"",
                item.get("query").and_then(Value::as_str).unwrap_or("")
            )),
            status: status.or(Some("completed".into())),
            ..Default::default()
        }),
        _ => None,
    }
}

/// `thread/tokenUsage/updated` → consumo do último turno + janela de contexto.
fn codex_usage(params: &Value) -> Option<UsageInfo> {
    let last = params.pointer("/tokenUsage/last")?;
    let read = |key: &str| last.get(key).and_then(Value::as_u64);
    Some(UsageInfo {
        input_tokens: read("inputTokens"),
        output_tokens: read("outputTokens"),
        cached_input_tokens: read("cachedInputTokens"),
        cost_usd: None,
        context_window: params
            .pointer("/tokenUsage/modelContextWindow")
            .and_then(Value::as_u64),
        context_used: params
            .pointer("/tokenUsage/total/totalTokens")
            .and_then(Value::as_u64),
    })
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

/// Sandbox nativo por modo (variantes validadas no app-server 0.162:
/// read-only, workspace-write, danger-full-access).
fn codex_sandbox_mode(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Ask | AgentMode::Plan => "read-only",
        AgentMode::Edit | AgentMode::Auto => "workspace-write",
        AgentMode::Bypass => "danger-full-access",
    }
}

/// approvalPolicy por modo (variantes validadas: untrusted, on-failure,
/// on-request, granular, never). No Agente usamos `on-request`: o Codex pede
/// escalações fora do sandbox e o chat as mostra como cartões de aprovação.
fn codex_approval_policy(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Auto => "on-request",
        _ => "never",
    }
}

fn codex_sandbox_policy(mode: AgentMode, root: &Path, options: &RunOptions) -> Value {
    match mode {
        AgentMode::Ask | AgentMode::Plan => json!({
            "type": "readOnly",
            "networkAccess": false
        }),
        AgentMode::Edit | AgentMode::Auto => json!({
            "type": "workspaceWrite",
            "writableRoots": [root],
            "networkAccess": options.network_access,
            "excludeSlashTmp": false,
            "excludeTmpdirEnvVar": false
        }),
        AgentMode::Bypass => json!({
            "type": "dangerFullAccess"
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

pub(crate) async fn run_worker(
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
    // Threads já ativas NESTE processo do app-server (conversa → thread id).
    let mut sessions: HashMap<String, String> = HashMap::new();

    while let Some(job) = jobs.recv().await {
        let result: Result<(), String> = async {
            let (thread_id, is_new_thread) =
                resolve_thread(&mut server, &root, &mut sessions, &job).await?;
            let _ = job.on_event.send(AcpEvent::Session {
                session_id: thread_id.clone(),
            });
            let _ = job.on_event.send(AcpEvent::Status {
                message: if is_new_thread {
                    "Codex conectado. Preparando a conversa…".into()
                } else {
                    "Sessão Codex ativa. Processando a mensagem…".into()
                },
            });

            // O contexto completo só é reenviado quando a thread é nova (a
            // retomada nativa já devolve o histórico ao modelo). A mensagem vai
            // sem scaffolding: permissões são sandbox+approval nativos.
            let prompt = prompt_for_session(is_new_thread, &job.context_prompt, &job.prompt);
            let stop_reason = server
                .run_turn(&thread_id, &root, &job, prompt.to_owned())
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
            return Err(format!("O Codex encerrou inesperadamente ({status})."));
        }
    }
    Ok(())
}

/// Encontra a thread da conversa: ativa neste processo → retomada do disco
/// (`thread/resume` com o id salvo pelo frontend) → nova thread. Retorna
/// `(thread_id, is_new_thread)`; `is_new_thread` decide o reenvio de contexto.
async fn resolve_thread(
    server: &mut CodexAppServer,
    root: &Path,
    sessions: &mut HashMap<String, String>,
    job: &PromptJob,
) -> Result<(String, bool), String> {
    if let Some(thread_id) = sessions.get(&job.conversation_id) {
        return Ok((thread_id.clone(), false));
    }

    if let Some(saved) = job.native_session_id.as_deref() {
        match server.resume_thread(saved, job.mode).await {
            Ok(()) => {
                sessions.insert(job.conversation_id.clone(), saved.to_owned());
                let _ = job.on_event.send(AcpEvent::Status {
                    message: "Conversa retomada no Codex.".into(),
                });
                return Ok((saved.to_owned(), false));
            }
            Err(error) => {
                // Rollout apagado/expirado: recomeça com uma thread nova; o
                // contexto completo do frontend reconstrói o histórico.
                eprintln!("[codex] resume falhou ({saved}): {error}");
            }
        }
    }

    let thread_id = server.start_thread(root, job.mode, &job.model).await?;
    sessions.insert(job.conversation_id.clone(), thread_id.clone());
    Ok((thread_id, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_modes_use_native_workspace_sandboxes() {
        assert_eq!(codex_sandbox_mode(AgentMode::Ask), "read-only");
        assert_eq!(codex_sandbox_mode(AgentMode::Plan), "read-only");
        assert_eq!(codex_sandbox_mode(AgentMode::Edit), "workspace-write");
        assert_eq!(codex_sandbox_mode(AgentMode::Auto), "workspace-write");
        assert_eq!(codex_sandbox_mode(AgentMode::Bypass), "danger-full-access");
    }

    /// Só o Agente pede escalações (`on-request` — viram cartões de
    /// aprovação); os demais nunca pedem aprovação.
    #[test]
    fn codex_approval_policy_matches_the_mode() {
        assert_eq!(codex_approval_policy(AgentMode::Ask), "never");
        assert_eq!(codex_approval_policy(AgentMode::Plan), "never");
        assert_eq!(codex_approval_policy(AgentMode::Edit), "never");
        assert_eq!(codex_approval_policy(AgentMode::Auto), "on-request");
        assert_eq!(codex_approval_policy(AgentMode::Bypass), "never");
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
    fn edit_sandbox_policy_limits_writes_to_the_workspace() {
        let policy = codex_sandbox_policy(AgentMode::Edit, Path::new("C:\\repo"), &RunOptions::default());
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["networkAccess"], false);
        assert_eq!(policy["writableRoots"][0], "C:\\repo");
    }

    #[test]
    fn custom_agent_can_enable_sandbox_network() {
        let options = RunOptions {
            network_access: true,
            ..Default::default()
        };
        let policy = codex_sandbox_policy(AgentMode::Auto, Path::new("/repo"), &options);
        assert_eq!(policy["networkAccess"], true);
        // Modos somente leitura nunca ganham rede.
        let read_only = codex_sandbox_policy(AgentMode::Ask, Path::new("/repo"), &options);
        assert_eq!(read_only["networkAccess"], false);
    }

    #[test]
    fn bypass_sandbox_policy_grants_full_access() {
        let policy = codex_sandbox_policy(AgentMode::Bypass, Path::new("C:\\repo"), &RunOptions::default());
        assert_eq!(policy["type"], "dangerFullAccess");
    }

    #[test]
    fn command_approval_becomes_a_card_and_answers_v2_decisions() {
        let message = json!({
            "id": 7,
            "method": "item/commandExecution/requestApproval",
            "params": { "threadId": "t", "turnId": "u", "itemId": "i", "command": "npm install", "cwd": "/w", "reason": "rede" }
        });
        let card = approval_card(&message, &HashMap::new()).unwrap();
        assert_eq!(card.tool_kind, "execute");
        assert!(card.detail.as_deref().unwrap().contains("npm install"));
        assert!(card.detail.as_deref().unwrap().contains("Motivo: rede"));
        let pending = PendingApproval { rpc_id: json!(7), legacy: false };
        assert_eq!(pending.response("allow_once"), json!({"id": 7, "result": {"decision": "accept"}}));
        assert_eq!(pending.response("allow_always")["result"]["decision"], "acceptForSession");
        assert_eq!(pending.response("reject_once")["result"]["decision"], "decline");
        assert_eq!(pending.response("cancel")["result"]["decision"], "cancel");
    }

    #[test]
    fn file_change_approval_reuses_the_started_item_diff() {
        let mut changes = HashMap::new();
        changes.insert(
            "item-1".to_string(),
            vec![FileDiff { path: "/w/a.rs".into(), unified: Some("@@".into()), ..Default::default() }],
        );
        let card = approval_card(
            &json!({ "id": 1, "method": "item/fileChange/requestApproval", "params": { "itemId": "item-1" } }),
            &changes,
        )
        .unwrap();
        assert_eq!(card.diffs.len(), 1);
        assert_eq!(card.detail.as_deref(), Some("/w/a.rs"));
    }

    #[test]
    fn legacy_approvals_use_review_decisions() {
        let pending = PendingApproval { rpc_id: json!("x"), legacy: true };
        assert_eq!(pending.response("allow_once")["result"]["decision"], "approved");
        assert_eq!(pending.response("allow_always")["result"]["decision"], "approved_for_session");
        assert!(pending.response("reject_once")["result"]["decision"]["denied"].is_object());
    }

    #[test]
    fn non_approval_requests_are_not_cards() {
        assert!(approval_card(
            &json!({ "id": 1, "method": "item/tool/requestUserInput", "params": {} }),
            &HashMap::new()
        )
        .is_none());
    }

    #[test]
    fn command_items_become_tool_cards() {
        let call = codex_tool_call(&json!({
            "type": "commandExecution", "id": "c1", "command": "ls", "status": "failed",
            "aggregatedOutput": "erro", "exitCode": 2
        }))
        .unwrap();
        assert_eq!(call.kind.as_deref(), Some("execute"));
        assert_eq!(call.status.as_deref(), Some("failed"));
        assert_eq!(call.detail.as_deref(), Some("ls"));
        assert!(call.output.as_deref().unwrap().contains("código de saída 2"));
    }

    #[test]
    fn file_change_items_carry_unified_diffs() {
        let call = codex_tool_call(&json!({
            "type": "fileChange", "id": "f1", "status": "completed",
            "changes": [{ "path": "/w/src/a.rs", "kind": { "type": "update", "move_path": null }, "diff": "@@ -1 +1 @@\n-a\n+b" }]
        }))
        .unwrap();
        assert_eq!(call.title.as_deref(), Some("Editar a.rs"));
        assert_eq!(call.diffs[0].unified.as_deref(), Some("@@ -1 +1 @@\n-a\n+b"));
        assert!(codex_tool_call(&json!({ "type": "agentMessage", "id": "m" })).is_none());
    }

    #[test]
    fn token_usage_reports_the_last_turn() {
        let usage = codex_usage(&json!({
            "threadId": "t", "turnId": "u",
            "tokenUsage": {
                "total": { "totalTokens": 5000, "inputTokens": 4000, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 1000, "reasoningOutputTokens": 0 },
                "last": { "totalTokens": 300, "inputTokens": 200, "cachedInputTokens": 50, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20 },
                "modelContextWindow": 272000
            }
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, Some(200));
        assert_eq!(usage.output_tokens, Some(100));
        assert_eq!(usage.cached_input_tokens, Some(50));
        assert_eq!(usage.context_window, Some(272000));
        assert_eq!(usage.context_used, Some(5000));
    }

    #[test]
    fn knowledge_mcp_is_registered_with_toml_values() {
        let overrides = knowledge_mcp_overrides(Path::new("/w/proj"));
        assert_eq!(overrides[0], "-c");
        assert!(overrides[1].starts_with("mcp_servers.fluent_knowledge.command=\""));
        assert_eq!(overrides[3], "mcp_servers.fluent_knowledge.args=[\"--mcp\",\"/w/proj\"]");
    }
}
