//! Backend do Fluent Chat (Claude Code, Codex e agentes ACP).
//!
//! Cada provedor mantém um processo de longa duração por workspace, no mesmo
//! protocolo usado pelas extensões oficiais de editor:
//! - Codex: `codex app-server` (JSON-RPC por stdio) com threads persistentes;
//! - Claude: CLI `claude` em modo headless `stream-json` bidirecional;
//! - Gemini CLI, opencode, Qwen Code, Goose…: Agent Client Protocol (ACP,
//!   JSON-RPC por stdio) pelo cliente genérico de [`acp`].
//!
//! Os provedores ficam num registro ([`registry`]) atrás do trait
//! [`registry::AgentProvider`]; o despacho de workers não conhece nenhum CLI.
//!
//! As conversas guardam o id nativo de sessão/thread do provedor
//! (`nativeSessionId` no store do frontend), então retomar uma conversa nunca
//! reenvia o transcript inteiro — o provedor recarrega o próprio histórico.

mod acp;
mod claude;
mod codex;
mod events;
pub mod ide_bridge;
mod registry;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::{mpsc, oneshot, Notify};

pub(crate) use events::{
    approval_label, cap_text, default_approval_options, new_request_id, AcpEvent,
    ApprovalBroker, ApprovalOption, ApprovalReply, EventSink, FileDiff, ModelInfo, ToolCallEvent,
    UsageInfo,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WorkerKey {
    provider: String,
    root: PathBuf,
}

/// Long-lived provider processes keyed by provider/workspace.
pub struct AcpState {
    workers: Mutex<HashMap<WorkerKey, mpsc::UnboundedSender<PromptJob>>>,
    cancel: Arc<Notify>,
    approvals: Arc<ApprovalBroker>,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
            cancel: Arc::new(Notify::new()),
            approvals: Arc::new(ApprovalBroker::default()),
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

        let provider = registry::find_provider(&key.provider)
            .ok_or_else(|| format!("Provedor desconhecido: {}", key.provider))?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let worker = provider.spawn_worker(key.root.clone(), receiver);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = worker.await {
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

impl Default for AcpState {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) struct PromptJob {
    pub(crate) conversation_id: String,
    pub(crate) context_prompt: String,
    pub(crate) prompt: String,
    pub(crate) mode: AgentMode,
    /// Modelo escolhido no frontend (id do catálogo do provedor). Vazio ⇒ o CLI
    /// usa o modelo padrão configurado do provedor.
    pub(crate) model: String,
    /// Id nativo salvo pelo frontend (sessão Claude / thread Codex / sessão
    /// ACP), presente quando a conversa já falou com o provedor antes
    /// (inclusive em execuções anteriores do app).
    pub(crate) native_session_id: Option<String>,
    /// Restrições do agente personalizado (ferramentas, rede do sandbox).
    pub(crate) options: RunOptions,
    pub(crate) on_event: EventSink,
    pub(crate) cancel: Arc<Notify>,
    /// Broker onde o worker registra pedidos de aprovação interativos.
    pub(crate) approvals: Arc<ApprovalBroker>,
    pub(crate) done: oneshot::Sender<Result<(), String>>,
}

/// Restrições por agente personalizado, aplicadas pelo mecanismo NATIVO de
/// cada provedor (flags `--allowedTools`/`--disallowedTools` do Claude; rede
/// do sandbox `workspace-write` do Codex). Fazem parte da identidade do
/// processo no Claude: mudar derruba e recria o processo (como o modo).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RunOptions {
    pub(crate) allowed_tools: Vec<String>,
    pub(crate) disallowed_tools: Vec<String>,
    pub(crate) network_access: bool,
}

/// What the agent is allowed to do for a given send, espelhando os modos de
/// permissão do Claude Code. Each provider maps the mode to its native
/// permission system (Claude: `--permission-mode`/tool rules; Codex:
/// sandbox + approvalPolicy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentMode {
    /// Read-only: the agent may answer, never write files.
    Ask,
    /// Read-only: explora e apresenta um plano antes de qualquer edição.
    Plan,
    /// Edita arquivos do workspace automaticamente.
    Edit,
    /// O agente escolhe o nível; escalações viram cartões de aprovação.
    Auto,
    /// Acesso total, sem confirmações.
    Bypass,
}

impl AgentMode {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ask" => Ok(Self::Ask),
            "plan" => Ok(Self::Plan),
            "edit" => Ok(Self::Edit),
            "auto" => Ok(Self::Auto),
            // `dev` é o nome legado do modo de acesso total.
            "bypass" | "dev" => Ok(Self::Bypass),
            other => Err(format!("Modo de agente desconhecido: {other}")),
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

// The argument list mirrors the IPC payload from the front end; grouping it into
// a struct would only obscure the command's contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn acp_prompt(
    provider: String,
    workspace_root: String,
    conversation_id: String,
    context_prompt: String,
    prompt: String,
    mode: String,
    model: String,
    native_session_id: Option<String>,
    options: Option<RunOptions>,
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
    let root = canonical_workspace(&workspace_root)?;
    let label = provider_label(&provider)?;
    let on_event = EventSink::from_channel(on_event);
    let key = WorkerKey {
        provider: provider.clone(),
        root,
    };
    // As mensagens de status não expõem detalhes de implementação (CLI,
    // processos) — o usuário vê apenas o agente preparando a resposta.
    let (worker, reused) = state.worker_for(key.clone())?;
    let _ = on_event.send(AcpEvent::Status {
        message: if reused {
            format!("Preparando o {label}…")
        } else {
            format!("Iniciando o {label}…")
        },
    });

    let (done, completed) = oneshot::channel();
    let job = PromptJob {
        conversation_id,
        context_prompt,
        prompt,
        mode,
        model,
        native_session_id,
        options: options.unwrap_or_default(),
        on_event: on_event.clone(),
        cancel: Arc::clone(&state.cancel),
        approvals: Arc::clone(&state.approvals),
        done,
    };
    if let Err(error) = worker.send(job) {
        state.discard_worker(&key)?;
        let (replacement, _) = state.worker_for(key)?;
        let _ = on_event.send(AcpEvent::Status {
            message: format!("Reconectando ao {label}…"),
        });
        replacement
            .send(error.0)
            .map_err(|_| format!("Não foi possível reconectar ao {label}."))?;
    }

    match completed.await {
        Ok(result) => result,
        Err(_) => {
            let message = format!(
                "O {label} foi desconectado durante a resposta. Envie novamente para reconectar."
            );
            let _ = on_event.send(AcpEvent::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

fn canonical_workspace(workspace_root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(workspace_root)
        .map_err(|error| format!("Não foi possível validar o workspace: {error}"))?;
    if !root.is_dir() {
        return Err("O workspace informado não é uma pasta.".into());
    }
    Ok(root)
}

/// Pré-aquece o worker do provedor para o workspace: garante que o processo
/// (e, no Codex, o app-server + `initialize`) já esteja de pé antes do
/// primeiro envio, tirando o boot do caminho da primeira resposta. Idempotente
/// — reutiliza o worker existente.
#[tauri::command]
pub fn acp_warm(
    provider: String,
    workspace_root: String,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    provider_label(&provider)?;
    let root = canonical_workspace(&workspace_root)?;
    state.worker_for(WorkerKey { provider, root })?;
    Ok(())
}

#[tauri::command]
pub fn acp_stop_workspace(
    workspace_root: String,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    let root = canonical_workspace(&workspace_root)?;
    state.stop_workspace(&root)
}

/// Derruba todos os processos de agentes (todas as pastas). Usado pelo
/// comando "Fluent Chat: Reiniciar Agentes de IA" da Paleta; o próximo envio
/// sobe o processo de novo e retoma a sessão nativa.
#[tauri::command]
pub fn acp_stop_all(state: State<'_, AcpState>) {
    state.shutdown_all();
}

/// Cancels the single in-flight prompt. Codex interrupts only the current turn
/// and keeps its app-server/session alive; ACP sends `session/cancel`; Claude
/// kills the CLI process and the next send resumes the persisted session with
/// `--resume`.
#[tauri::command]
pub fn acp_cancel(state: State<'_, AcpState>) {
    // `notify_one` stores a permit when cancellation races worker startup, so a
    // click immediately after Send cannot be lost.
    state.cancel.notify_one();
}

/// Resposta do usuário a um cartão de aprovação (`AcpEvent::Approval`).
#[tauri::command]
pub fn chat_respond_approval(
    request_id: String,
    option_id: String,
    state: State<'_, AcpState>,
) -> Result<(), String> {
    state.approvals.resolve(&request_id, &option_id)
}

/// Provedores registrados (nativos + ACP) com a disponibilidade no PATH.
#[tauri::command]
pub async fn chat_providers() -> Result<Vec<registry::ProviderStatus>, String> {
    tauri::async_runtime::spawn_blocking(registry::provider_statuses)
        .await
        .map_err(|error| format!("Falha ao detectar os agentes instalados: {error}"))
}

fn global_agents_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Pasta de dados do app indisponível: {error}"))?;
    Ok(dir.join("fluent-chat").join("agents.json"))
}

/// Agentes personalizados globais (valem para todas as pastas), guardados nos
/// dados do app — complementam os agentes do workspace em `.project/agents.json`.
#[tauri::command]
pub fn chat_global_agents_load(app: tauri::AppHandle) -> Result<Value, String> {
    let path = global_agents_file(&app)?;
    if !path.exists() {
        return Ok(json!({ "version": 2, "agents": [] }));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Falha ao ler os agentes globais: {error}"))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("O arquivo de agentes globais está inválido: {error}"))
}

#[tauri::command]
pub fn chat_global_agents_save(app: tauri::AppHandle, store: Value) -> Result<(), String> {
    let path = global_agents_file(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Falha ao criar a pasta de agentes globais: {error}"))?;
    }
    let json = serde_json::to_string_pretty(&store)
        .map_err(|error| format!("Falha ao serializar os agentes globais: {error}"))?;
    fs::write(path, json).map_err(|error| format!("Falha ao salvar os agentes globais: {error}"))
}

pub(crate) fn provider_label(provider: &str) -> Result<String, String> {
    registry::find_provider(provider)
        .map(|provider| provider.descriptor().label.clone())
        .ok_or_else(|| format!("Provedor desconhecido: {provider}"))
}

/// Comando do servidor MCP de conhecimento do editor (`fluent-coder --mcp
/// <root>`), injetado em todos os provedores: `--mcp-config` no Claude,
/// `-c mcp_servers.*` no Codex e `mcpServers` no `session/new` do ACP.
/// `None` quando o executável não pode ser localizado (a sessão segue sem ele).
pub(crate) fn knowledge_mcp_server(root: &Path) -> Option<(PathBuf, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    Some((exe, vec!["--mcp".into(), root.to_string_lossy().into_owned()]))
}

/// Escolhe entre o contexto completo (agente + histórico) e apenas a nova
/// mensagem. O contexto só é reenviado quando o provedor NÃO consegue retomar a
/// conversa nativamente (conversa nova ou sessão nativa perdida).
pub(crate) fn prompt_for_session<'a>(
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

pub(crate) fn empty_store() -> Value {
    json!({
        "version": 2,
        "agents": [],
        "conversations": []
    })
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

    /// O frontend lê `stopReason`/`sessionId` em camelCase; uma regressão aqui
    /// quebra a finalização do turno e a retomada de conversas.
    #[test]
    fn events_serialize_in_camel_case() {
        let done = serde_json::to_value(AcpEvent::Done {
            stop_reason: "completed".into(),
        })
        .unwrap();
        assert_eq!(done["type"], "done");
        assert_eq!(done["stopReason"], "completed");

        let session = serde_json::to_value(AcpEvent::Session {
            session_id: "abc".into(),
        })
        .unwrap();
        assert_eq!(session["type"], "session");
        assert_eq!(session["sessionId"], "abc");
    }

    #[test]
    fn parses_known_modes() {
        assert_eq!(AgentMode::parse("ask").unwrap(), AgentMode::Ask);
        assert_eq!(AgentMode::parse("plan").unwrap(), AgentMode::Plan);
        assert_eq!(AgentMode::parse("edit").unwrap(), AgentMode::Edit);
        assert_eq!(AgentMode::parse("auto").unwrap(), AgentMode::Auto);
        assert_eq!(AgentMode::parse("bypass").unwrap(), AgentMode::Bypass);
        // Nome legado persistido em conversas antigas.
        assert_eq!(AgentMode::parse("dev").unwrap(), AgentMode::Bypass);
        assert!(AgentMode::parse("outro").is_err());
    }
}
