//! Claude Code pelo protocolo nativo do CLI (`--input-format stream-json` /
//! `--output-format stream-json`) — o mesmo caminho da extensão oficial do
//! VS Code. Um processo persistente por conversa recebe as mensagens pelo
//! stdin e devolve os tokens em streaming pelo stdout, sem `npx`, sem
//! adaptador ACP e sem reenvio do histórico: o CLI grava a sessão em disco e
//! `--resume <sessionId>` a retoma após reinícios do app ou troca de conversa.

use super::{prompt_for_session, AcpEvent, AgentMode, PromptJob};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

/// Um processo `claude` vivo, amarrado a uma conversa e a um modo (as
/// permissões são flags de linha de comando, então mudar de modo exige um novo
/// processo — barato, porque a sessão é retomada com `--resume`).
struct ClaudeSession {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<AsyncBufReader<ChildStdout>>,
    conversation_id: String,
    mode: AgentMode,
    /// Modelo passado ao CLI via `--model` (as flags são por-processo, então
    /// trocar de modelo derruba e recria o processo, como o modo).
    model: String,
    /// Session id nativo, capturado do evento `init`/`result` do CLI.
    session_id: Option<String>,
    /// True quando o processo nasceu com `--resume` (para o fallback de
    /// contexto quando a sessão nativa se perdeu).
    resumed: bool,
    /// True depois do primeiro turno concluído com sucesso neste processo.
    turned: bool,
    /// Últimas linhas do stderr do CLI, para diagnósticos úteis quando o
    /// processo morre cedo (ex.: "Please run /login").
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

/// Resultado de interpretar uma linha NDJSON do CLI (função pura, testável).
#[derive(Debug, PartialEq)]
enum ClaudeEvent {
    /// `system/init` ou `result` — carrega o session id nativo.
    Session(String),
    /// Delta de texto da resposta.
    Text(String),
    /// O agente começou a usar uma ferramenta.
    ToolUse(String),
    /// Delta de raciocínio (extended thinking), com o texto pensado.
    Thinking(String),
    /// Fim do turno: `Ok` no sucesso, `Err(mensagem)` quando `is_error`.
    Result(Result<(), String>),
    Ignored,
}

/// Mapeia uma linha do stdout do CLI para eventos do chat. Deltas de
/// sub-agentes/ferramentas aninhadas (`parent_tool_use_id`) são ignorados para
/// não vazar texto interno na conversa.
fn interpret_line(value: &Value) -> Vec<ClaudeEvent> {
    let mut events = Vec::new();
    match value.get("type").and_then(Value::as_str) {
        Some("system") => {
            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                    events.push(ClaudeEvent::Session(id.to_owned()));
                }
            }
        }
        Some("stream_event") => {
            if value
                .get("parent_tool_use_id")
                .is_some_and(|id| !id.is_null())
            {
                return vec![ClaudeEvent::Ignored];
            }
            let event = &value["event"];
            match event.get("type").and_then(Value::as_str) {
                Some("content_block_delta") => {
                    match event.pointer("/delta/type").and_then(Value::as_str) {
                        Some("text_delta") => {
                            if let Some(text) =
                                event.pointer("/delta/text").and_then(Value::as_str)
                            {
                                events.push(ClaudeEvent::Text(text.to_owned()));
                            }
                        }
                        Some("thinking_delta") => {
                            if let Some(thinking) =
                                event.pointer("/delta/thinking").and_then(Value::as_str)
                            {
                                events.push(ClaudeEvent::Thinking(thinking.to_owned()));
                            }
                        }
                        _ => {}
                    }
                }
                Some("content_block_start")
                    if event.pointer("/content_block/type").and_then(Value::as_str)
                        == Some("tool_use") =>
                {
                    let name = event
                        .pointer("/content_block/name")
                        .and_then(Value::as_str)
                        .unwrap_or("ferramenta");
                    events.push(ClaudeEvent::ToolUse(name.to_owned()));
                }
                _ => {}
            }
        }
        Some("result") => {
            if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                events.push(ClaudeEvent::Session(id.to_owned()));
            }
            let is_error = value.get("is_error").and_then(Value::as_bool) == Some(true);
            if is_error {
                let message = value
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|text| !text.trim().is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "O Claude encerrou com erro ({}).",
                            value
                                .get("subtype")
                                .and_then(Value::as_str)
                                .unwrap_or("desconhecido")
                        )
                    });
                events.push(ClaudeEvent::Result(Err(message)));
            } else {
                events.push(ClaudeEvent::Result(Ok(())));
            }
        }
        _ => {}
    }
    if events.is_empty() {
        events.push(ClaudeEvent::Ignored);
    }
    events
}

/// Resolve como invocar o CLI `claude`:
/// - binário nativo (`claude`/`claude.exe`) → execução direta;
/// - shim do npm no Windows (`claude.cmd`) → prefere `node cli.js` (evita o
///   `cmd.exe`, preserva argumentos e elimina um processo intermediário);
///   sem `cli.js` visível, executa o próprio shim (o std faz o quoting seguro
///   de `.cmd`/`.bat` desde o fix do BatBadBut).
fn resolve_claude_command() -> Result<(PathBuf, Vec<OsString>), String> {
    let found = which::which("claude").map_err(|error| {
        format!(
            "Claude Code CLI não encontrado. Instale e autentique o `claude` e confirme que ele está no PATH. Detalhes: {error}"
        )
    })?;

    let is_shim = found
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    if is_shim {
        if let Some(dir) = found.parent() {
            let cli = dir
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("cli.js");
            if cli.is_file() {
                if let Ok(node) = which::which("node") {
                    return Ok((node, vec![cli.into_os_string()]));
                }
            }
        }
    }
    Ok((found, Vec::new()))
}

/// Config MCP passada ao CLI para expor o "cérebro" do editor (grafo de
/// conhecimento) à sessão — o mesmo servidor `fluent-coder --mcp <root>` já
/// oferecido ao Claude Code externo. Gravada em arquivo temporário estável por
/// workspace; `None` se algo falhar (a sessão funciona sem ela).
fn knowledge_mcp_config(root: &Path) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let config = json!({
        "mcpServers": {
            "fluent-knowledge": {
                "command": exe,
                "args": ["--mcp", root]
            }
        }
    });

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    let path = std::env::temp_dir().join(format!("fluent-coder-claude-mcp-{:016x}.json", {
        hasher.finish()
    }));
    fs::write(&path, serde_json::to_vec(&config).ok()?).ok()?;
    Some(path)
}

/// Flags de permissão por modo — os permission modes NATIVOS do Claude Code
/// (validados no CLI 2.1.162: default, acceptEdits, plan, auto,
/// bypassPermissions, dontAsk):
/// - Ask: leitura pura — nega explicitamente escrita e Bash (mais limpo que o
///   `default` headless, cujos pedidos de permissão seriam negados um a um);
/// - Plan: `--permission-mode plan` nativo (explora e apresenta o plano);
/// - Edit: `acceptEdits` auto-aprova edições de arquivos; Bash continua
///   negado (headless não tem quem aprovar comandos);
/// - Auto: `--permission-mode auto` — o CLI escolhe; sem aprovador, pedidos
///   de escalação são negados automaticamente;
/// - Bypass: `bypassPermissions`, sem confirmações.
fn mode_args(mode: AgentMode) -> Vec<&'static str> {
    match mode {
        AgentMode::Ask => vec![
            "--disallowedTools",
            "Write,Edit,MultiEdit,NotebookEdit,Bash",
        ],
        AgentMode::Plan => vec!["--permission-mode", "plan"],
        AgentMode::Edit => vec![
            "--permission-mode",
            "acceptEdits",
            "--disallowedTools",
            "Bash",
        ],
        AgentMode::Auto => vec!["--permission-mode", "auto"],
        AgentMode::Bypass => vec!["--permission-mode", "bypassPermissions"],
    }
}

async fn spawn_session(
    root: &Path,
    conversation_id: &str,
    mode: AgentMode,
    model: &str,
    resume: Option<&str>,
) -> Result<ClaudeSession, String> {
    let (program, prefix) = resolve_claude_command()?;
    let mut command = Command::new(program);
    command.args(prefix);
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]);
    command.args(mode_args(mode));
    if !model.trim().is_empty() {
        command.args(["--model", model]);
    }
    if let Some(session_id) = resume {
        command.args(["--resume", session_id]);
    }
    if let Some(config) = knowledge_mcp_config(root) {
        command.arg("--mcp-config").arg(config);
    }
    command
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
        .map_err(|error| format!("Falha ao iniciar o Claude Code CLI: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "O Claude CLI não abriu o canal de entrada.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "O Claude CLI não abriu o canal de saída.".to_string())?;

    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::default();
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        tauri::async_runtime::spawn(async move {
            let mut lines = AsyncBufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[claude] {line}");
                if let Ok(mut tail) = tail.lock() {
                    if tail.len() >= 8 {
                        tail.remove(0);
                    }
                    tail.push(line);
                }
            }
        });
    }

    Ok(ClaudeSession {
        child,
        stdin,
        stdout: AsyncBufReader::new(stdout).lines(),
        conversation_id: conversation_id.to_owned(),
        mode,
        model: model.to_owned(),
        session_id: resume.map(str::to_owned),
        resumed: resume.is_some(),
        turned: false,
        stderr_tail,
    })
}

impl ClaudeSession {
    async fn send_user_message(&mut self, text: &str) -> Result<(), String> {
        let message = json!({
            "type": "user",
            "message": { "role": "user", "content": text }
        });
        let mut encoded = serde_json::to_vec(&message)
            .map_err(|error| format!("Falha ao serializar a mensagem para o Claude: {error}"))?;
        encoded.push(b'\n');
        self.stdin
            .write_all(&encoded)
            .await
            .map_err(|error| format!("Falha ao enviar a mensagem ao Claude: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Falha ao liberar a mensagem para o Claude: {error}"))
    }

    fn death_error(&mut self) -> String {
        let status = self
            .child
            .try_wait()
            .ok()
            .flatten()
            .map(|status| format!(" ({status})"))
            .unwrap_or_default();
        let tail = self
            .stderr_tail
            .lock()
            .map(|lines| lines.join(" | "))
            .unwrap_or_default();
        if tail.trim().is_empty() {
            format!("O Claude encerrou inesperadamente{status}.")
        } else {
            format!("O Claude encerrou inesperadamente{status}: {tail}")
        }
    }
}

/// Como um turno terminou (sem contar erros).
enum TurnEnd {
    Completed,
    Cancelled,
}

/// Falha de turno, separando "a retomada da sessão se perdeu" (recuperável
/// recomeçando com o contexto completo) de erros terminais.
enum TurnFailure {
    ResumeLost,
    Fatal(String),
}

async fn stream_turn(
    session: &mut ClaudeSession,
    job: &PromptJob,
) -> Result<TurnEnd, TurnFailure> {
    let cancelled = job.cancel.notified();
    tokio::pin!(cancelled);
    let mut got_output = false;
    let mut announced_thinking = false;

    loop {
        let line = tokio::select! {
            _ = &mut cancelled => {
                let _ = job.on_event.send(AcpEvent::Status {
                    message: "Interrompendo o Claude…".into(),
                });
                // A sessão já está persistida em disco; o próximo envio a
                // retoma com --resume. Matar o processo é a interrupção que o
                // modo headless suporta.
                let _ = session.child.start_kill();
                return Ok(TurnEnd::Cancelled);
            }
            line = session.stdout.next_line() => line,
        };

        let line = match line {
            Ok(Some(line)) => line,
            Ok(None) | Err(_) => {
                // EOF antes do fim do turno. Se foi um processo retomado que
                // nunca respondeu, a sessão nativa provavelmente se perdeu
                // (apagada/expirada) — recomeça com o contexto completo.
                if session.resumed && !session.turned && !got_output {
                    return Err(TurnFailure::ResumeLost);
                }
                return Err(TurnFailure::Fatal(session.death_error()));
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        for event in interpret_line(&value) {
            match event {
                ClaudeEvent::Session(id) => {
                    got_output = true;
                    if session.session_id.as_deref() != Some(id.as_str()) {
                        session.session_id = Some(id.clone());
                    }
                    let _ = job.on_event.send(AcpEvent::Session { session_id: id });
                }
                ClaudeEvent::Text(text) => {
                    got_output = true;
                    let _ = job.on_event.send(AcpEvent::Text { content: text });
                }
                ClaudeEvent::ToolUse(name) => {
                    got_output = true;
                    let _ = job.on_event.send(AcpEvent::Status {
                        message: format!("Claude executando {name}…"),
                    });
                }
                ClaudeEvent::Thinking(thinking) => {
                    got_output = true;
                    if !announced_thinking {
                        announced_thinking = true;
                        let _ = job.on_event.send(AcpEvent::Status {
                            message: "Claude pensando…".into(),
                        });
                    }
                    let _ = job.on_event.send(AcpEvent::Thought { content: thinking });
                }
                ClaudeEvent::Result(result) => {
                    session.turned = true;
                    return match result {
                        Ok(()) => Ok(TurnEnd::Completed),
                        Err(message) => Err(TurnFailure::Fatal(message)),
                    };
                }
                ClaudeEvent::Ignored => {}
            }
        }
    }
}

pub(crate) async fn run_worker(
    root: PathBuf,
    mut jobs: mpsc::UnboundedReceiver<PromptJob>,
) -> Result<(), String> {
    // Session ids aprendidos nesta execução (complementam o id persistido pelo
    // frontend, que cobre reinícios do app).
    let mut known_sessions: HashMap<String, String> = HashMap::new();
    let mut current: Option<ClaudeSession> = None;

    while let Some(job) = jobs.recv().await {
        // O processo atende exatamente uma conversa+modo; qualquer troca
        // derruba o processo e retoma a sessão alvo com --resume.
        let stale = current.as_ref().is_some_and(|session| {
            session.conversation_id != job.conversation_id
                || session.mode != job.mode
                || session.model != job.model
        });
        let dead = current
            .as_mut()
            .is_some_and(|session| session.child.try_wait().ok().flatten().is_some());
        if stale || dead {
            retire(&mut current, &mut known_sessions);
        }

        let result = run_job(&root, &mut current, &mut known_sessions, &job).await;
        if let Err(message) = &result {
            let _ = job.on_event.send(AcpEvent::Error {
                message: message.clone(),
            });
            // Um turno com erro deixa o processo em estado incerto; descarta e
            // reconecta (via --resume) no próximo envio.
            retire(&mut current, &mut known_sessions);
        }
        let _ = job.done.send(result);
    }
    Ok(())
}

/// Derruba o processo atual preservando o session id para retomadas futuras.
fn retire(current: &mut Option<ClaudeSession>, known_sessions: &mut HashMap<String, String>) {
    if let Some(mut session) = current.take() {
        if let Some(id) = session.session_id.take() {
            known_sessions.insert(session.conversation_id.clone(), id);
        }
        let _ = session.child.start_kill();
    }
}

async fn run_job(
    root: &Path,
    current: &mut Option<ClaudeSession>,
    known_sessions: &mut HashMap<String, String>,
    job: &PromptJob,
) -> Result<(), String> {
    let mut attempted_resume = false;
    if current.is_none() {
        let resume = known_sessions
            .get(&job.conversation_id)
            .cloned()
            .or_else(|| job.native_session_id.clone());
        attempted_resume = resume.is_some();
        let _ = job.on_event.send(AcpEvent::Status {
            message: if attempted_resume {
                "Retomando a conversa no Claude…".into()
            } else {
                "Claude conectado. Preparando a conversa…".into()
            },
        });
        *current = Some(
            spawn_session(
                root,
                &job.conversation_id,
                job.mode,
                &job.model,
                resume.as_deref(),
            )
            .await?,
        );
    } else {
        let _ = job.on_event.send(AcpEvent::Status {
            message: "Sessão Claude ativa. Processando a mensagem…".into(),
        });
    }

    let outcome = drive_turn(current, job, attempted_resume).await;
    match outcome {
        Ok(TurnEnd::Completed) => {
            if let Some(session) = current.as_ref() {
                if let Some(id) = &session.session_id {
                    known_sessions.insert(job.conversation_id.clone(), id.clone());
                }
            }
            let _ = job.on_event.send(AcpEvent::Done {
                stop_reason: "completed".into(),
            });
            Ok(())
        }
        Ok(TurnEnd::Cancelled) => {
            retire(current, known_sessions);
            let _ = job.on_event.send(AcpEvent::Done {
                stop_reason: "Cancelled".into(),
            });
            Ok(())
        }
        Err(TurnFailure::ResumeLost) => {
            // A sessão nativa sumiu (limpeza do CLI, pasta movida…). Recomeça
            // do zero com o contexto completo — o histórico da UI reconstrói a
            // conversa e um novo session id é emitido para o frontend salvar.
            // O descarte é manual (sem `retire`) para NÃO preservar o id morto.
            if let Some(mut session) = current.take() {
                let _ = session.child.start_kill();
            }
            known_sessions.remove(&job.conversation_id);
            let _ = job.on_event.send(AcpEvent::Status {
                message: "Não foi possível retomar a sessão anterior; recriando a conversa…"
                    .into(),
            });
            *current = Some(
                spawn_session(root, &job.conversation_id, job.mode, &job.model, None).await?,
            );
            match drive_turn_fresh(current, job).await {
                Ok(TurnEnd::Completed) => {
                    if let Some(session) = current.as_ref() {
                        if let Some(id) = &session.session_id {
                            known_sessions.insert(job.conversation_id.clone(), id.clone());
                        }
                    }
                    let _ = job.on_event.send(AcpEvent::Done {
                        stop_reason: "completed".into(),
                    });
                    Ok(())
                }
                Ok(TurnEnd::Cancelled) => {
                    retire(current, known_sessions);
                    let _ = job.on_event.send(AcpEvent::Done {
                        stop_reason: "Cancelled".into(),
                    });
                    Ok(())
                }
                Err(TurnFailure::Fatal(message)) => Err(message),
                Err(TurnFailure::ResumeLost) => Err(fatal_message(current)),
            }
        }
        Err(TurnFailure::Fatal(message)) => Err(message),
    }
}

/// Envia a mensagem do turno atual e consome o stream até o fim do turno.
async fn drive_turn(
    current: &mut Option<ClaudeSession>,
    job: &PromptJob,
    resumed_now: bool,
) -> Result<TurnEnd, TurnFailure> {
    let session = current
        .as_mut()
        .expect("a sessão Claude deve existir após o spawn");
    // Contexto completo apenas quando não há sessão nativa para retomar e este
    // é o primeiro turno do processo (conversa genuinamente nova). A mensagem
    // vai sem scaffolding: permissões são as flags nativas do CLI.
    let is_new_session = !resumed_now && !session.turned && !session.resumed;
    let prompt = prompt_for_session(is_new_session, &job.context_prompt, &job.prompt);
    session
        .send_user_message(prompt)
        .await
        .map_err(TurnFailure::Fatal)?;
    stream_turn(session, job).await
}

/// Variante do fallback: sessão recém-criada do zero, sempre com contexto.
async fn drive_turn_fresh(
    current: &mut Option<ClaudeSession>,
    job: &PromptJob,
) -> Result<TurnEnd, TurnFailure> {
    let session = current
        .as_mut()
        .expect("a sessão Claude deve existir após o spawn");
    session
        .send_user_message(&job.context_prompt)
        .await
        .map_err(TurnFailure::Fatal)?;
    stream_turn(session, job).await
}

fn fatal_message(current: &mut Option<ClaudeSession>) -> String {
    current
        .as_mut()
        .map(ClaudeSession::death_error)
        .unwrap_or_else(|| "O Claude não conseguiu concluir a resposta.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_session_id_from_init() {
        let events = interpret_line(&json!({
            "type": "system",
            "subtype": "init",
            "session_id": "s-123"
        }));
        assert_eq!(events, vec![ClaudeEvent::Session("s-123".into())]);
    }

    #[test]
    fn streams_partial_text_deltas() {
        let events = interpret_line(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "Olá" }
            }
        }));
        assert_eq!(events, vec![ClaudeEvent::Text("Olá".into())]);
    }

    #[test]
    fn streams_thinking_deltas_with_their_text() {
        let events = interpret_line(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "thinking_delta", "thinking": "Analisando o código…" }
            }
        }));
        assert_eq!(
            events,
            vec![ClaudeEvent::Thinking("Analisando o código…".into())]
        );
    }

    #[test]
    fn ignores_subagent_deltas() {
        let events = interpret_line(&json!({
            "type": "stream_event",
            "parent_tool_use_id": "tool-1",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "interno" }
            }
        }));
        assert_eq!(events, vec![ClaudeEvent::Ignored]);
    }

    #[test]
    fn reports_tool_use_as_status() {
        let events = interpret_line(&json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "content_block": { "type": "tool_use", "name": "Read" }
            }
        }));
        assert_eq!(events, vec![ClaudeEvent::ToolUse("Read".into())]);
    }

    #[test]
    fn result_ends_the_turn_and_refreshes_the_session_id() {
        let events = interpret_line(&json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "session_id": "s-456"
        }));
        assert_eq!(
            events,
            vec![
                ClaudeEvent::Session("s-456".into()),
                ClaudeEvent::Result(Ok(()))
            ]
        );
    }

    #[test]
    fn error_result_carries_the_message() {
        let events = interpret_line(&json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "estourou o limite"
        }));
        assert!(matches!(
            events.last(),
            Some(ClaudeEvent::Result(Err(message))) if message == "estourou o limite"
        ));
    }

    #[test]
    fn ask_mode_denies_writes_and_bash() {
        let args = mode_args(AgentMode::Ask).join(" ");
        assert!(args.contains("--disallowedTools"));
        assert!(args.contains("Bash"));
        assert!(args.contains("Write"));
    }

    #[test]
    fn plan_mode_uses_the_native_permission_mode() {
        let args = mode_args(AgentMode::Plan).join(" ");
        assert_eq!(args, "--permission-mode plan");
    }

    #[test]
    fn edit_mode_accepts_edits_but_denies_bash() {
        let args = mode_args(AgentMode::Edit).join(" ");
        assert!(args.contains("--permission-mode acceptEdits"));
        assert!(args.contains("--disallowedTools Bash"));
    }

    #[test]
    fn auto_mode_delegates_to_the_cli() {
        let args = mode_args(AgentMode::Auto).join(" ");
        assert_eq!(args, "--permission-mode auto");
    }

    #[test]
    fn bypass_mode_bypasses_permission_prompts() {
        let args = mode_args(AgentMode::Bypass).join(" ");
        assert_eq!(args, "--permission-mode bypassPermissions");
    }
}
