//! Registro de provedores do Fluent Chat.
//!
//! Cada provedor implementa [`AgentProvider`]: descreve a si mesmo (rótulo,
//! protocolo, dica de instalação), detecta se o CLI está no PATH e sobe o
//! worker de longa duração que atende os turnos de um workspace. O despacho em
//! `mod.rs` só conhece o trait — adicionar um CLI novo é registrar um item aqui
//! (nativo) ou uma linha em [`ACP_AGENTS`] (qualquer CLI que fale ACP).
//!
//! Decisão em docs/adr/0007-fluent-chat-provider-registry.md.

use super::{acp, claude, codex, PromptJob};
use serde::Serialize;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use tokio::sync::mpsc;

pub(crate) type WorkerFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

/// Protocolo de integração do provedor.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProviderProtocol {
    /// `claude -p --input-format stream-json --output-format stream-json`.
    ClaudeStreamJson,
    /// `codex app-server` (JSON-RPC por stdio).
    CodexAppServer,
    /// Agent Client Protocol (JSON-RPC por stdio).
    Acp,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDescriptor {
    pub id: String,
    pub label: String,
    pub description: String,
    pub protocol: ProviderProtocol,
    /// Executável procurado no PATH.
    pub binary: String,
    /// Argumentos que colocam o CLI no modo de integração.
    pub args: Vec<String>,
    /// Argumentos alternativos para versões antigas (ex.: Gemini
    /// `--experimental-acp`), tentados quando o `initialize` falha.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fallback_args: Vec<String>,
    /// Variáveis de ambiente extras do processo (ex.: desligar auto-update).
    #[serde(skip)]
    pub env: Vec<(String, String)>,
    /// Como instalar, exibido quando o CLI não está no PATH.
    pub install_hint: String,
    pub docs_url: String,
    /// Integração em prévia (protocolo/flag ainda experimental no CLI).
    pub preview: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderStatus {
    #[serde(flatten)]
    pub descriptor: ProviderDescriptor,
    pub installed: bool,
}

/// Interface comum dos provedores (nativos e ACP).
pub(crate) trait AgentProvider: Send + Sync {
    fn descriptor(&self) -> &ProviderDescriptor;

    /// O CLI está instalado (no PATH)?
    fn detect(&self) -> bool {
        which::which(&self.descriptor().binary).is_ok()
    }

    /// Sobe o worker de longa duração deste provedor para `root`. Um worker
    /// atende todos os turnos do workspace (nunca um processo por mensagem).
    fn spawn_worker(
        &self,
        root: PathBuf,
        jobs: mpsc::UnboundedReceiver<PromptJob>,
    ) -> WorkerFuture;
}

struct ClaudeProvider(ProviderDescriptor);

impl AgentProvider for ClaudeProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.0
    }
    fn spawn_worker(
        &self,
        root: PathBuf,
        jobs: mpsc::UnboundedReceiver<PromptJob>,
    ) -> WorkerFuture {
        Box::pin(claude::run_worker(root, jobs))
    }
}

struct CodexProvider(ProviderDescriptor);

impl AgentProvider for CodexProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.0
    }
    fn spawn_worker(
        &self,
        root: PathBuf,
        jobs: mpsc::UnboundedReceiver<PromptJob>,
    ) -> WorkerFuture {
        Box::pin(codex::run_worker(root, jobs))
    }
}

/// Qualquer CLI que fale ACP por stdio — o cliente genérico de [`acp`].
pub(crate) struct AcpProvider(pub(crate) ProviderDescriptor);

impl AgentProvider for AcpProvider {
    fn descriptor(&self) -> &ProviderDescriptor {
        &self.0
    }
    fn detect(&self) -> bool {
        // O fixture de teste roda via `node <script>`: o script precisa existir.
        if self.0.id == FIXTURE_ID {
            return which::which(&self.0.binary).is_ok()
                && self
                    .0
                    .args
                    .first()
                    .is_some_and(|script| PathBuf::from(script).is_file());
        }
        which::which(&self.0.binary).is_ok()
    }
    fn spawn_worker(
        &self,
        root: PathBuf,
        jobs: mpsc::UnboundedReceiver<PromptJob>,
    ) -> WorkerFuture {
        Box::pin(acp::run_worker(self.0.clone(), root, jobs))
    }
}

/// Agentes ACP conhecidos: (id, rótulo, descrição, binário, args, args
/// alternativos, instalação, documentação, env). Linhas de comando conferidas
/// no registro oficial do ACP (cdn.agentclientprotocol.com/registry/v1) e na
/// documentação de cada CLI em 10/2026 — revalidar ao atualizar.
type AcpAgentRow = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const ACP_AGENTS: &[AcpAgentRow] = &[
    (
        "gemini",
        "Gemini CLI",
        "Agente de código do Google (Gemini).",
        "gemini",
        &["--acp"],
        &["--experimental-acp"],
        "npm install -g @google/gemini-cli",
        "https://geminicli.com/docs/cli/acp-mode/",
        &[],
    ),
    (
        "copilot",
        "GitHub Copilot CLI",
        "Agente do GitHub Copilot no terminal.",
        "copilot",
        &["--acp", "--stdio"],
        &[],
        "npm install -g @github/copilot",
        "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
        &[],
    ),
    (
        "opencode",
        "opencode",
        "Agente de código aberto multi-provedor.",
        "opencode",
        &["acp"],
        &[],
        "npm install -g opencode-ai",
        "https://opencode.ai/docs/acp/",
        &[],
    ),
    (
        "qwen",
        "Qwen Code",
        "Agente de código da Alibaba (Qwen).",
        "qwen",
        &["--acp"],
        &["--experimental-acp"],
        "npm install -g @qwen-code/qwen-code",
        "https://github.com/QwenLM/qwen-code",
        &[],
    ),
    (
        "goose",
        "Goose",
        "Agente de código aberto da Block.",
        "goose",
        &["acp"],
        &[],
        "brew install block-goose-cli (ou o script download_cli.sh do projeto)",
        "https://block.github.io/goose/",
        &[],
    ),
    (
        "kimi",
        "Kimi CLI",
        "Agente de código da Moonshot AI.",
        "kimi",
        &["acp"],
        &[],
        "uv tool install kimi-cli",
        "https://github.com/MoonshotAI/kimi-cli",
        &[],
    ),
    (
        "auggie",
        "Augment (auggie)",
        "Agente de código da Augment.",
        "auggie",
        &["--acp"],
        &[],
        "npm install -g @augmentcode/auggie",
        "https://docs.augmentcode.com/cli/acp",
        &[("AUGMENT_DISABLE_AUTO_UPDATE", "1")],
    ),
    (
        "cursor-agent",
        "Cursor Agent",
        "Agente de código do Cursor no terminal.",
        "cursor-agent",
        &["acp"],
        &[],
        "curl https://cursor.com/install -fsS | bash",
        "https://cursor.com/cli",
        &[],
    ),
];

/// Id do agente ACP de teste (fixture Node), habilitado com
/// `FLUENT_ACP_FAKE=1` (ou o caminho do script) para testar o chat sem
/// chamadas pagas.
pub(crate) const FIXTURE_ID: &str = "acp-fixture";

fn fixture_script() -> Option<PathBuf> {
    let value = std::env::var("FLUENT_ACP_FAKE").ok()?;
    if value.trim().is_empty() || value == "0" {
        return None;
    }
    if value != "1" {
        return Some(PathBuf::from(value));
    }
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tools")
            .join("acp-fixture")
            .join("fake-agent.mjs"),
    )
}

pub(crate) fn fixture_descriptor(script: PathBuf) -> ProviderDescriptor {
    ProviderDescriptor {
        id: FIXTURE_ID.into(),
        label: "Agente ACP de teste".into(),
        description: "Agente falso local para testar o Fluent Chat sem custo.".into(),
        protocol: ProviderProtocol::Acp,
        binary: "node".into(),
        args: vec![script.to_string_lossy().into_owned()],
        fallback_args: vec![],
        env: vec![],
        install_hint: "Defina FLUENT_ACP_FAKE=1 e tenha o Node no PATH.".into(),
        docs_url: "tools/acp-fixture/README".into(),
        preview: true,
    }
}

fn build_registry() -> Vec<Arc<dyn AgentProvider>> {
    let mut providers: Vec<Arc<dyn AgentProvider>> = vec![
        Arc::new(ClaudeProvider(ProviderDescriptor {
            id: "claude".into(),
            label: "Claude Code".into(),
            description: "Agente de código da Anthropic.".into(),
            protocol: ProviderProtocol::ClaudeStreamJson,
            binary: "claude".into(),
            args: vec![],
            fallback_args: vec![],
            env: vec![],
            install_hint: "npm install -g @anthropic-ai/claude-code (ou o instalador nativo)".into(),
            docs_url: "https://docs.claude.com/en/docs/claude-code".into(),
            preview: false,
        })),
        Arc::new(CodexProvider(ProviderDescriptor {
            id: "codex".into(),
            label: "Codex".into(),
            description: "Agente de código da OpenAI.".into(),
            protocol: ProviderProtocol::CodexAppServer,
            binary: "codex".into(),
            args: vec!["app-server".into()],
            fallback_args: vec![],
            env: vec![],
            install_hint: "npm install -g @openai/codex".into(),
            docs_url: "https://developers.openai.com/codex/cli".into(),
            preview: false,
        })),
    ];
    for (id, label, description, binary, args, fallback, install, docs, env) in ACP_AGENTS {
        providers.push(Arc::new(AcpProvider(ProviderDescriptor {
            id: (*id).into(),
            label: (*label).into(),
            description: (*description).into(),
            protocol: ProviderProtocol::Acp,
            binary: (*binary).into(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            fallback_args: fallback.iter().map(|arg| (*arg).to_owned()).collect(),
            env: env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            install_hint: (*install).into(),
            docs_url: (*docs).into(),
            preview: true,
        })));
    }
    if let Some(script) = fixture_script() {
        providers.push(Arc::new(AcpProvider(fixture_descriptor(script))));
    }
    providers
}

fn registry() -> &'static [Arc<dyn AgentProvider>] {
    static REGISTRY: OnceLock<Vec<Arc<dyn AgentProvider>>> = OnceLock::new();
    REGISTRY.get_or_init(build_registry)
}

pub(crate) fn find_provider(id: &str) -> Option<Arc<dyn AgentProvider>> {
    registry()
        .iter()
        .find(|provider| provider.descriptor().id == id)
        .cloned()
}

pub(crate) fn provider_statuses() -> Vec<ProviderStatus> {
    registry()
        .iter()
        .map(|provider| ProviderStatus {
            descriptor: provider.descriptor().clone(),
            installed: provider.detect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_providers_come_first() {
        let ids: Vec<String> = registry()
            .iter()
            .map(|provider| provider.descriptor().id.clone())
            .collect();
        assert_eq!(ids[0], "claude");
        assert_eq!(ids[1], "codex");
        assert!(ids.contains(&"gemini".to_string()));
        assert!(ids.contains(&"opencode".to_string()));
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<String> = registry()
            .iter()
            .map(|provider| provider.descriptor().id.clone())
            .collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn acp_agents_use_the_acp_protocol() {
        let gemini = find_provider("gemini").unwrap();
        assert_eq!(gemini.descriptor().protocol, ProviderProtocol::Acp);
        assert_eq!(gemini.descriptor().args, vec!["--acp".to_string()]);
        assert_eq!(
            gemini.descriptor().fallback_args,
            vec!["--experimental-acp".to_string()]
        );
        // O Claude nunca passa por adaptador ACP (contrato do agentes-ia.md).
        assert_eq!(
            find_provider("claude").unwrap().descriptor().protocol,
            ProviderProtocol::ClaudeStreamJson
        );
    }

    #[test]
    fn statuses_serialize_flat() {
        let status = ProviderStatus {
            descriptor: find_provider("codex").unwrap().descriptor().clone(),
            installed: false,
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["id"], "codex");
        assert_eq!(value["protocol"], "codex-app-server");
        assert_eq!(value["installed"], false);
        assert!(value["installHint"].as_str().unwrap().contains("codex"));
    }

    #[test]
    fn unknown_provider_is_none() {
        assert!(find_provider("nao-existe").is_none());
    }
}
