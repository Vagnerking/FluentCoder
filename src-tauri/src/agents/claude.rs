//! Claude Code pelo protocolo nativo do CLI (`--input-format stream-json` /
//! `--output-format stream-json`) — o mesmo caminho da extensão oficial do
//! VS Code. Um processo persistente por conversa recebe as mensagens pelo
//! stdin e devolve os tokens em streaming pelo stdout, sem `npx`, sem
//! adaptador ACP e sem reenvio do histórico: o CLI grava a sessão em disco e
//! `--resume <sessionId>` a retoma após reinícios do app ou troca de conversa.
//!
//! Aprovações interativas usam o protocolo de controle por stdio do próprio
//! CLI (`--permission-prompt-tool stdio`, o mesmo do Claude Agent SDK): o CLI
//! envia `control_request/can_use_tool` no stdout e nós respondemos com
//! `control_response` no stdin depois que o usuário decide no cartão.

use super::{
    cap_text, default_approval_options, knowledge_mcp_server, new_request_id, prompt_for_session,
    AcpEvent, AgentMode, ApprovalReply, FileDiff, PromptJob, RunOptions, ToolCallEvent, UsageInfo,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

const OUTPUT_CAP: usize = 4000;

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
    /// Restrições de ferramentas do agente personalizado (também flags).
    options: RunOptions,
    /// Session id nativo, capturado do evento `init`/`result` do CLI.
    session_id: Option<String>,
    /// True quando o processo nasceu com `--resume` (para o fallback de
    /// contexto quando a sessão nativa se perdeu).
    resumed: bool,
    /// True depois do primeiro turno concluído com sucesso neste processo.
    turned: bool,
    /// Ferramentas que o usuário liberou com "Sempre nesta sessão".
    always_allowed: HashSet<String>,
    /// Últimas linhas do stderr do CLI, para diagnósticos úteis quando o
    /// processo morre cedo (ex.: "Please run /login").
    stderr_tail: Arc<Mutex<Vec<String>>>,
}

/// Pedido `can_use_tool` do CLI (protocolo de controle por stdio).
#[derive(Debug, PartialEq, Clone)]
struct PermissionAsk {
    request_id: String,
    tool_name: String,
    input: Value,
    suggestions: Option<Value>,
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
    /// Bloco `tool_use` completo (mensagem `assistant`): vira cartão.
    ToolCall(ToolCallEvent),
    /// Delta de raciocínio (extended thinking), com o texto pensado.
    Thinking(String),
    /// Pedido de permissão interativo.
    Permission(PermissionAsk),
    /// `control_request` que não sabemos atender (respondemos com erro).
    UnsupportedControl(String),
    /// Consumo reportado no `result`.
    Usage(UsageInfo),
    /// Fim do turno: `Ok` no sucesso, `Err(mensagem)` quando `is_error`.
    Result(Result<(), String>),
    Ignored,
}

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Tipo ACP equivalente de uma ferramenta do Claude Code (para ícone/título).
fn claude_tool_kind(name: &str) -> &'static str {
    match name {
        "Read" | "NotebookRead" => "read",
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => "edit",
        "Bash" | "BashOutput" | "KillShell" | "KillBash" => "execute",
        "Grep" | "Glob" | "LS" | "ToolSearch" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        "TodoWrite" | "ExitPlanMode" => "plan",
        _ => "other",
    }
}

/// Monta o cartão de uma chamada de ferramenta do Claude a partir do bloco
/// `tool_use` (nome + input), incluindo o diff das edições.
fn claude_tool_call(id: &str, name: &str, input: &Value) -> ToolCallEvent {
    let path = input
        .get("file_path")
        .or_else(|| input.get("notebook_path"))
        .or_else(|| input.get("path"))
        .and_then(Value::as_str);
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let title = match name {
        "Read" => format!("Ler {}", path.map(file_name).unwrap_or("arquivo")),
        "Write" => format!("Criar {}", path.map(file_name).unwrap_or("arquivo")),
        "Edit" | "MultiEdit" | "NotebookEdit" => {
            format!("Editar {}", path.map(file_name).unwrap_or("arquivo"))
        }
        "Bash" => text("description")
            .map(str::to_owned)
            .unwrap_or_else(|| "Executar comando".into()),
        "Grep" => format!("Buscar \"{}\"", text("pattern").unwrap_or("")),
        "Glob" => format!("Procurar arquivos {}", text("pattern").unwrap_or("")),
        "WebFetch" => format!("Abrir {}", text("url").unwrap_or("página")),
        "WebSearch" => format!("Pesquisar \"{}\"", text("query").unwrap_or("")),
        "Task" | "Agent" => format!(
            "Sub-agente: {}",
            text("description").unwrap_or("tarefa")
        ),
        "TodoWrite" => "Atualizar lista de tarefas".into(),
        "ExitPlanMode" => "Apresentar plano".into(),
        other if other.starts_with("mcp__") => {
            let mut parts = other.splitn(3, "__").skip(1);
            let server = parts.next().unwrap_or("");
            let tool = parts.next().unwrap_or(other);
            format!("{server}: {tool}")
        }
        other => other.to_owned(),
    };
    let detail = match name {
        "Bash" => text("command").map(str::to_owned),
        "Grep" | "Glob" => text("path").map(str::to_owned),
        "ExitPlanMode" => text("plan").map(str::to_owned),
        "TodoWrite" => input.get("todos").and_then(Value::as_array).map(|todos| {
            todos
                .iter()
                .map(|todo| {
                    let mark = match todo.get("status").and_then(Value::as_str) {
                        Some("completed") => "[x]",
                        Some("in_progress") => "[~]",
                        _ => "[ ]",
                    };
                    format!("{mark} {}", todo.get("content").and_then(Value::as_str).unwrap_or(""))
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => None,
        _ if input.as_object().is_some_and(|object| !object.is_empty()) => {
            Some(cap_text(&input.to_string(), 1000))
        }
        _ => None,
    };
    let mut diffs = Vec::new();
    if let Some(path) = path {
        match name {
            "Edit" => diffs.push(FileDiff {
                path: path.to_owned(),
                old_text: text("old_string").map(str::to_owned),
                new_text: text("new_string").map(str::to_owned),
                unified: None,
            }),
            "MultiEdit" => {
                for edit in input.get("edits").and_then(Value::as_array).into_iter().flatten() {
                    diffs.push(FileDiff {
                        path: path.to_owned(),
                        old_text: edit.get("old_string").and_then(Value::as_str).map(str::to_owned),
                        new_text: edit.get("new_string").and_then(Value::as_str).map(str::to_owned),
                        unified: None,
                    });
                }
            }
            "Write" => diffs.push(FileDiff {
                path: path.to_owned(),
                old_text: None,
                new_text: text("content").map(str::to_owned),
                unified: None,
            }),
            _ => {}
        }
    }
    ToolCallEvent {
        id: id.to_owned(),
        kind: Some(claude_tool_kind(name).into()),
        title: Some(title),
        status: Some("in_progress".into()),
        detail,
        output: None,
        locations: path.map(|path| vec![path.to_owned()]).unwrap_or_default(),
        diffs,
    }
}

/// Texto de um `tool_result` (string ou lista de blocos `text`).
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Mapeia uma linha do stdout do CLI para eventos do chat. Deltas de
/// sub-agentes/ferramentas aninhadas (`parent_tool_use_id`) são ignorados para
/// não vazar texto interno na conversa.
fn interpret_line(value: &Value) -> Vec<ClaudeEvent> {
    let mut events = Vec::new();
    let nested = value
        .get("parent_tool_use_id")
        .is_some_and(|id| !id.is_null());
    match value.get("type").and_then(Value::as_str) {
        Some("system") => {
            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                if let Some(id) = value.get("session_id").and_then(Value::as_str) {
                    events.push(ClaudeEvent::Session(id.to_owned()));
                }
            }
        }
        Some("control_request") => {
            let request_id = value
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let request = &value["request"];
            match request.get("subtype").and_then(Value::as_str) {
                Some("can_use_tool") => events.push(ClaudeEvent::Permission(PermissionAsk {
                    request_id,
                    tool_name: request
                        .get("tool_name")
                        .and_then(Value::as_str)
                        .unwrap_or("ferramenta")
                        .to_owned(),
                    input: request.get("input").cloned().unwrap_or_else(|| json!({})),
                    suggestions: request
                        .get("permission_suggestions")
                        .filter(|value| !value.is_null())
                        .cloned(),
                })),
                _ => events.push(ClaudeEvent::UnsupportedControl(request_id)),
            }
        }
        Some("assistant") if !nested => {
            for block in value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("ferramenta");
                    let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    events.push(ClaudeEvent::ToolCall(claude_tool_call(id, name, &input)));
                }
            }
        }
        Some("user") if !nested => {
            for block in value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                    let output = tool_result_text(block.get("content"));
                    events.push(ClaudeEvent::ToolCall(ToolCallEvent {
                        id: block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        status: Some(if failed { "failed" } else { "completed" }.into()),
                        output: (!output.trim().is_empty()).then(|| cap_text(&output, OUTPUT_CAP)),
                        ..Default::default()
                    }));
                }
            }
        }
        Some("stream_event") => {
            if nested {
                return vec![ClaudeEvent::Ignored];
            }
            let event = &value["event"];
            match event.get("type").and_then(Value::as_str) {
                Some("content_block_delta") => {
                    match event.pointer("/delta/type").and_then(Value::as_str) {
                        Some("text_delta") => {
                            if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str)
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
            let usage = value.get("usage");
            let read = |key: &str| usage.and_then(|usage| usage.get(key)).and_then(Value::as_u64);
            let cost = value.get("total_cost_usd").and_then(Value::as_f64);
            if usage.is_some() || cost.is_some() {
                let input = read("input_tokens");
                let cache_read = read("cache_read_input_tokens");
                let cache_write = read("cache_creation_input_tokens");
                events.push(ClaudeEvent::Usage(UsageInfo {
                    input_tokens: input.map(|input| {
                        input + cache_read.unwrap_or(0) + cache_write.unwrap_or(0)
                    }),
                    output_tokens: read("output_tokens"),
                    cached_input_tokens: cache_read,
                    cost_usd: cost,
                    ..Default::default()
                }));
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
    let (command, args) = knowledge_mcp_server(root)?;
    let config = json!({
        "mcpServers": {
            "fluent-knowledge": {
                "command": command,
                "args": args
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

/// Regra de permissão que libera todas as ferramentas do MCP de conhecimento.
const KNOWLEDGE_MCP_RULE: &str = "mcp__fluent-knowledge";

/// Ferramentas de escrita negadas nos modos somente leitura.
const WRITE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

/// Flags de permissão por modo — os permission modes NATIVOS do Claude Code
/// (validados no CLI 2.1.296: default, acceptEdits, plan, auto,
/// bypassPermissions, dontAsk) + as restrições do agente personalizado:
/// - Ask: leitura pura — nega explicitamente escrita e Bash;
/// - Plan: `--permission-mode plan` nativo (explora e apresenta o plano);
/// - Edit: `acceptEdits` auto-aprova edições de arquivos; Bash negado;
/// - Auto: `--permission-mode auto` — o CLI escolhe; o que precisar de
///   aprovação vira cartão no chat (`--permission-prompt-tool stdio`);
/// - Bypass: `bypassPermissions`, sem confirmações.
///
/// Em todos os modos, exceto Bypass, `--permission-prompt-tool stdio` faz os
/// pedidos de permissão chegarem ao app como `control_request` em vez de
/// serem negados em silêncio pelo modo headless.
fn mode_args(mode: AgentMode, options: &RunOptions) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut disallowed: Vec<String> = Vec::new();
    match mode {
        AgentMode::Ask => {
            disallowed.extend(WRITE_TOOLS.iter().map(|tool| (*tool).to_owned()));
        }
        AgentMode::Plan => args.extend(["--permission-mode".into(), "plan".into()]),
        AgentMode::Edit => {
            args.extend(["--permission-mode".into(), "acceptEdits".into()]);
            disallowed.push("Bash".into());
        }
        AgentMode::Auto => args.extend(["--permission-mode".into(), "auto".into()]),
        AgentMode::Bypass => {
            args.extend(["--permission-mode".into(), "bypassPermissions".into()])
        }
    }
    for tool in &options.disallowed_tools {
        let tool = tool.trim();
        if !tool.is_empty() && !disallowed.iter().any(|known| known == tool) {
            disallowed.push(tool.to_owned());
        }
    }
    if !disallowed.is_empty() {
        args.push("--disallowedTools".into());
        args.push(disallowed.join(","));
    }
    // O servidor MCP de conhecimento do próprio editor é somente leitura:
    // liberado sempre, para não pedir aprovação a cada consulta ao grafo.
    let mut allowed: Vec<&str> = vec![KNOWLEDGE_MCP_RULE];
    allowed.extend(
        options
            .allowed_tools
            .iter()
            .map(|tool| tool.trim())
            .filter(|tool| !tool.is_empty() && *tool != KNOWLEDGE_MCP_RULE),
    );
    if !allowed.is_empty() {
        args.push("--allowedTools".into());
        args.push(allowed.join(","));
    }
    if mode != AgentMode::Bypass {
        args.extend(["--permission-prompt-tool".into(), "stdio".into()]);
    }
    args
}

async fn spawn_session(
    root: &Path,
    conversation_id: &str,
    mode: AgentMode,
    model: &str,
    options: &RunOptions,
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
    command.args(mode_args(mode, options));
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

    let mut session = ClaudeSession {
        child,
        stdin,
        stdout: AsyncBufReader::new(stdout).lines(),
        conversation_id: conversation_id.to_owned(),
        mode,
        model: model.to_owned(),
        options: options.clone(),
        session_id: resume.map(str::to_owned),
        resumed: resume.is_some(),
        turned: false,
        always_allowed: HashSet::new(),
        stderr_tail,
    };
    if mode != AgentMode::Bypass {
        // Mesmo handshake do Claude Agent SDK antes de usar o protocolo de
        // controle (`can_use_tool`). A resposta (`control_response`) é
        // ignorada pelo `interpret_line`.
        session
            .write_json(&json!({
                "type": "control_request",
                "request_id": "fluent-init",
                "request": { "subtype": "initialize" }
            }))
            .await?;
    }
    Ok(session)
}

/// Resposta ao `can_use_tool` conforme a opção escolhida no cartão.
fn permission_response(ask: &PermissionAsk, option_id: &str) -> Value {
    let decision = match option_id {
        "allow_once" => json!({ "behavior": "allow", "updatedInput": ask.input }),
        "allow_always" => {
            let mut decision = json!({ "behavior": "allow", "updatedInput": ask.input });
            if let Some(suggestions) = &ask.suggestions {
                decision["updatedPermissions"] = suggestions.clone();
            }
            decision
        }
        _ => json!({ "behavior": "deny", "message": "O usuário negou esta ação no Fluent Chat." }),
    };
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": ask.request_id,
            "response": decision
        }
    })
}

impl ClaudeSession {
    async fn write_json(&mut self, message: &Value) -> Result<(), String> {
        let mut encoded = serde_json::to_vec(message)
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

    async fn send_user_message(&mut self, text: &str) -> Result<(), String> {
        self.write_json(&json!({
            "type": "user",
            "message": { "role": "user", "content": text }
        }))
        .await
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

fn permission_title(tool_name: &str) -> &'static str {
    match claude_tool_kind(tool_name) {
        "execute" => "Executar comando?",
        "edit" => "Editar arquivo?",
        "fetch" => "Acessar a web?",
        "plan" => "Aprovar o plano?",
        _ => "Usar ferramenta?",
    }
}

async fn stream_turn(
    session: &mut ClaudeSession,
    job: &PromptJob,
) -> Result<TurnEnd, TurnFailure> {
    let cancelled = job.cancel.notified();
    tokio::pin!(cancelled);
    let mut got_output = false;
    let mut announced_thinking = false;
    let (replies_tx, mut replies_rx) = mpsc::unbounded_channel::<ApprovalReply>();
    // request_id do cartão → pedido do CLI aguardando resposta.
    let mut pending: HashMap<String, PermissionAsk> = HashMap::new();
    let forget_pending = |pending: &mut HashMap<String, PermissionAsk>| {
        for request_id in pending.keys() {
            job.approvals.forget(request_id);
            let _ = job.on_event.send(AcpEvent::ApprovalResolved {
                request_id: request_id.clone(),
            });
        }
        pending.clear();
    };

    loop {
        let line = tokio::select! {
            _ = &mut cancelled => {
                let _ = job.on_event.send(AcpEvent::Status {
                    message: "Interrompendo o Claude…".into(),
                });
                forget_pending(&mut pending);
                // A sessão já está persistida em disco; o próximo envio a
                // retoma com --resume. Matar o processo é a interrupção que o
                // modo headless suporta.
                let _ = session.child.start_kill();
                return Ok(TurnEnd::Cancelled);
            }
            Some(reply) = replies_rx.recv() => {
                if let Some(ask) = pending.remove(&reply.request_id) {
                    if reply.option_id == "allow_always" {
                        session.always_allowed.insert(ask.tool_name.clone());
                    }
                    let _ = job.on_event.send(AcpEvent::ApprovalResolved {
                        request_id: reply.request_id.clone(),
                    });
                    session
                        .write_json(&permission_response(&ask, &reply.option_id))
                        .await
                        .map_err(TurnFailure::Fatal)?;
                }
                continue;
            }
            line = session.stdout.next_line() => line,
        };

        let line = match line {
            Ok(Some(line)) => line,
            Ok(None) | Err(_) => {
                forget_pending(&mut pending);
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
                ClaudeEvent::ToolCall(call) => {
                    got_output = true;
                    let _ = job.on_event.send(AcpEvent::ToolCall { call });
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
                ClaudeEvent::Permission(ask) => {
                    got_output = true;
                    if session.always_allowed.contains(&ask.tool_name) {
                        session
                            .write_json(&permission_response(&ask, "allow_once"))
                            .await
                            .map_err(TurnFailure::Fatal)?;
                        continue;
                    }
                    let request_id = new_request_id("claude");
                    let card = claude_tool_call(&ask.request_id, &ask.tool_name, &ask.input);
                    job.approvals.register(&request_id, replies_tx.clone());
                    let _ = job.on_event.send(AcpEvent::Approval {
                        request_id: request_id.clone(),
                        title: permission_title(&ask.tool_name).into(),
                        detail: card.detail.clone().or_else(|| card.title.clone()),
                        tool_kind: claude_tool_kind(&ask.tool_name).into(),
                        options: default_approval_options(true),
                        diffs: card.diffs,
                    });
                    let _ = job.on_event.send(AcpEvent::Status {
                        message: "Aguardando sua aprovação…".into(),
                    });
                    pending.insert(request_id, ask);
                }
                ClaudeEvent::UnsupportedControl(request_id) => {
                    session
                        .write_json(&json!({
                            "type": "control_response",
                            "response": {
                                "subtype": "error",
                                "request_id": request_id,
                                "error": "Solicitação não suportada pelo Fluent Coder."
                            }
                        }))
                        .await
                        .map_err(TurnFailure::Fatal)?;
                }
                ClaudeEvent::Usage(usage) => {
                    let _ = job.on_event.send(AcpEvent::Usage { usage });
                }
                ClaudeEvent::Result(result) => {
                    forget_pending(&mut pending);
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
        // O processo atende exatamente uma conversa+modo+modelo+restrições;
        // qualquer troca derruba o processo e retoma a sessão alvo com --resume.
        let stale = current.as_ref().is_some_and(|session| {
            session.conversation_id != job.conversation_id
                || session.mode != job.mode
                || session.model != job.model
                || session.options != job.options
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
                &job.options,
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
                message: "Não foi possível retomar a sessão anterior; recriando a conversa…".into(),
            });
            *current = Some(
                spawn_session(
                    root,
                    &job.conversation_id,
                    job.mode,
                    &job.model,
                    &job.options,
                    None,
                )
                .await?,
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

    fn args(mode: AgentMode) -> String {
        mode_args(mode, &RunOptions::default()).join(" ")
    }

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
    fn assistant_tool_use_becomes_a_card_with_diff() {
        let events = interpret_line(&json!({
            "type": "assistant",
            "parent_tool_use_id": null,
            "message": { "content": [
                { "type": "text", "text": "Vou editar" },
                { "type": "tool_use", "id": "toolu_1", "name": "Edit",
                  "input": { "file_path": "/w/src/main.rs", "old_string": "a", "new_string": "b" } }
            ]}
        }));
        let [ClaudeEvent::ToolCall(call)] = events.as_slice() else { panic!("{events:?}") };
        assert_eq!(call.id, "toolu_1");
        assert_eq!(call.kind.as_deref(), Some("edit"));
        assert_eq!(call.title.as_deref(), Some("Editar main.rs"));
        assert_eq!(call.diffs[0].old_text.as_deref(), Some("a"));
        assert_eq!(call.locations, vec!["/w/src/main.rs".to_string()]);
    }

    #[test]
    fn bash_tool_use_shows_the_command() {
        let call = claude_tool_call("t", "Bash", &json!({ "command": "cargo test", "description": "Rodar testes" }));
        assert_eq!(call.kind.as_deref(), Some("execute"));
        assert_eq!(call.title.as_deref(), Some("Rodar testes"));
        assert_eq!(call.detail.as_deref(), Some("cargo test"));
    }

    #[test]
    fn tool_result_completes_the_card() {
        let events = interpret_line(&json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "is_error": true,
                  "content": [{ "type": "text", "text": "falhou" }] }
            ]}
        }));
        let [ClaudeEvent::ToolCall(call)] = events.as_slice() else { panic!("{events:?}") };
        assert_eq!(call.status.as_deref(), Some("failed"));
        assert_eq!(call.output.as_deref(), Some("falhou"));
    }

    #[test]
    fn can_use_tool_becomes_a_permission_request() {
        let events = interpret_line(&json!({
            "type": "control_request",
            "request_id": "req-9",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "input": { "command": "rm -rf build" },
                "permission_suggestions": [{ "type": "addRules" }]
            }
        }));
        let [ClaudeEvent::Permission(ask)] = events.as_slice() else { panic!("{events:?}") };
        assert_eq!(ask.request_id, "req-9");
        assert_eq!(ask.tool_name, "Bash");

        let allow = permission_response(ask, "allow_once");
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["request_id"], "req-9");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(allow["response"]["response"]["updatedInput"]["command"], "rm -rf build");
        let always = permission_response(ask, "allow_always");
        assert_eq!(always["response"]["response"]["updatedPermissions"][0]["type"], "addRules");
        let deny = permission_response(ask, "reject_once");
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
    }

    #[test]
    fn unknown_control_requests_are_answered_with_error() {
        let events = interpret_line(&json!({
            "type": "control_request", "request_id": "r", "request": { "subtype": "hook_callback" }
        }));
        assert_eq!(events, vec![ClaudeEvent::UnsupportedControl("r".into())]);
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
    fn result_reports_usage_and_cost() {
        let events = interpret_line(&json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "total_cost_usd": 0.042,
            "usage": { "input_tokens": 10, "cache_read_input_tokens": 90, "output_tokens": 5 }
        }));
        assert!(events.contains(&ClaudeEvent::Usage(UsageInfo {
            input_tokens: Some(100),
            output_tokens: Some(5),
            cached_input_tokens: Some(90),
            cost_usd: Some(0.042),
            ..Default::default()
        })));
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
        let args = args(AgentMode::Ask);
        assert!(args.contains("--disallowedTools"));
        assert!(args.contains("Bash"));
        assert!(args.contains("Write"));
        assert!(args.contains("--permission-prompt-tool stdio"));
    }

    #[test]
    fn plan_mode_uses_the_native_permission_mode() {
        assert_eq!(
            args(AgentMode::Plan),
            "--permission-mode plan --allowedTools mcp__fluent-knowledge --permission-prompt-tool stdio"
        );
    }

    #[test]
    fn edit_mode_accepts_edits_but_denies_bash() {
        let args = args(AgentMode::Edit);
        assert!(args.contains("--permission-mode acceptEdits"));
        assert!(args.contains("--disallowedTools Bash"));
    }

    #[test]
    fn auto_mode_delegates_to_the_cli_with_interactive_approvals() {
        assert_eq!(
            args(AgentMode::Auto),
            "--permission-mode auto --allowedTools mcp__fluent-knowledge --permission-prompt-tool stdio"
        );
    }

    #[test]
    fn bypass_mode_bypasses_permission_prompts() {
        assert_eq!(
            args(AgentMode::Bypass),
            "--permission-mode bypassPermissions --allowedTools mcp__fluent-knowledge"
        );
    }

    #[test]
    fn custom_agent_tool_rules_merge_with_the_mode() {
        let options = RunOptions {
            allowed_tools: vec!["Read".into(), " Grep ".into()],
            disallowed_tools: vec!["WebFetch".into(), "Bash".into()],
            network_access: false,
        };
        let args = mode_args(AgentMode::Edit, &options).join(" ");
        assert!(args.contains("--disallowedTools Bash,WebFetch"), "{args}");
        assert!(args.contains("--allowedTools mcp__fluent-knowledge,Read,Grep"), "{args}");
    }
}
