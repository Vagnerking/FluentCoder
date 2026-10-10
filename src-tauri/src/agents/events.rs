//! Eventos do Fluent Chat enviados ao frontend + o "sink" que os transporta e o
//! broker de aprovações interativas.
//!
//! Todos os provedores (Claude stream-json, Codex app-server, agentes ACP)
//! convertem o protocolo nativo para este vocabulário comum — o frontend nunca
//! conhece o protocolo de cada CLI.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AcpEvent {
    Text {
        content: String,
    },
    /// Delta do raciocínio do modelo (extended thinking do Claude, resumo de
    /// reasoning do Codex, `agent_thought_chunk` do ACP). Exibido ao vivo pelo
    /// frontend enquanto o modelo pensa; não entra no transcript persistido.
    Thought {
        content: String,
    },
    Status {
        message: String,
    },
    /// Id nativo da sessão (Claude/ACP) ou thread (Codex) desta conversa. O
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
    /// Criação/atualização de uma chamada de ferramenta (leitura, edição,
    /// comando…). Semântica de *upsert* por `id`: campos ausentes mantêm o
    /// valor anterior no frontend.
    ToolCall {
        #[serde(flatten)]
        call: ToolCallEvent,
    },
    /// Pedido de aprovação interativo (Codex `requestApproval`, ACP
    /// `session/request_permission`, Claude `can_use_tool`). O frontend
    /// responde com `chat_respond_approval(requestId, optionId)`.
    #[serde(rename_all = "camelCase")]
    Approval {
        request_id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        /// Tipo da ação (`execute`, `edit`, `fetch`, `other`…), para o ícone.
        tool_kind: String,
        options: Vec<ApprovalOption>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        diffs: Vec<FileDiff>,
    },
    /// O pedido deixou de valer (turno cancelado, resolvido pelo próprio
    /// provedor) — o cartão sai da tela.
    #[serde(rename_all = "camelCase")]
    ApprovalResolved {
        request_id: String,
    },
    /// Consumo do turno, quando o provedor o reporta.
    Usage {
        #[serde(flatten)]
        usage: UsageInfo,
    },
    /// Modelos que o agente oferece nesta sessão (ACP `session/new.models`).
    #[serde(rename_all = "camelCase")]
    Models {
        models: Vec<ModelInfo>,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEvent {
    pub id: String,
    /// `read | edit | delete | move | search | execute | think | fetch | plan | other`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `pending | in_progress | completed | failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Entrada legível (comando, padrão de busca, argumentos).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Saída da ferramenta (capada).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diffs: Vec<FileDiff>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Conteúdo anterior (ausente = arquivo novo ou desconhecido).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
    /// Diff unificado, quando o provedor só manda o patch (Codex).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unified: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    pub id: String,
    pub label: String,
    /// `allow_once | allow_always | reject_once | reject_always`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_used: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// Destino dos eventos de um turno. Em produção embrulha o `Channel` do
/// Tauri; nos testes coleta os eventos em memória.
#[derive(Clone)]
pub struct EventSink(Arc<dyn Fn(AcpEvent) + Send + Sync>);

impl EventSink {
    pub fn from_channel(channel: Channel<AcpEvent>) -> Self {
        Self(Arc::new(move |event| {
            let _ = channel.send(event);
        }))
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn from_fn(f: impl Fn(AcpEvent) + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    /// Mesmo formato do `Channel::send` para manter o código dos provedores
    /// (`let _ = job.on_event.send(...)`).
    pub fn send(&self, event: AcpEvent) -> Result<(), ()> {
        (self.0)(event);
        Ok(())
    }
}

/// Resposta do usuário a um pedido de aprovação.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalReply {
    pub request_id: String,
    pub option_id: String,
}

/// Roteia a resposta do frontend (`chat_respond_approval`) até o worker que
/// emitiu o pedido. Cada pedido registra o canal do turno que o aguarda.
#[derive(Default)]
pub struct ApprovalBroker {
    pending: Mutex<HashMap<String, mpsc::UnboundedSender<ApprovalReply>>>,
}

impl ApprovalBroker {
    pub fn register(&self, request_id: &str, reply_to: mpsc::UnboundedSender<ApprovalReply>) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(request_id.to_owned(), reply_to);
        }
    }

    pub fn forget(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    pub fn resolve(&self, request_id: &str, option_id: &str) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|error| format!("Falha ao acessar as aprovações: {error}"))?
            .remove(request_id)
            .ok_or_else(|| "Este pedido de aprovação não está mais pendente.".to_string())?;
        sender
            .send(ApprovalReply {
                request_id: request_id.to_owned(),
                option_id: option_id.to_owned(),
            })
            .map_err(|_| "O agente não aguarda mais esta aprovação.".to_string())
    }

    #[cfg(test)]
    pub fn pending_ids(&self) -> Vec<String> {
        self.pending
            .lock()
            .map(|pending| pending.keys().cloned().collect())
            .unwrap_or_default()
    }
}

/// Id único de um pedido de aprovação (o frontend o devolve na resposta).
pub fn new_request_id(provider: &str) -> String {
    format!("{provider}:{}", uuid::Uuid::new_v4())
}

/// Opções padrão de aprovação em pt-BR (Codex/Claude). O ACP usa as opções do
/// próprio agente, com estes rótulos quando o `kind` é conhecido.
pub fn default_approval_options(allow_always: bool) -> Vec<ApprovalOption> {
    let mut options = vec![ApprovalOption {
        id: "allow_once".into(),
        label: approval_label("allow_once").into(),
        kind: "allow_once".into(),
    }];
    if allow_always {
        options.push(ApprovalOption {
            id: "allow_always".into(),
            label: approval_label("allow_always").into(),
            kind: "allow_always".into(),
        });
    }
    options.push(ApprovalOption {
        id: "reject_once".into(),
        label: approval_label("reject_once").into(),
        kind: "reject_once".into(),
    });
    options
}

pub fn approval_label(kind: &str) -> &'static str {
    match kind {
        "allow_once" => "Permitir uma vez",
        "allow_always" => "Sempre nesta sessão",
        "reject_always" => "Negar sempre",
        _ => "Negar",
    }
}

/// Corta textos longos (saída de comando, conteúdo lido) para o transcript.
pub fn cap_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push_str("\n…(truncado)");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_call_flattens_into_the_event() {
        let event = AcpEvent::ToolCall {
            call: ToolCallEvent {
                id: "t1".into(),
                kind: Some("execute".into()),
                status: Some("in_progress".into()),
                ..Default::default()
            },
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(
            value,
            json!({"type": "toolCall", "id": "t1", "kind": "execute", "status": "in_progress"})
        );
    }

    #[test]
    fn approval_serializes_in_camel_case() {
        let value = serde_json::to_value(AcpEvent::Approval {
            request_id: "codex:1".into(),
            title: "Executar comando".into(),
            detail: None,
            tool_kind: "execute".into(),
            options: default_approval_options(true),
            diffs: vec![],
        })
        .unwrap();
        assert_eq!(value["type"], "approval");
        assert_eq!(value["requestId"], "codex:1");
        assert_eq!(value["toolKind"], "execute");
        assert_eq!(value["options"].as_array().unwrap().len(), 3);
        assert!(value.get("diffs").is_none());
    }

    #[test]
    fn broker_routes_a_reply_once() {
        let broker = ApprovalBroker::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        broker.register("r1", tx);
        broker.resolve("r1", "allow_once").unwrap();
        assert_eq!(rx.try_recv().unwrap().option_id, "allow_once");
        assert!(broker.resolve("r1", "allow_once").is_err());
    }

    #[test]
    fn caps_long_text() {
        assert_eq!(cap_text("abc", 5), "abc");
        assert!(cap_text("abcdef", 3).starts_with("abc\n…"));
    }
}
