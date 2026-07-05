//! Backend do chat de agentes (Claude Code / Codex CLI).
//!
//! Cada provedor mantém um processo de longa duração por workspace, no mesmo
//! protocolo usado pelas extensões oficiais de editor:
//! - Codex: `codex app-server` (JSON-RPC por stdio) com threads persistentes;
//! - Claude: CLI `claude` em modo headless `stream-json` bidirecional.
//!
//! As conversas guardam o id nativo de sessão/thread do provedor
//! (`nativeSessionId` no store do frontend), então retomar uma conversa nunca
//! reenvia o transcript inteiro — o provedor recarrega o próprio histórico.

mod claude;
mod codex;

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, oneshot, Notify};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpEvent {
    Text {
        content: String,
    },
    /// Delta do raciocínio do modelo (extended thinking do Claude, resumo de
    /// reasoning do Codex). Exibido ao vivo pelo frontend enquanto o modelo
    /// pensa; não entra no transcript persistido.
    Thought {
        content: String,
    },
    Status {
        message: String,
    },
    /// Id nativo da sessão (Claude) ou thread (Codex) desta conversa. O
    /// frontend persiste o id para retomar a conversa em envios futuros.
    #[serde(rename_all = "camelCase")]
    Session {
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        stop_reason: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct WorkerKey {
    provider: String,
    root: PathBuf,
}

/// Long-lived provider processes keyed by provider/workspace.
pub struct AcpState {
    workers: Mutex<HashMap<WorkerKey, mpsc::UnboundedSender<PromptJob>>>,
    cancel: Arc<Notify>,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
            cancel: Arc::new(Notify::new()),
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

impl Default for AcpState {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) struct PromptJob {
    conversation_id: String,
    context_prompt: String,
    prompt: String,
    mode: AgentMode,
    /// Modelo escolhido no frontend (id do catálogo do provedor). Vazio ⇒ o CLI
    /// usa o modelo padrão configurado do provedor.
    model: String,
    /// Id nativo salvo pelo frontend (sessão Claude / thread Codex), presente
    /// quando a conversa já falou com o provedor antes (inclusive em execuções
    /// anteriores do app).
    native_session_id: Option<String>,
    on_event: Channel<AcpEvent>,
    cancel: Arc<Notify>,
    done: oneshot::Sender<Result<(), String>>,
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
    /// O agente escolhe o nível; escalações arriscadas são negadas.
    Auto,
    /// Acesso total, sem confirmações.
    Bypass,
}

impl AgentMode {
    fn parse(value: &str) -> Result<Self, String> {
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
        on_event: on_event.clone(),
        cancel: Arc::clone(&state.cancel),
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
    let root = fs::canonicalize(&workspace_root)
        .map_err(|error| format!("Não foi possível validar o workspace: {error}"))?;
    if !root.is_dir() {
        return Err("O workspace informado não é uma pasta.".into());
    }
    state.worker_for(WorkerKey { provider, root })?;
    Ok(())
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

/// Cancels the single in-flight prompt. Codex interrupts only the current turn
/// and keeps its app-server/session alive; Claude kills the CLI process and the
/// next send resumes the persisted session with `--resume`.
#[tauri::command]
pub fn acp_cancel(state: State<'_, AcpState>) {
    // `notify_one` stores a permit when cancellation races worker startup, so a
    // click immediately after Send cannot be lost.
    state.cancel.notify_one();
}

async fn run_worker(
    provider: String,
    root: PathBuf,
    jobs: mpsc::UnboundedReceiver<PromptJob>,
) -> Result<(), String> {
    match provider.as_str() {
        "codex" => codex::run_worker(root, jobs).await,
        "claude" => claude::run_worker(root, jobs).await,
        _ => Err(format!("Provedor desconhecido: {provider}")),
    }
}

pub(crate) fn provider_label(provider: &str) -> Result<&'static str, String> {
    match provider {
        "codex" => Ok("Codex"),
        "claude" => Ok("Claude"),
        _ => Err(format!("Provedor desconhecido: {provider}")),
    }
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
        "version": 1,
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
