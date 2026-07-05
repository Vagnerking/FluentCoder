//! Codex pelo `codex app-server` oficial (JSON-RPC por stdio) — o mesmo
//! protocolo da extensão IDE do Codex. As threads são persistidas pelo próprio
//! CLI (rollouts em `~/.codex/sessions`), então uma conversa é retomada com
//! `thread/resume` em vez de reenviar o histórico — e o histórico sobrevive a
//! reinícios do app.

use super::{prompt_for_session, AcpEvent, AgentMode, PromptJob};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Notify};

pub(crate) struct CodexAppServer {
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
    async fn resume_thread(
        &mut self,
        thread_id: &str,
        mode: AgentMode,
    ) -> Result<(), String> {
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
        mode: AgentMode,
        model: &str,
        prompt: String,
        on_event: &tauri::ipc::Channel<AcpEvent>,
        cancel: &Notify,
    ) -> Result<String, String> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        let mut params = json!({
            "threadId": thread_id,
            "cwd": root,
            "approvalPolicy": codex_approval_policy(mode),
            "sandboxPolicy": codex_sandbox_policy(mode, root),
            "input": [{
                "type": "text",
                "text": prompt
            }]
        });
        if !model.trim().is_empty() {
            params["model"] = json!(model);
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
        let cancelled = cancel.notified();
        tokio::pin!(cancelled);

        loop {
            let message = tokio::select! {
                _ = &mut cancelled, if !cancel_requested => {
                    cancel_requested = true;
                    let _ = on_event.send(AcpEvent::Status {
                        message: "Interrompendo o Codex…".into(),
                    });
                    if let Some(active_turn_id) = turn_id.as_deref() {
                        interrupt_request_id =
                            Some(self.interrupt_turn(thread_id, active_turn_id).await?);
                    }
                    continue;
                }
                message = self.next_message() => message?,
            };

            if message.get("id").and_then(Value::as_u64) == Some(id) {
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
            }) {
                ensure_rpc_success(&message, "interromper a resposta do Codex")?;
            } else if let Some(method) = message.get("method").and_then(Value::as_str) {
                match method {
                    // Resumo do raciocínio em streaming (e o raciocínio bruto,
                    // quando a conta o expõe) — o frontend mostra o texto ao
                    // vivo enquanto o modelo pensa, em vez de tela parada.
                    "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                        if message.pointer("/params/threadId").and_then(Value::as_str)
                            == Some(thread_id)
                        {
                            if let Some(delta) =
                                message.pointer("/params/delta").and_then(Value::as_str)
                            {
                                let _ = on_event.send(AcpEvent::Thought {
                                    content: delta.to_owned(),
                                });
                            }
                        }
                    }
                    // Nova seção do resumo: vira quebra de parágrafo no texto
                    // pensado (a primeira seção não precisa de separador).
                    "item/reasoning/summaryPartAdded" => {
                        if message.pointer("/params/threadId").and_then(Value::as_str)
                            == Some(thread_id)
                            && message
                                .pointer("/params/summaryIndex")
                                .and_then(Value::as_u64)
                                .is_some_and(|index| index > 0)
                        {
                            let _ = on_event.send(AcpEvent::Thought {
                                content: "\n\n".into(),
                            });
                        }
                    }
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
                            completion = Some(if cancel_requested {
                                Ok("Cancelled".into())
                            } else {
                                codex_turn_result(&message)
                            });
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

/// Sandbox nativo por modo (variantes validadas no app-server 0.136.0:
/// read-only, workspace-write, danger-full-access).
fn codex_sandbox_mode(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Ask | AgentMode::Plan => "read-only",
        AgentMode::Edit | AgentMode::Auto => "workspace-write",
        AgentMode::Bypass => "danger-full-access",
    }
}

/// approvalPolicy por modo (variantes validadas: untrusted, on-failure,
/// on-request, granular, never). No Auto usamos `on-request`: o Codex pede
/// escalações fora do sandbox e este cliente headless as nega automaticamente
/// (`reject_server_request`) — igual ao Auto do Claude sem aprovador.
fn codex_approval_policy(mode: AgentMode) -> &'static str {
    match mode {
        AgentMode::Auto => "on-request",
        _ => "never",
    }
}

fn codex_sandbox_policy(mode: AgentMode, root: &Path) -> Value {
    match mode {
        AgentMode::Ask | AgentMode::Plan => json!({
            "type": "readOnly",
            "networkAccess": false
        }),
        AgentMode::Edit | AgentMode::Auto => json!({
            "type": "workspaceWrite",
            "writableRoots": [root],
            "networkAccess": false,
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
                .run_turn(
                    &thread_id,
                    &root,
                    job.mode,
                    &job.model,
                    prompt.to_owned(),
                    &job.on_event,
                    &job.cancel,
                )
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
                "O Codex encerrou inesperadamente ({status})."
            ));
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

    /// Só o Auto pede escalações (`on-request` — negadas automaticamente por
    /// este cliente headless); os demais nunca pedem aprovação.
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
        let policy = codex_sandbox_policy(AgentMode::Edit, Path::new("C:\\repo"));
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["networkAccess"], false);
        assert_eq!(policy["writableRoots"][0], "C:\\repo");
    }

    #[test]
    fn bypass_sandbox_policy_grants_full_access() {
        let policy = codex_sandbox_policy(AgentMode::Bypass, Path::new("C:\\repo"));
        assert_eq!(policy["type"], "dangerFullAccess");
    }
}
